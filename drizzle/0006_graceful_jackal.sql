-- Compatibility marker only.
--
-- Versions released before this migration already added these nullable
-- provenance columns through initializeDatabase(). SQLite does not support
-- ADD COLUMN IF NOT EXISTS, so replaying the generated ALTER TABLE statements
-- against those databases would fail. initializeDatabase() remains the
-- idempotent migration path for both legacy and fresh databases.
SELECT 1;
