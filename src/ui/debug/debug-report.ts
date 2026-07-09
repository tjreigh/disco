import type { TurnResult } from '../../game/engine.js';
import type { GameState } from '../../game/state.js';

export interface DebugFlag {
  target: string;
  label: string;
}

export interface DebugReport {
  schemaVersion: 4;
  exportedAt: string;
  note: string;
  flags: DebugFlag[];
  gameState: GameState;
  turnHistory: TurnResult[];
  truncatedTurns: number;
  lastTurn: TurnResult | null;
}

function snapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function buildDebugReport(
  state: GameState,
  turnHistory: readonly TurnResult[],
  truncatedTurns: number,
  note: string,
  flags: ReadonlyMap<string, string>,
  exportedAt = new Date().toISOString(),
): DebugReport {
  const historySnapshot = snapshot([...turnHistory]);
  return {
    schemaVersion: 4,
    exportedAt,
    note: note.trim(),
    flags: [...flags].map(([target, label]) => ({ target, label })),
    gameState: snapshot(state),
    turnHistory: historySnapshot,
    truncatedTurns,
    lastTurn: historySnapshot.at(-1) ?? null,
  };
}
