import { createHash, randomUUID } from 'node:crypto';
import type { Db } from './connection.js';

export interface Account {
  id: string;
  displayName: string | null;
  createdAt: string;
  lastSeenAt: string;
}

export interface AccountIdentity {
  id: string;
  accountId: string;
  issuer: string;
  subject: string;
  email: string | null;
  emailVerified: boolean;
  providerName: string;
  createdAt: string;
}

export interface Session {
  id: string;
  accountId: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface AccountModeStats {
  accountId: string;
  modeId: string;
  highScore: number;
  longestStreak: number;
  gamesPlayed: number;
  totalScore: number;
  averageScore: number;
  updatedAt: string;
}

export interface AccountSaveSlot {
  accountId: string;
  modeId: string;
  revision: number;
  runId: string | null;
  save: unknown | null;
  updatedAt: string;
}

export interface SaveSlotWriteInput {
  modeId: string;
  expectedRevision: number;
  runId: string | null;
  save: unknown | null;
}

export type SaveSlotWriteResult =
  | { ok: true; slot: AccountSaveSlot }
  | { ok: false; current: AccountSaveSlot | null };

export interface PublicAccount {
  id: string;
  displayName: string | null;
}

export interface AuthenticatedSession {
  account: PublicAccount;
  session: Session;
}

export interface IdentityInput {
  issuer: string;
  subject: string;
  email: string | null;
  emailVerified: boolean;
  providerName: string;
  displayName: string | null;
}

export interface StatsInput {
  modeId: string;
  highScore: number;
  longestStreak: number;
  gamesPlayed: number;
  totalScore: number;
  averageScore: number;
}

export interface ScoreSubmissionInput {
  modeId: string;
  score: number;
  longestStreak: number;
  clientStats: StatsInput | null;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function toSqliteDateTime(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function boolFromSql(value: number): boolean {
  return value === 1;
}

function mapAccount(row: unknown): Account {
  const record = row as {
    id: string;
    display_name: string | null;
    created_at: string;
    last_seen_at: string;
  };
  return {
    id: record.id,
    displayName: record.display_name,
    createdAt: record.created_at,
    lastSeenAt: record.last_seen_at,
  };
}

function mapSession(row: unknown): Session {
  const record = row as {
    id: string;
    account_id: string;
    expires_at: string;
    revoked_at: string | null;
  };
  return {
    id: record.id,
    accountId: record.account_id,
    expiresAt: record.expires_at,
    revokedAt: record.revoked_at,
  };
}

function mapStats(row: unknown): AccountModeStats {
  const record = row as {
    account_id: string;
    mode_id: string;
    high_score: number;
    longest_streak: number;
    games_played: number;
    total_score: number;
    average_score: number;
    updated_at: string;
  };
  return {
    accountId: record.account_id,
    modeId: record.mode_id,
    highScore: record.high_score,
    longestStreak: record.longest_streak,
    gamesPlayed: record.games_played,
    totalScore: record.total_score,
    averageScore: record.average_score,
    updatedAt: record.updated_at,
  };
}

function mapSaveSlot(row: unknown): AccountSaveSlot {
  const record = row as {
    account_id: string;
    mode_id: string;
    revision: number;
    run_id: string | null;
    payload: string | null;
    updated_at: string;
  };
  return {
    accountId: record.account_id,
    modeId: record.mode_id,
    revision: record.revision,
    runId: record.run_id,
    save: record.payload === null ? null : JSON.parse(record.payload) as unknown,
    updatedAt: record.updated_at,
  };
}

export class Repositories {
  constructor(private readonly db: Db) {}

  findOrCreateAccountForIdentity(input: IdentityInput): PublicAccount {
    const existing = this.db.prepare(`
      SELECT accounts.*
      FROM account_identities
      JOIN accounts ON accounts.id = account_identities.account_id
      WHERE account_identities.issuer = ? AND account_identities.subject = ?
    `).get(input.issuer, input.subject);

    if (existing) {
      const account = mapAccount(existing);
      this.db.prepare(`
        UPDATE accounts
        SET display_name = COALESCE(?, display_name),
            last_seen_at = datetime('now')
        WHERE id = ?
      `).run(input.displayName, account.id);
      this.db.prepare(`
        UPDATE account_identities
        SET email = ?,
            email_verified = ?,
            provider_name = ?
        WHERE account_id = ? AND issuer = ? AND subject = ?
      `).run(
        input.email,
        input.emailVerified ? 1 : 0,
        input.providerName,
        account.id,
        input.issuer,
        input.subject,
      );
      return { id: account.id, displayName: input.displayName ?? account.displayName };
    }

    const accountId = randomUUID();
    const identityId = randomUUID();
    const create = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO accounts (id, display_name, created_at, last_seen_at)
        VALUES (?, ?, datetime('now'), datetime('now'))
      `).run(accountId, input.displayName);

      this.db.prepare(`
        INSERT INTO account_identities (
          id, account_id, issuer, subject, email, email_verified, provider_name, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(
        identityId,
        accountId,
        input.issuer,
        input.subject,
        input.email,
        input.emailVerified ? 1 : 0,
        input.providerName,
      );
    });
    create();

    return { id: accountId, displayName: input.displayName };
  }

  listIdentities(accountId: string): AccountIdentity[] {
    return this.db.prepare(`
      SELECT id, account_id, issuer, subject, email, email_verified, provider_name, created_at
      FROM account_identities
      WHERE account_id = ?
      ORDER BY created_at ASC
    `).all(accountId).map((row: unknown) => {
      const record = row as {
        id: string;
        account_id: string;
        issuer: string;
        subject: string;
        email: string | null;
        email_verified: number;
        provider_name: string;
        created_at: string;
      };
      return {
        id: record.id,
        accountId: record.account_id,
        issuer: record.issuer,
        subject: record.subject,
        email: record.email,
        emailVerified: boolFromSql(record.email_verified),
        providerName: record.provider_name,
        createdAt: record.created_at,
      };
    });
  }

  createSession(accountId: string, token: string, expiresAt: Date): Session {
    const id = randomUUID();
    const expiresAtValue = toSqliteDateTime(expiresAt);
    this.db.prepare(`
      INSERT INTO sessions (id, account_id, token_hash, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(id, accountId, hashToken(token), expiresAtValue);
    return { id, accountId, expiresAt: expiresAtValue, revokedAt: null };
  }

  findSessionByToken(token: string): AuthenticatedSession | null {
    const row = this.db.prepare(`
      SELECT
        sessions.id AS session_id,
        sessions.account_id,
        sessions.expires_at,
        sessions.revoked_at,
        accounts.display_name
      FROM sessions
      JOIN accounts ON accounts.id = sessions.account_id
      WHERE sessions.token_hash = ?
        AND sessions.revoked_at IS NULL
        AND sessions.expires_at > datetime('now')
    `).get(hashToken(token));

    if (!row) return null;
    const record = row as {
      session_id: string;
      account_id: string;
      expires_at: string;
      revoked_at: string | null;
      display_name: string | null;
    };
    return {
      account: { id: record.account_id, displayName: record.display_name },
      session: {
        id: record.session_id,
        accountId: record.account_id,
        expiresAt: record.expires_at,
        revokedAt: record.revoked_at,
      },
    };
  }

  revokeSession(token: string): void {
    this.db.prepare(`
      UPDATE sessions
      SET revoked_at = datetime('now')
      WHERE token_hash = ? AND revoked_at IS NULL
    `).run(hashToken(token));
  }

  deleteExpiredSessions(): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= datetime(\'now\')').run();
  }

  getStats(accountId: string): AccountModeStats[] {
    return this.db.prepare(`
      SELECT *
      FROM account_mode_stats
      WHERE account_id = ?
      ORDER BY mode_id ASC
    `).all(accountId).map(mapStats);
  }

  listSaveSlots(accountId: string): AccountSaveSlot[] {
    return this.db.prepare(`
      SELECT account_id, mode_id, revision, run_id, payload, updated_at
      FROM account_save_slots
      WHERE account_id = ?
      ORDER BY mode_id ASC
    `).all(accountId).map(mapSaveSlot);
  }

  writeSaveSlot(accountId: string, input: SaveSlotWriteInput): SaveSlotWriteResult {
    const write = this.db.transaction((): SaveSlotWriteResult => {
      const payload = input.save === null ? null : JSON.stringify(input.save);
      const result = input.expectedRevision === 0
        ? this.db.prepare(`
          INSERT INTO account_save_slots (
            account_id, mode_id, revision, run_id, payload, updated_at
          )
          VALUES (?, ?, 1, ?, ?, datetime('now'))
          ON CONFLICT(account_id, mode_id) DO NOTHING
        `).run(accountId, input.modeId, input.runId, payload)
        : this.db.prepare(`
          UPDATE account_save_slots
          SET revision = revision + 1,
              run_id = ?,
              payload = ?,
              updated_at = datetime('now')
          WHERE account_id = ? AND mode_id = ? AND revision = ?
        `).run(input.runId, payload, accountId, input.modeId, input.expectedRevision);

      if (result.changes === 0) {
        const current = this.db.prepare(`
          SELECT account_id, mode_id, revision, run_id, payload, updated_at
          FROM account_save_slots
          WHERE account_id = ? AND mode_id = ?
        `).get(accountId, input.modeId);
        return { ok: false, current: current ? mapSaveSlot(current) : null };
      }

      const saved = this.db.prepare(`
        SELECT account_id, mode_id, revision, run_id, payload, updated_at
        FROM account_save_slots
        WHERE account_id = ? AND mode_id = ?
      `).get(accountId, input.modeId);
      return { ok: true, slot: mapSaveSlot(saved) };
    });

    return write();
  }

  upsertStats(accountId: string, input: StatsInput): AccountModeStats {
    const averageScore = input.gamesPlayed > 0 ? Math.round(input.totalScore / input.gamesPlayed) : 0;
    this.db.prepare(`
      INSERT INTO account_mode_stats (
        account_id, mode_id, high_score, longest_streak, games_played, total_score, average_score, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(account_id, mode_id) DO UPDATE SET
        high_score = excluded.high_score,
        longest_streak = excluded.longest_streak,
        games_played = excluded.games_played,
        total_score = excluded.total_score,
        average_score = excluded.average_score,
        updated_at = datetime('now')
    `).run(
      accountId,
      input.modeId,
      input.highScore,
      input.longestStreak,
      input.gamesPlayed,
      input.totalScore,
      averageScore,
    );

    const saved = this.db.prepare(`
      SELECT *
      FROM account_mode_stats
      WHERE account_id = ? AND mode_id = ?
    `).get(accountId, input.modeId);
    return mapStats(saved);
  }

  submitScore(accountId: string, input: ScoreSubmissionInput): AccountModeStats {
    const submit = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO score_submissions (
          id, account_id, mode_id, score, longest_streak, client_stats, accepted
        )
        VALUES (?, ?, ?, ?, ?, ?, 1)
      `).run(
        randomUUID(),
        accountId,
        input.modeId,
        input.score,
        input.longestStreak,
        input.clientStats ? JSON.stringify(input.clientStats) : null,
      );

      const current = this.db.prepare(`
        SELECT *
        FROM account_mode_stats
        WHERE account_id = ? AND mode_id = ?
      `).get(accountId, input.modeId);

      const currentStats = current ? mapStats(current) : {
        accountId,
        modeId: input.modeId,
        highScore: 0,
        longestStreak: 0,
        gamesPlayed: 0,
        totalScore: 0,
        averageScore: 0,
        updatedAt: new Date().toISOString(),
      };

      const next: StatsInput = input.clientStats ?? {
        modeId: input.modeId,
        highScore: Math.max(currentStats.highScore, input.score),
        longestStreak: Math.max(currentStats.longestStreak, input.longestStreak),
        gamesPlayed: currentStats.gamesPlayed + 1,
        totalScore: currentStats.totalScore + input.score,
        averageScore: 0,
      };

      return this.upsertStats(accountId, {
        ...next,
        highScore: Math.max(next.highScore, input.score, currentStats.highScore),
        longestStreak: Math.max(next.longestStreak, input.longestStreak, currentStats.longestStreak),
      });
    });

    return submit();
  }

  leaderboard(modeId: string, limit: number): Array<{
    accountId: string;
    displayName: string | null;
    highScore: number;
    longestStreak: number;
    gamesPlayed: number;
    updatedAt: string;
  }> {
    return this.db.prepare(`
      SELECT
        account_mode_stats.account_id,
        accounts.display_name,
        account_mode_stats.high_score,
        account_mode_stats.longest_streak,
        account_mode_stats.games_played,
        account_mode_stats.updated_at
      FROM account_mode_stats
      JOIN accounts ON accounts.id = account_mode_stats.account_id
      WHERE account_mode_stats.mode_id = ? AND account_mode_stats.games_played > 0
      ORDER BY account_mode_stats.high_score DESC, account_mode_stats.updated_at ASC
      LIMIT ?
    `).all(modeId, limit).map((row: unknown) => {
      const record = row as {
        account_id: string;
        display_name: string | null;
        high_score: number;
        longest_streak: number;
        games_played: number;
        updated_at: string;
      };
      return {
        accountId: record.account_id,
        displayName: record.display_name,
        highScore: record.high_score,
        longestStreak: record.longest_streak,
        gamesPlayed: record.games_played,
        updatedAt: record.updated_at,
      };
    });
  }
}
