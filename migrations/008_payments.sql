-- Partial payments on invoices (entered by hand).
CREATE TABLE IF NOT EXISTS payments (
  id         TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL,
  amount     REAL NOT NULL,
  date       TEXT NOT NULL,
  note       TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);
