-- Links transfers and Loom links to customers, adds a phone number to customers.
ALTER TABLE deliveries ADD COLUMN customer_id TEXT;
CREATE INDEX IF NOT EXISTS idx_deliveries_customer ON deliveries(customer_id);

CREATE TABLE IF NOT EXISTS looms (
  id          TEXT PRIMARY KEY,
  customer_id TEXT,
  name        TEXT NOT NULL,
  video       TEXT NOT NULL,
  gif         TEXT,
  url         TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_looms_customer ON looms(customer_id);

ALTER TABLE customers ADD COLUMN phone TEXT;
