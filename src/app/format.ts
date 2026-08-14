/** "2" for a whole number, "2.50" otherwise — chain-multiplier score-indicator text shared by LocalBoardSession and SharedBoardGame. */
export function formatMultiplier(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
