// Read individual entries out of a remote ZIP archive over HTTP range requests.
//
// The catalog's archives live in `Sakyvo/packs-NNN` (69GB in total). Backfilling one
// texture must not download an archive: the reader walks the end-of-central-directory
// record, fetches the central directory, then fetches only the local header and the
// compressed bytes of the entries it was asked for.

const zlib = require('zlib');

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
const TAIL_BYTES = 66_000;
const STORED = 0;
const DEFLATED = 8;

// A 3000-archive crawl meets throttling and transient failures; those are worth a
// bounded retry. Anything else (404, malformed record) is a real answer.
const MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 400;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
// `fetch` has no default deadline. A socket that is accepted and then left open would
// otherwise hold a crawl worker forever without ever reporting the archive as unreadable.
const DEFAULT_TIMEOUT_MS = 30_000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, init, timeoutMs, maxAttempts) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      // Keep the archive in the message: a crawl reports this reason per pack, and a bare
      // TimeoutError says nothing about which archive stalled.
      lastError = new Error(`remote archive request failed (${error.name === 'TimeoutError' ? `timeout ${timeoutMs}ms` : error.message}): ${url}`);
      if (attempt === maxAttempts) break;
      await sleep(RETRY_BASE_MS * attempt);
      continue;
    }
    if (response.ok || response.status === 206) return response;
    lastError = new Error(`remote archive request failed (${response.status}): ${url}`);
    if (!RETRYABLE_STATUS.has(response.status) || attempt === maxAttempts) break;
    const retryAfter = Number(response.headers.get('retry-after'));
    await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : RETRY_BASE_MS * attempt);
  }
  throw lastError;
}

// The body read is part of the same deadline, and its abort arrives from arrayBuffer()
// rather than from fetch(), so it has to be reported here to keep the archive in the reason.
async function request(url, start, end, timeoutMs, maxAttempts) {
  const response = await fetchWithRetry(url, start === undefined ? {} : { headers: { Range: `bytes=${start}-${end}` } }, timeoutMs, maxAttempts);
  try {
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    throw new Error(`remote archive response body failed (${error.name === 'TimeoutError' ? `timeout ${timeoutMs}ms` : error.message}): ${url}`);
  }
}

// raw.githubusercontent.com rejects suffix ranges (`bytes=-N`) with 501, so the tail
// is an explicit range and the archive size comes from a bodiless HEAD.
async function requestTotalSize(url, timeoutMs, maxAttempts) {
  const response = await fetchWithRetry(url, { method: 'HEAD' }, timeoutMs, maxAttempts);
  const total = Number(response.headers.get('content-length'));
  if (!Number.isInteger(total) || total <= 0) {
    throw new Error(`remote archive did not report its size: ${url}`);
  }
  return total;
}

function readEndOfCentralDirectory(tail) {
  for (let i = tail.length - EOCD_MIN_SIZE; i >= 0; i--) {
    if (tail.readUInt32LE(i) !== EOCD_SIGNATURE) continue;
    return {
      entryCount: tail.readUInt16LE(i + 10),
      directorySize: tail.readUInt32LE(i + 12),
      directoryOffset: tail.readUInt32LE(i + 16),
    };
  }
  throw new Error('remote archive has no end-of-central-directory record');
}

function parseCentralDirectory(buffer, wanted) {
  const found = new Map();
  let offset = 0;
  while (offset + 46 <= buffer.length && buffer.readUInt32LE(offset) === CENTRAL_SIGNATURE) {
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (wanted.has(name)) found.set(name, { method, compressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return found;
}

async function readLocalEntry(url, record, timeoutMs, maxAttempts) {
  const header = await request(url, record.localOffset, record.localOffset + 29, timeoutMs, maxAttempts);
  if (header.readUInt32LE(0) !== LOCAL_SIGNATURE) {
    throw new Error('remote archive local header does not match its central directory entry');
  }
  const nameLength = header.readUInt16LE(26);
  const extraLength = header.readUInt16LE(28);
  const dataStart = record.localOffset + 30 + nameLength + extraLength;
  const data = await request(url, dataStart, dataStart + record.compressedSize - 1, timeoutMs, maxAttempts);

  if (record.method === STORED) return data;
  if (record.method === DEFLATED) return zlib.inflateRawSync(data);
  throw new Error(`remote archive entry uses unsupported compression method ${record.method}`);
}

// Returns every requested name the archive carries, plus the ones it does not. The
// caller decides which of several names for the same texture to prefer.
async function readArchiveEntries(url, wantedNames, { timeoutMs = DEFAULT_TIMEOUT_MS, maxAttempts = MAX_ATTEMPTS } = {}) {
  const wanted = new Set(wantedNames);
  const total = await requestTotalSize(url, timeoutMs, maxAttempts);
  const tailStart = Math.max(0, total - TAIL_BYTES);
  const tail = await request(url, tailStart, total - 1, timeoutMs, maxAttempts);
  const directory = readEndOfCentralDirectory(tail);

  const inTail = directory.directoryOffset >= tailStart;
  const directoryBuffer = inTail
    ? tail.subarray(directory.directoryOffset - tailStart, directory.directoryOffset - tailStart + directory.directorySize)
    : await request(url, directory.directoryOffset, directory.directoryOffset + directory.directorySize - 1, timeoutMs, maxAttempts);

  const records = parseCentralDirectory(directoryBuffer, wanted);
  const entries = new Map();
  const missing = [];
  for (const name of wantedNames) {
    const record = records.get(name);
    if (!record) {
      missing.push(name);
      continue;
    }
    entries.set(name, await readLocalEntry(url, record, timeoutMs, maxAttempts));
  }
  return { entries, missing };
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  MAX_ATTEMPTS,
  readArchiveEntries,
};