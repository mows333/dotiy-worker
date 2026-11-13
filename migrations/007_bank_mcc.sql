-- Merchant category code of card payments (from the bank), basis for the category.
ALTER TABLE bank_tx ADD COLUMN mcc TEXT;
