import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NgApexchartsModule } from 'ng-apexcharts';
import { RankSnapshot } from '../../../../types/electron';
import { ChartThemeService } from '../services/chart-theme.service';
import { EmptyStateComponent } from './empty-state.component';

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

/**
 * Converts the stored absolute LP scale back to a readable rank label.
 * Mirrors `computeAbsoluteLp` in apps/electron/database.js (400 LP per tier,
 * 100 per division). Master+ has no divisions, so LP counts up from 2800.
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
  const days = Math.round((startOfDay(new Date()) - startOfDay(new Date(timestamp))) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return `${days} days ago`;
}

/**
 * 'YYYY-MM-DD' to a local-midnight timestamp.
 *
 * `new Date('2026-08-06')` is parsed as *UTC* midnight, which renders as the
 * 5th anywhere west of Greenwich — the chart would label every point a day
 * early. Rows are keyed on the local day, so they have to be read back as one.
 */
export function dayToLocalTime(day: string): number {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year, month - 1, date).getTime();
}

/**
 * Rank progression over time.
 *
 * Reads the daily series, so there is exactly one point per day the account was
 * recorded, and the tooltip can report what that day actually was: the rank it
 * ended on, how many games were played, and the LP swing. Still not per-match
 * precision — Riot publishes no LP history, so a day is the finest grain that
 * can be recorded honestly.
 *
 * Days with no games have no row. The line is drawn straight between recorded
 * days rather than interpolated, so an inactive stretch reads as flat instead
 * of as a slow climb that never happened.
 */
@Component({
  selector: 'app-lp-climb-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, NgApexchartsModule, EmptyStateComponent],
  template: `
    @if (snapshots().length >= 2) {
      <apx-chart
        [series]="series()"
        [chart]="options().chart"
        [stroke]="options().stroke"
        [fill]="options().fill"
        [colors]="options().colors"
        [xaxis]="options().xaxis"
        [yaxis]="options().yaxis"
        [tooltip]="options().tooltip"
        [grid]="options().grid"
        [theme]="options().theme"
        [markers]="options().markers"
        [dataLabels]="options().dataLabels"
      />
    } @else {
      <app-empty-state
        inline
        icon="chart-line"
        title="Not enough rank history yet"
        [hint]="emptyHint()"
      />
    }
  `,
  styles: [
    `
      :host {
        display: block;
        min-height: 120px;
      }
    `,
  ],
})
export class LpClimbChartComponent {
  private chartTheme = inject(ChartThemeService);

  snapshots = input.required<RankSnapshot[]>();
  height = input<number>(210);

  readonly emptyHint = computed(() =>
    this.snapshots().length === 1
      ? 'Only one day recorded so far. The graph appears once a second day is on record.'
      : 'Rank is recorded while LoL Vault is open. Riot publishes no rank history, so this can only show days recorded from here on.'
  );

  readonly series = computed(() => [
    {
      name: 'Rank',
      data: this.snapshots().map((s) => ({ x: dayToLocalTime(s.day), y: s.score })),
    },
  ]);

  readonly options = computed(() => {
    // Depend on the theme revision so colours refresh when the theme changes.
    this.chartTheme.revision();
    const base = this.chartTheme.baseOptions(this.height());
    const palette = this.chartTheme.palette();
    const snaps = this.snapshots();

    return {
      ...base,
      chart: { ...base.chart, type: 'area' as const },
      colors: [palette.gold],
      // Stepped, never sloped. A straight segment between two readings two
      // months apart draws a steady climb across a gap where nothing was
      // recorded and the rank may not have moved at all. Stepping holds the
      // last known value until the next real reading, which is the only thing
      // actually known — and it is what a day of dense readings looks like
      // anyway, since LP moves in discrete jumps rather than continuously.
      stroke: { curve: 'stepline' as const, width: 2 },
      fill: {
        type: 'gradient' as const,
        gradient: { shadeIntensity: 1, opacityFrom: 0.28, opacityTo: 0.02, stops: [0, 100] },
      },
      // Mark real samples while the series is short, so a sparse history reads
      // as "four readings" rather than as a continuous recording. Past ~60
      // points the dots stop being informative and start being noise.
      markers: { size: snaps.length <= 60 ? 3 : 0, hover: { size: 5 } },
      dataLabels: { enabled: false },
      xaxis: {
        type: 'datetime' as const,
        labels: { style: this.chartTheme.axisLabelStyle(), datetimeUTC: false },
        axisBorder: { show: false },
        axisTicks: { color: palette.border },
        tooltip: { enabled: false },
      },
      yaxis: {
        labels: {
          style: this.chartTheme.axisLabelStyle(),
          formatter: (val: number) => absoluteLpToLabel(Math.round(val)).replace(/ \d+ LP$/, ''),
        },
      },
      tooltip: {
        ...base.tooltip,
        // Rank the day ended on, plus what it took to get there. The games and
        // LP swing are the reason the series is stored per day rather than per
        // reading — without them a flat day is indistinguishable from an
        // unplayed one.
        custom: ({ dataPointIndex }: { dataPointIndex: number }) => {
          const snap = snaps[dataPointIndex];
          if (!snap) return '';

          const time = dayToLocalTime(snap.day);
          const dateStr = new Date(time).toLocaleDateString(undefined, {
            weekday: 'short',
            day: 'numeric',
            month: 'short',
          });

          const sign = snap.difference > 0 ? '+' : '';
          const trend = snap.difference > 0 ? 'up' : snap.difference < 0 ? 'down' : 'flat';
          const games = snap.games === 1 ? '1 game' : `${snap.games} games`;

          return `
            <div class="lp-tip">
              <div class="lp-tip-rank">${absoluteLpToLabel(snap.score)}</div>
              ${
                snap.games > 0 || snap.difference !== 0
                  ? `<div class="lp-tip-delta ${trend}">${sign}${snap.difference} LP · ${games}</div>`
                  : ''
              }
              <div class="lp-tip-when">${daysAgoLabel(time)}</div>
              <div class="lp-tip-date">${dateStr}</div>
            </div>`;
        },
      },
    };
  });
}
