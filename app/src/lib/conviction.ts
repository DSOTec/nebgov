/** Calculate progress toward a conviction proposal's execution threshold. */
export function convictionProgressPercent(
  conviction: bigint,
  requiredThreshold: bigint | undefined,
): number {
  if (conviction <= 0n || !requiredThreshold || requiredThreshold <= 0n) return 0;
  return Math.min(100, Number((conviction * 10_000n) / requiredThreshold) / 100);
}
