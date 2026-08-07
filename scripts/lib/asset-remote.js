// Asset remote: display textures on Cloudflare R2 behind assets.vale.cc.cd.
//
// Mirrors the shape of github-pack-remote: a factory function, a URL
// constructor, and object-name/path validators, with all URL encoding
// centralised here (pack names carry Minecraft colour codes, '#' and spaces -
// the proven failure point). Transport is the S3 API with SigV4 signing
// (region 'auto'), no SDK dependency.
//
// Uploads are idempotent: an object whose remote etag already matches the
// local content MD5 is skipped, so an interrupted run re-sends only what is
// missing and never creates duplicates (PUT to the same key overwrites).

const crypto = require('node:crypto');

const DEFAULT_PUBLIC_BASE = 'https://assets.vale.cc.cd';
const LOCAL_ASSET_BASE = '/thumbnails';
const EMPTY_PAYLOAD_SHA256 = crypto.createHash('sha256').update('').digest('hex');

const sha256Hex = data => crypto.createHash('sha256').update(data).digest('hex');
const md5Hex = data => crypto.createHash('md5').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const hmacHex = (key, data) => crypto.createHmac('sha256', key).update(data).digest('hex');

function assertAssetName(name) {
  const value = String(name || '');
  if (!value || value === '.' || value === '..' ||
      value.includes('/') || value.includes('\\') || /[\x00-\x1f]/.test(value)) {
    throw new Error(`Invalid asset name: ${JSON.stringify(value) || '(missing)'}`);
  }
  return value;
}

function buildObjectKey(pack, file) {
  return `${assertAssetName(pack)}/${assertAssetName(file)}`;
}

function encodeKey(key) {
  return key.split('/').map(encodeURIComponent).join('/');
}

function buildAssetUrl(publicBase, pack, file) {
  const base = String(publicBase || '').replace(/\/+$/, '');
  if (!base) throw new Error('Invalid asset public base: (missing)');
  return `${base}/${encodeKey(buildObjectKey(pack, file))}`;
}

// Per-pack asset base resolution for the site generators. Packs listed in the
// config's remote set are served from the object store; everything else falls
// back to the in-repo thumbnails directory (local development default).
function resolveAssetBase(config, packId) {
  const remote = config && config.remote;
  if (remote && typeof remote.base === 'string' && remote.base &&
      Array.isArray(remote.packs) && remote.packs.includes(packId)) {
    return remote.base.replace(/\/+$/, '');
  }
  return LOCAL_ASSET_BASE;
}

function createAssetRemote(options = {}) {
  const endpoint = String(options.endpoint || '').replace(/\/+$/, '');
  const bucket = String(options.bucket || '');
  const accessKeyId = String(options.accessKeyId || '');
  const secretAccessKey = String(options.secretAccessKey || '');
  const publicBaseUrl = options.publicBaseUrl || DEFAULT_PUBLIC_BASE;
  const fetchImpl = options.fetchImpl || fetch;
  if (!endpoint || !/^https?:\/\//.test(endpoint)) throw new Error(`Invalid asset endpoint: ${endpoint || '(missing)'}`);
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error(`Invalid asset bucket: ${bucket || '(missing)'}`);
  if (!accessKeyId || !secretAccessKey) throw new Error('Asset remote requires accessKeyId and secretAccessKey');

  function signedRequest(method, key, payloadHash, extraHeaders = {}) {
    const url = `${endpoint}/${bucket}/${encodeKey(key)}`;
    const host = new URL(url).host;
    const now = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const amzDate = now;
    const dateStamp = now.slice(0, 8);
    const signed = {
      ...extraHeaders,
      host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };
    const names = Object.keys(signed).sort();
    const canonicalHeaders = names.map(name => `${name}:${String(signed[name]).trim()}\n`).join('');
    const signedHeaders = names.join(';');
    const canonicalRequest = [
      method,
      `/${bucket}/${encodeKey(key)}`,
      '',
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');
    const scope = `${dateStamp}/auto/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), 'auto'), 's3'), 'aws4_request');
    const authorization =
      `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${hmacHex(signingKey, stringToSign)}`;
    // 'host' stays out of the fetch headers (forbidden header name); the
    // runtime sets it from the URL to the exact signed value.
    const headers = { ...extraHeaders, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate, authorization };
    return { url, headers };
  }

  async function request(method, key, payloadHash, extraHeaders, body) {
    const { url, headers } = signedRequest(method, key, payloadHash, extraHeaders);
    const response = await fetchImpl(url, { method, headers, ...(body ? { body } : {}) });
    if (!response.ok && response.status !== 404) {
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      throw new Error(`Asset remote ${method} failed (${response.status}) for ${key}: ${detail}`);
    }
    return response;
  }

  const bareEtag = value => String(value || '').replace(/"/g, '');

  async function headAsset(pack, file) {
    const key = buildObjectKey(pack, file);
    const response = await request('HEAD', key, EMPTY_PAYLOAD_SHA256, {});
    if (response.status === 404) return null;
    return {
      etag: bareEtag(response.headers.get('etag')),
      size: Number(response.headers.get('content-length')) || 0,
    };
  }

  async function uploadAsset({ pack, file, body, contentType = 'image/png' }) {
    const key = buildObjectKey(pack, file);
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const etag = md5Hex(buffer);
    const url = buildAssetUrl(publicBaseUrl, pack, file);
    const existing = await headAsset(pack, file);
    if (existing && existing.etag === etag) {
      return { uploaded: false, skipped: true, etag, url };
    }
    const response = await request('PUT', key, sha256Hex(buffer), { 'content-type': contentType }, buffer);
    const returned = bareEtag(response.headers.get('etag'));
    if (returned && returned !== etag) {
      throw new Error(`Asset upload etag mismatch: ${key} (local ${etag}, remote ${returned})`);
    }
    return { uploaded: true, etag, url };
  }

  function assetUrl(pack, file) {
    return buildAssetUrl(publicBaseUrl, pack, file);
  }

  function close() {}

  return {
    assetUrl,
    close,
    headAsset,
    uploadAsset,
  };
}

module.exports = {
  DEFAULT_PUBLIC_BASE,
  LOCAL_ASSET_BASE,
  assertAssetName,
  buildAssetUrl,
  buildObjectKey,
  createAssetRemote,
  resolveAssetBase,
};
