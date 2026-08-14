import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NgApexchartsModule } from 'ng-apexcharts';
import { RankSnapshot } from '../../../../types/electron';
import { absoluteLpToLabel, dayToLocalTime, daysAgoLabel } from '../../../models/rank-scale';
import { ChartThemeService } from '../services/chart-theme.service';
import { EmptyStateComponent } from './empty-state.component';

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

  /**
   * Points to plot, alongside the row each one came from.
   *
   * The two are built together and stay index-aligned because the break points
   * below have no row: ApexCharts reports a hovered point by index, so a
   * separate lookup into `snapshots()` would silently point at the wrong day
   * for every point after the first reset.
   */
  private readonly plotted = computed(() => {
    const points: { x: number; y: number | null }[] = [];
    const rows: (RankSnapshot | null)[] = [];

    for (const s of this.snapshots()) {
      const x = dayToLocalTime(s.day);
      // A null y breaks an ApexCharts line. Without the break, a split reset
      // draws a sheer ~800 LP cliff joining two unrelated ladders — visually
      // the worst moment of the player's year, and something that never
      // happened. Placed a millisecond before the row so ordering holds.
      if (s.series_start && points.length > 0) {
        points.push({ x: x - 1, y: null });
        rows.push(null);
      }
      points.push({ x, y: s.score });
      rows.push(s);
    }

    return { points, rows };
  });

  readonly series = computed(() => [{ name: 'Rank', data: this.plotted().points }]);

  readonly options = computed(() => {
    // Depend on the theme revision so colours refresh when the theme changes.
    this.chartTheme.revision();
    const base = this.chartTheme.baseOptions(this.height());
    const palette = this.chartTheme.palette();
    const { points, rows } = this.plotted();

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
      markers: { size: points.length <= 60 ? 3 : 0, hover: { size: 5 } },
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
          // Break points have no row and nothing to say about them.
          const snap = rows[dataPointIndex];
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

          // A reset row's delta describes a different ladder, and a decayed
          // drop was not a loss. Both say so rather than showing a number that
          // invites the wrong reading.
          const note = snap.series_start
            ? '<div class="lp-tip-note">New split — LP reset</div>'
            : snap.inactive
              ? '<div class="lp-tip-note">Inactive — LP may be decaying</div>'
              : '';

          const showDelta = !snap.series_start && (snap.games > 0 || snap.difference !== 0);

          return `
            <div class="lp-tip">
              <div class="lp-tip-rank">${absoluteLpToLabel(snap.score)}</div>
              ${
                showDelta
                  ? `<div class="lp-tip-delta ${trend}">${sign}${snap.difference} LP · ${games}</div>`
                  : ''
              }
              ${note}
              <div class="lp-tip-when">${daysAgoLabel(time)}</div>
              <div class="lp-tip-date">${dateStr}</div>
            </div>`;
        },
      },
    };
  });
}
