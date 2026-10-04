CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
  id         TEXT PRIMARY KEY,
  number     TEXT UNIQUE,
  name       TEXT NOT NULL,
  contact    TEXT,
  email      TEXT,
  street     TEXT,
  street2    TEXT,
  zip        TEXT,
  city       TEXT,
  country    TEXT NOT NULL DEFAULT 'DE',
  vat_id     TEXT,
  buyer_ref  TEXT,
  notes      TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- data holds the full invoice snapshot (incl. customer copy) and is frozen once finalized
CREATE TABLE IF NOT EXISTS invoices (
  id          TEXT PRIMARY KEY,
  number      TEXT UNIQUE,
  type        TEXT NOT NULL DEFAULT 'invoice',
  status      TEXT NOT NULL DEFAULT 'draft',
  customer_id TEXT,
  data        TEXT NOT NULL,
  total       REAL NOT NULL DEFAULT 0,
  issue_date  TEXT,
  due_date    TEXT,
  pdf_key     TEXT,
  finalized_at TEXT,
  sent_at     TEXT,
  sent_to     TEXT,
  paid_at     TEXT,
  related_id  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_id);

CREATE TABLE IF NOT EXISTS invoice_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id TEXT NOT NULL,
  at         TEXT NOT NULL,
  type       TEXT NOT NULL,
  detail     TEXT
);
