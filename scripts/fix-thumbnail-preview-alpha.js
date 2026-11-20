const fs = require('fs');
const path = require('path');
const {
  PREVIEW_TEXTURE_FILES,
  sanitizeTextureFileInPlace,
  generateCoverFromOutputDir,
} = require('./thumbnail-preview-utils');

const THUMB_DIR = path.join(__dirname, '..', 'thumbnails');

// Rebuilds every pack's cover from its local masters, and by default also strips the
// low-alpha halos out of the textures the previews display. --covers-only skips the
// texture pass when only the cover contract changed.
async function main(argv = process.argv.slice(2)) {
  const coversOnly = argv.includes('--covers-only');
  const dirs = fs.readdirSync(THUMB_DIR).filter(name => {
    const full = path.join(THUMB_DIR, name);
    return fs.statSync(full).isDirectory();
  });

  let changedFiles = 0;
  let rebuiltCovers = 0;
  const failures = [];

  for (const dir of dirs) {
    const packDir = path.join(THUMB_DIR, dir);

    if (!coversOnly) {
      for (const filename of PREVIEW_TEXTURE_FILES) {
        const filePath = path.join(packDir, filename);
        if (!fs.existsSync(filePath)) continue;
        if (await sanitizeTextureFileInPlace(filePath)) changedFiles++;
      }
    }

    // One unreadable master must not end a 3000-pack rebuild; report it and go on.
    try {
      await generateCoverFromOutputDir(packDir);
      rebuiltCovers++;
    } catch (error) {
      failures.push({ pack: dir, reason: error.message });
    }
  }

  for (const failure of failures) console.log(`  cover failed ${failure.pack}: ${failure.reason}`);
  console.log(`Preview alpha cleanup done. Files changed: ${changedFiles}, covers rebuilt: ${rebuiltCovers}, failed: ${failures.length}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
