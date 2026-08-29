import { describe, expect, it } from 'vitest';
import { buildDebugReport } from '../../ui/debug/debug-report.js';
import type { TurnResult } from '../../game/engine.js';
import { DiscKind } from '../../game/model.js';
import type { GameState } from '../../game/state.js';
import { GamePhase } from '../../game/state.js';
import { MAX_TURN_HISTORY, resolveDebugPanelAccess, snapshotTurnHistory } from '../../ui/debug/debug-panel.js';

const REMOTE_HOSTNAME = 'remote-host.test';

function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() { return items.size; },
    clear: () => items.clear(),
    getItem: (key: string) => items.get(key) ?? null,
    key: (index: number) => Array.from(items.keys())[index] ?? null,
    removeItem: (key: string) => { items.delete(key); },
    setItem: (key: string, value: string) => { items.set(key, value); },
  };
}

describe('buildDebugReport', () => {
  it('exports a stable snapshot with notes and labeled flags', () => {
    const state: GameState = {
      generationSeed: 1234,
      generationSource: 'seeded',
      phase: GamePhase.WaitingForDrop,
      board: [[{ id: 1, value: 2, kind: DiscKind.Numbered }]],
      currentDisc: { id: 2, value: 3, kind: DiscKind.Numbered },
      nextDisc: { id: 3, value: 4, kind: DiscKind.Numbered },
      cursorCol: 0,
      score: 10,
      dropCount: 2,
      level: 1,
      turnsPerLevel: 30,
      turnsRemaining: 20,
      breaksThisLevel: 0,
      entropy: 0,
      balancedLevels: 0,
    };

    const firstTurn: TurnResult = {
      accepted: false,
      reason: 'invalid-column',
      boardBefore: [[null]],
      steps: [],
      scoreAwarded: 0,
      stackSize: 0,
      gameOver: false,
      trace: { scans: [], frames: [] },
    };
    const secondTurn: TurnResult = {
      accepted: false,
      reason: 'full-column',
      boardBefore: [[{ id: 1, value: 2, kind: DiscKind.Numbered }]],
      steps: [],
      scoreAwarded: 0,
      stackSize: 0,
      gameOver: true,
      trace: { scans: [], frames: [] },
    };
    const history = [firstTurn, secondTurn];

    const report = buildDebugReport(
      state,
      history,
      0,
      '  This tile should clear.  ',
      new Map([['committed-board.cell.0.0', 'committed-board r1c1 #1']]),
      '2026-07-02T12:00:00.000Z',
    );

    state.board[0]![0]!.value = 6;
    secondTurn.boardBefore[0]![0]!.value = 5;
    history.length = 0;
    expect(report).toMatchObject({
      schemaVersion: 4,
      exportedAt: '2026-07-02T12:00:00.000Z',
      note: 'This tile should clear.',
      flags: [{ target: 'committed-board.cell.0.0', label: 'committed-board r1c1 #1' }],
      turnHistory: [
        { reason: 'invalid-column' },
        { reason: 'full-column' },
      ],
      truncatedTurns: 0,
      lastTurn: { reason: 'full-column' },
    });
    expect(report.gameState.board[0]![0]!.value).toBe(2);
    expect(report.turnHistory[1]!.boardBefore[0]![0]!.value).toBe(2);
  });

  it('retains only the most recent 50 turns and tracks omissions', () => {
    const state: GameState = {
      generationSeed: 99,
      generationSource: 'seeded',
      phase: GamePhase.WaitingForDrop,
      board: [[null]],
      currentDisc: { id: 1, value: 1, kind: DiscKind.Numbered },
      nextDisc: { id: 2, value: 2, kind: DiscKind.Numbered },
      cursorCol: 0,
      score: 0,
      dropCount: 0,
      level: 1,
      turnsPerLevel: 10,
      turnsRemaining: 10,
      breaksThisLevel: 0,
      entropy: 0,
      balancedLevels: 0,
    };

    const history = Array.from({ length: 60 }, (_, index): TurnResult => ({
      accepted: true,
      boardBefore: [[null]],
      steps: [],
      scoreAwarded: 0,
      stackSize: 0,
      gameOver: false,
      trace: { scans: [], frames: [] },
    }));

    let turnHistory: TurnResult[] = [];
    let truncatedTurns = 0;
    for (const turn of history) {
      const next = snapshotTurnHistory(turnHistory, turn);
      turnHistory = next.turnHistory;
      truncatedTurns += next.truncatedTurns;
    }

    const report = buildDebugReport(state, turnHistory, truncatedTurns, '', new Map(), '2026-07-02T12:00:00.000Z');

    expect(report.schemaVersion).toBe(4);
    expect(turnHistory).toHaveLength(MAX_TURN_HISTORY);
    expect(report.turnHistory).toHaveLength(MAX_TURN_HISTORY);
    expect(report.truncatedTurns).toBe(10);
    expect(report.turnHistory[0]!.boardBefore[0]![0]).toBeNull();
    expect(report.lastTurn).toBe(report.turnHistory[MAX_TURN_HISTORY - 1]);
  });
});

describe('resolveDebugPanelAccess', () => {
  it('allows the full logic debugger on local hosts', () => {
    expect(resolveDebugPanelAccess({ hostname: 'localhost', search: '' }, memoryStorage())).toBe('full');
    expect(resolveDebugPanelAccess({ hostname: '127.0.0.1', search: '' }, memoryStorage())).toBe('full');
  });

  it('defaults remote players to report-only access', () => {
    expect(resolveDebugPanelAccess({ hostname: REMOTE_HOSTNAME, search: '' }, memoryStorage())).toBe('report');
  });

  it('lets the owner gate enable and clear full access on remote hosts', () => {
    const storage = memoryStorage();

    expect(resolveDebugPanelAccess({ hostname: REMOTE_HOSTNAME, search: '?debug=logic' }, storage)).toBe('full');
    expect(resolveDebugPanelAccess({ hostname: REMOTE_HOSTNAME, search: '' }, storage)).toBe('full');
    expect(resolveDebugPanelAccess({ hostname: REMOTE_HOSTNAME, search: '?debug=report' }, storage)).toBe('report');
    expect(resolveDebugPanelAccess({ hostname: REMOTE_HOSTNAME, search: '' }, storage)).toBe('report');
  });
});
