CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  display_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE account_identities (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  email TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0,
  provider_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (issuer, subject)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE account_mode_stats (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  mode_id TEXT NOT NULL,
  high_score INTEGER NOT NULL DEFAULT 0 CHECK (high_score >= 0),
  longest_streak INTEGER NOT NULL DEFAULT 0 CHECK (longest_streak >= 0),
  games_played INTEGER NOT NULL DEFAULT 0 CHECK (games_played >= 0),
  total_score INTEGER NOT NULL DEFAULT 0 CHECK (total_score >= 0),
  average_score INTEGER NOT NULL DEFAULT 0 CHECK (average_score >= 0),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_id, mode_id)
);

CREATE TABLE score_submissions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  mode_id TEXT NOT NULL,
  score INTEGER NOT NULL CHECK (score >= 0),
  longest_streak INTEGER NOT NULL DEFAULT 0 CHECK (longest_streak >= 0),
  client_stats TEXT,
  accepted INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_sessions_token_hash ON sessions(token_hash);
CREATE INDEX idx_sessions_account_id ON sessions(account_id);
CREATE INDEX idx_account_identities_account_id ON account_identities(account_id);
CREATE INDEX idx_score_submissions_mode_score ON score_submissions(mode_id, score DESC);
CREATE INDEX idx_account_mode_stats_mode_score ON account_mode_stats(mode_id, high_score DESC);
