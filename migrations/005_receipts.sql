-- Receipts arriving by e-mail (belege@in.dotiy.de): raw mail in R2, AI-extracted data, link to a bank transaction.
CREATE TABLE IF NOT EXISTS receipts (
  id           TEXT PRIMARY KEY,
  received_at  TEXT NOT NULL,
  mail_from    TEXT,
  subject      TEXT,
  raw_key      TEXT NOT NULL,              -- original .eml in R2 (never changed)
  status       TEXT NOT NULL DEFAULT 'new', -- new | matched | unmatched | ignored | error
  attempts     INTEGER NOT NULL DEFAULT 0,
  error        TEXT,
  vendor       TEXT,
  amount       REAL,
  currency     TEXT,
  doc_date     TEXT,
  doc_number   TEXT,
  category     TEXT,
  summary      TEXT,
  file_key     TEXT,                       -- the receipt document (PDF attachment or mail as HTML)
  file_name    TEXT,
  file_type    TEXT,
  tx_id        TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_receipts_status ON receipts(status);
