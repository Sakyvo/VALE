# Keep pack normalization self-contained in VALE

VALE will implement a CommonJS normalizer that follows an explicitly versioned snapshot of Plot's semantics instead of invoking Plot's Rust engine or executable. This keeps ingestion reproducible from the VALE repository and testable without a sibling checkout or machine-specific binary; parity fixtures and deliberate normalization schema upgrades make later Plot changes explicit.
