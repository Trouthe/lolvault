import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NgApexchartsModule } from 'ng-apexcharts';
import { LpSnapshot } from '../../../../types/electron';
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
 * LP progression over time.
 *
 * Snapshots are wall-clock samples taken while the app is running (see
 * lcu-monitor.js), not per-match records — so this shows the shape of a climb,
 * and the tooltip reports the snapshot's own date/rank/LP rather than implying
 * per-game precision.
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
        title="Not enough LP history yet"
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

  snapshots = input.required<LpSnapshot[]>();
  height = input<number>(210);

  readonly emptyHint = computed(() =>
    this.snapshots().length === 1
      ? 'Only one LP reading so far. The climb graph appears once a second snapshot is recorded.'
      : 'LP is recorded while LoL Vault is running during your games. Play a ranked game with the app open to start tracking.'
  );

  readonly series = computed(() => [
    {
      name: 'LP',
      data: this.snapshots().map((s) => ({ x: s.timestamp, y: s.absolute_lp })),
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
      stroke: { curve: 'straight' as const, width: 2 },
      fill: {
        type: 'gradient' as const,
        gradient: { shadeIntensity: 1, opacityFrom: 0.28, opacityTo: 0.02, stops: [0, 100] },
      },
      markers: { size: 0, hover: { size: 5 } },
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
        // Custom tooltip: rank, LP and how long ago — what the spec asked for.
        custom: ({ dataPointIndex }: { dataPointIndex: number }) => {
          const snap = snaps[dataPointIndex];
          if (!snap) return '';
          const date = new Date(snap.timestamp);
          const dateStr = date.toLocaleDateString(undefined, {
            weekday: 'short',
            day: 'numeric',
            month: 'short',
          });
          const timeStr = date.toLocaleTimeString(undefined, {
            hour: '2-digit',
            minute: '2-digit',
          });
          return `
            <div class="lp-tip">
              <div class="lp-tip-rank">${absoluteLpToLabel(snap.absolute_lp)}</div>
              <div class="lp-tip-when">${daysAgoLabel(snap.timestamp)}</div>
              <div class="lp-tip-date">${dateStr} · ${timeStr}</div>
            </div>`;
        },
      },
    };
  });
}
