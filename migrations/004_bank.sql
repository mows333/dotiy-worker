-- Bank sync via Enable Banking (PSD2): linked accounts, booked transactions, categorisation rules.
CREATE TABLE IF NOT EXISTS bank_accounts (
  uid          TEXT PRIMARY KEY,           -- Enable Banking account uid
  session_id   TEXT NOT NULL,
  aspsp        TEXT,                       -- bank name, e.g. Revolut
  iban         TEXT,
  name         TEXT,
  currency     TEXT,
  balance      REAL,
  valid_until  TEXT,                       -- consent end, reconnect afterwards
  last_sync    TEXT,
  last_error   TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bank_tx (
  id            TEXT PRIMARY KEY,          -- account uid + entry reference (or content hash)
  account_uid   TEXT NOT NULL,
  booking_date  TEXT NOT NULL,
  amount        REAL NOT NULL,             -- signed: negative = money out
  currency      TEXT NOT NULL,
  counterparty  TEXT,
  purpose       TEXT,
  kind          TEXT NOT NULL DEFAULT 'open',   -- open | business | private | income | transfer
  category      TEXT,
  invoice_id    TEXT,                      -- matched outgoing invoice (incoming payment)
  receipt_key   TEXT,                      -- receipt file in R2
  receipt_name  TEXT,
  note          TEXT,
  rule_id       TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bank_tx_date ON bank_tx(booking_date);
CREATE INDEX IF NOT EXISTS idx_bank_tx_kind ON bank_tx(kind);

CREATE TABLE IF NOT EXISTS bank_rules (
  id          TEXT PRIMARY KEY,
  match       TEXT NOT NULL,               -- lowercased text found in counterparty/purpose
  direction   TEXT NOT NULL,               -- in | out
  kind        TEXT NOT NULL,
  category    TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bank_state (
  key    TEXT PRIMARY KEY,                 -- jwt cache, pending auth states
  value  TEXT NOT NULL,
  expires_at TEXT
);
