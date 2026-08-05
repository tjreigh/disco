/** Points awarded per cleared disc at a one-based chain length. */
export function pointsForChain(
  chainLength: number,
  pointsPerDisc = 7,
  exponent = 2.5,
): number {
  if (!Number.isInteger(chainLength) || chainLength < 1) return 0;
  return Math.floor(pointsPerDisc * Math.pow(chainLength, exponent));
}

/** Points awarded for a completed Stack-mode cascade. */
export function pointsForStack(stackSize: number, pointsPerStackUnit: number): number {
  if (!Number.isInteger(stackSize) || stackSize < 1) return 0;
  return pointsPerStackUnit * stackSize * stackSize;
}
