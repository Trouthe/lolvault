import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { LpSnapshot } from '../../../../types/electron';
import { absoluteLpToLabel } from './lp-climb-chart.component';

const DAY_MS = 86_400_000;
const W = 100;
const H = 38;

interface Plotted {
  x: number;
  y: number;
  snapshot: LpSnapshot;
}

/**
 * Compact LP trend for the rail's ranked card.
 *
 * Points are placed by **timestamp**, not by index. LP snapshots are captured
 * opportunistically while the app runs, so they cluster: a typical history is a
 * couple of readings months apart and three within the same hour. Spacing those
 * evenly would draw a steady climb that never happened — the time axis keeps a
 * long flat stretch flat and a single-session jump sharp.
 *
 * Drawn as inline SVG rather than a chart component: it is a sparkline with no
 * axes or interaction, so ApexCharts would cost far more than it gives.
 */
@Component({
  selector: 'app-lp-trend-mini',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
  template: `
    @if (plotted().length >= 2) {
      <div class="trend">
        <header class="trend-head">
          <span class="trend-window">{{ windowLabel() }}</span>
          <b class="trend-delta" [class.up]="netLp() > 0" [class.down]="netLp() < 0">
            {{ netLp() > 0 ? '+' : '' }}{{ netLp() }} LP
          </b>
        </header>

        <svg
          class="spark"
          [attr.viewBox]="'0 0 ' + W + ' ' + H"
          preserveAspectRatio="none"
          role="img"
          [attr.aria-label]="ariaLabel()"
        >
          <!-- Soft fill under the line for readability at this size. -->
          <polygon class="spark-area" [class.up]="netLp() >= 0" [attr.points]="areaPoints()" />
          <polyline
            class="spark-line"
            [class.up]="netLp() >= 0"
            [attr.points]="linePoints()"
            fill="none"
            vector-effect="non-scaling-stroke"
          />
          <!-- Real samples are marked, so sparse data doesn't read as a
               continuous recording. -->
          @for (p of plotted(); track $index) {
            <circle
              class="spark-dot"
              [class.up]="netLp() >= 0"
              [attr.cx]="p.x"
              [attr.cy]="p.y"
              r="1.6"
              vector-effect="non-scaling-stroke"
            />
          }
        </svg>

        <div class="trend-axis">
          <span>{{ startLabel() }}</span>
          <span class="trend-range">{{ lowLabel() }} → {{ highLabel() }}</span>
          <span>{{ endLabel() }}</span>
        </div>
      </div>
    }
  `,
  styles: [
    `
      .trend {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 8px 9px;
        border-radius: 9px;
        background: color-mix(in oklch, var(--muted) 55%, transparent);
      }

      .trend-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 8px;
      }

      .trend-window {
        font-size: 10px;
        color: var(--secondary-text);
      }

      .trend-delta {
        font-size: 11px;
        font-weight: 700;
        color: var(--secondary-text);
        font-variant-numeric: tabular-nums;
      }

      .trend-delta.up {
        color: #2f9e6f;
      }

      .trend-delta.down {
        color: var(--danger);
      }

      .spark {
        width: 100%;
        height: 38px;
        display: block;
        overflow: visible;
      }

      .spark-line {
        stroke: var(--danger);
        stroke-width: 1.5;
        stroke-linejoin: round;
        stroke-linecap: round;
      }

      .spark-line.up {
        stroke: #2f9e6f;
      }

      .spark-area {
        fill: color-mix(in oklch, var(--danger) 22%, transparent);
      }

      .spark-area.up {
        fill: color-mix(in oklch, #2f9e6f 22%, transparent);
      }

      .spark-dot {
        fill: var(--danger);
      }

      .spark-dot.up {
        fill: #2f9e6f;
      }

      .trend-axis {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: 6px;
        font-size: 8.5px;
        color: var(--secondary-text);
        opacity: 0.85;
      }

      .trend-range {
        font-variant-numeric: tabular-nums;
        opacity: 0.85;
      }
    `,
  ],
})
export class LpTrendMiniComponent {
  snapshots = input.required<LpSnapshot[]>();
  windowDays = input<number>(30);

