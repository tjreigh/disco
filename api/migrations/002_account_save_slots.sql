CREATE TABLE account_save_slots (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  mode_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  run_id TEXT,
  payload TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_id, mode_id),
  CHECK (
    (run_id IS NULL AND payload IS NULL)
    OR (run_id IS NOT NULL AND payload IS NOT NULL)
  )
);

CREATE INDEX idx_account_save_slots_account_id
  ON account_save_slots(account_id);
