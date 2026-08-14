/**
 * The absolute-LP scale and the date helpers that go with it.
 *
 * Lives here rather than beside the chart that first needed it because the
 * dashboard's account cards need the same maths, and importing them from
 * `lp-climb-chart.component` would drag `ng-apexcharts` into the dashboard
 * bundle for the sake of two pure functions.
 *
 * Mirrors `computeAbsoluteLp` in apps/electron/database.js — 400 LP per tier,
 * 100 per division. Keep the two in step; the database stores what this reads.
 */

const DIVISIONS = ['IV', 'III', 'II', 'I'];

const TIER_ORDER = [
  { name: 'IRON', min: 0 },
  { name: 'BRONZE', min: 400 },
  { name: 'SILVER', min: 800 },
  { name: 'GOLD', min: 1200 },
  { name: 'PLATINUM', min: 1600 },
  { name: 'EMERALD', min: 2000 },
  { name: 'DIAMOND', min: 2400 },
  { name: 'MASTER', min: 2800 },
];

const DAY_MS = 86_400_000;

/**
 * Absolute LP back to a readable rank label.
 *
 * Master and above have no divisions, so LP simply counts up from the Master
 * floor rather than being split into four.
 */
export function absoluteLpToLabel(absolute: number): string {
  for (let i = TIER_ORDER.length - 1; i >= 0; i--) {
    const tier = TIER_ORDER[i];
    if (absolute >= tier.min) {
      if (tier.name === 'MASTER') return `Master ${absolute - tier.min} LP`;
      const within = absolute - tier.min;
      const division = DIVISIONS[Math.min(Math.floor(within / 100), 3)];
      return `${titleCase(tier.name)} ${division} ${within % 100} LP`;
    }
  }
  return `${absolute} LP`;
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

/** "Today", "Yesterday", or "N days ago". */
export function daysAgoLabel(timestamp: number): string {
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(new Date()) - startOfDay(new Date(timestamp))) / DAY_MS);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return `${days} days ago`;
}

/**
 * 'YYYY-MM-DD' to a local-midnight timestamp.
 *
 * `new Date('2026-08-06')` is parsed as *UTC* midnight, which renders as the
 * 5th anywhere west of Greenwich — every point would be labelled a day early.
 * Rows are keyed on the local day, so they have to be read back as one.
 */
export function dayToLocalTime(day: string): number {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year, month - 1, date).getTime();
}
