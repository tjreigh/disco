ALTER TABLE account_mode_stats
  ADD COLUMN total_play_time_ms INTEGER NOT NULL DEFAULT 0 CHECK (total_play_time_ms >= 0);

ALTER TABLE account_mode_stats
  ADD COLUMN total_discs_dropped INTEGER NOT NULL DEFAULT 0 CHECK (total_discs_dropped >= 0);

ALTER TABLE account_mode_stats
  ADD COLUMN total_discs_broken INTEGER NOT NULL DEFAULT 0 CHECK (total_discs_broken >= 0);