  readonly W = W;
  readonly H = H;

  /**
   * Snapshots to draw, oldest first.
   *
   * Consecutive readings with identical LP are collapsed — the monitor samples
   * repeatedly during a session and those duplicates add nothing but clutter.
   * If the requested window holds fewer than two distinct readings, the whole
   * history is used instead and the header says so.
   */
  private readonly source = computed(() => {
    const all = [...this.snapshots()].sort((a, b) => a.timestamp - b.timestamp);

    const dedupe = (list: LpSnapshot[]) =>
      list.filter((s, i) => i === 0 || s.absolute_lp !== list[i - 1].absolute_lp);

    const windowed = dedupe(all.filter((s) => s.timestamp >= Date.now() - this.windowDays() * DAY_MS));
    if (windowed.length >= 2) return { points: windowed, windowed: true };

    return { points: dedupe(all), windowed: false };
  });

  readonly windowLabel = computed(() =>
    this.source().windowed ? `Last ${this.windowDays()}d` : 'All time'
  );

  /** Points mapped to the viewBox, spaced by real elapsed time. */
  readonly plotted = computed<Plotted[]>(() => {
    const points = this.source().points;
    if (points.length < 2) return [];

    const first = points[0].timestamp;
    const last = points[points.length - 1].timestamp;
    const span = last - first || 1;

    const values = points.map((p) => p.absolute_lp);
    const min = Math.min(...values);
    const max = Math.max(...values);
    // A flat history would divide by zero; draw it mid-height instead.
    const range = max - min || 1;
    const flat = max === min;

    return points.map((snapshot) => ({
      x: ((snapshot.timestamp - first) / span) * W,
      y: flat ? H / 2 : H - ((snapshot.absolute_lp - min) / range) * (H - 4) - 2,
      snapshot,
    }));
  });

  readonly linePoints = computed(() =>
    this.plotted()
      .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)
      .join(' ')
  );

  /** Line points closed along the baseline, for the fill. */
  readonly areaPoints = computed(() => {
    const pts = this.plotted();
    if (pts.length < 2) return '';
    return `${pts[0].x.toFixed(1)},${H} ${this.linePoints()} ${pts[pts.length - 1].x.toFixed(1)},${H}`;
  });

  readonly netLp = computed(() => {
    const pts = this.source().points;
    if (pts.length < 2) return 0;
    return pts[pts.length - 1].absolute_lp - pts[0].absolute_lp;
  });

  private readonly bounds = computed(() => {
    const values = this.source().points.map((p) => p.absolute_lp);
    return { min: Math.min(...values), max: Math.max(...values) };
  });

  /**
   * Rank labels for the low and high points. When both fall inside the same
   * division the tier text is identical, so raw LP is shown instead — the old
   * behaviour printed "E1 → E1", which told the reader nothing.
   */
  private readonly rangeLabels = computed(() => {
    const { min, max } = this.bounds();
    const low = this.tierShort(min);
    const high = this.tierShort(max);
    if (low !== high) return { low, high };
    return { low: `${min % 100} LP`, high: `${max % 100} LP` };
  });

  readonly lowLabel = computed(() => this.rangeLabels().low);
  readonly highLabel = computed(() => this.rangeLabels().high);

  readonly startLabel = computed(() => this.dateLabel(this.source().points[0]?.timestamp));
  readonly endLabel = computed(() =>
    this.dateLabel(this.source().points[this.source().points.length - 1]?.timestamp)
  );

  readonly ariaLabel = computed(
    () => `LP trend, ${this.windowLabel()}, net ${this.netLp()} LP`
  );

  private dateLabel(timestamp?: number): string {
    if (!timestamp) return '';
    return new Date(timestamp).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  private tierShort(absoluteLp: number): string {
    const label = absoluteLpToLabel(Math.round(absoluteLp));
    const [tier, division] = label.split(' ');
    const roman: Record<string, string> = { IV: '4', III: '3', II: '2', I: '1' };
    return `${tier?.charAt(0) ?? ''}${roman[division] ?? ''}`;
  }
}
