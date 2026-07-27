function rejectLegacyMigration() {
  const error = new Error(
    'Legacy direct archive migration is retired. Use scripts/upload-folder.js so every archive passes normalized ingestion.'
  );
  error.code = 'legacy_archive_writer_retired';
  throw error;
}

if (require.main === module) {
  try {
    rejectLegacyMigration();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { rejectLegacyMigration };
