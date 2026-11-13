-- Marks transactions the AI has already looked at (so uncertain ones are not sent again on every sync).
ALTER TABLE bank_tx ADD COLUMN ai_checked TEXT;
