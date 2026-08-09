/**
 * Shared "how good is this number" scale.
 *
 * Every stat readout in analytics colours off these two helpers so the same
 * value never reads green in one panel and neutral in the next. The tone names
 * map onto the `--tone-*` custom properties declared in `styles.scss`.
 */
export type PerfTone = 'gold' | 'good' | 'bad' | 'neutral';

/**
 * Win-rate tone. Gold above 80% — at that point the sample is either tiny or
 * genuinely exceptional, and either way it deserves to stand apart from the
 * ordinary "winning" green.
 */
export function winRateTone(winRate: number, games = 1): PerfTone {
  if (!games) return 'neutral';
  if (winRate >= 80) return 'gold';
  return winRate >= 50 ? 'good' : 'bad';
}

/**
 * KDA tone on the same bands the overview KDA panel already uses (3.0 is the
 * "good game" line), with a gold tier at 5.0 to mirror the win-rate scale.
 */
export function kdaTone(kda: number, games = 1): PerfTone {
  if (!games) return 'neutral';
  if (kda >= 5) return 'gold';
  if (kda >= 3) return 'good';
  if (kda < 2) return 'bad';
  return 'neutral';
}
