CREATE TABLE IF NOT EXISTS deliveries (
  id            TEXT PRIMARY KEY,
  token         TEXT UNIQUE NOT NULL,
  client_name   TEXT NOT NULL,
  client_email  TEXT NOT NULL,
  files         TEXT NOT NULL,
  password_hash TEXT,
  message       TEXT,
  expires_at    TEXT NOT NULL,
  download_count INTEGER DEFAULT 0,
  created_at    TEXT NOT NULL
);
