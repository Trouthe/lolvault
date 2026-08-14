import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RankSnapshot } from '../../../../types/electron';
import { absoluteLpToLabel, dayToLocalTime } from '../../../models/rank-scale';

const DAY_MS = 86_400_000;
const W = 100;
const H = 38;
/**
 * Inset so the first and last sample dots sit fully inside the viewBox. Drawn
 * edge-to-edge they were sliced in half by the box, which read as a rendering
 * glitch rather than as data.
 */
const PAD_X = 3;
const PAD_Y = 4;

/** A reading reduced to what the sparkline needs: when, and how much LP. */
interface Point {
  t: number;
  lp: number;
}

interface Plotted {
  x: number;
  y: number;
  snapshot: Point;
}

/**
 * Compact rank trend for the rail's queue cards.
 *
 * Points are placed by **date**, not by index. The series only holds days the
 * account was actually recorded, so spacing points evenly would compress a
 * two-month gap into the same width as an overnight climb. The time axis keeps
 * a long flat stretch flat and a single jump sharp.
 *
 * Reads the daily series, so it works for any queue — flex included, which the
 * old solo-only wiring left permanently blank.
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

        <!-- The line is SVG; the sample dots are HTML overlaid on it. The SVG is
             stretched to fill the card (preserveAspectRatio="none"), which would
             squash circles into ellipses — and DOM dots are hoverable. -->
        <div class="spark-wrap" (mouseleave)="hovered.set(null)">
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
          </svg>

          <!-- Real samples are marked, so sparse data doesn't read as a
               continuous recording. -->
          @for (p of plotted(); track $index; let i = $index) {
            <button
              type="button"
              class="dot"
              [class.up]="netLp() >= 0"
              [class.active]="hovered() === i"
              [style.left.%]="p.x"
              [style.top.%]="(p.y / H) * 100"
              [attr.aria-label]="tooltipFor(i)"
              (mouseenter)="hovered.set(i)"
              (focus)="hovered.set(i)"
              (blur)="hovered.set(null)"
            ></button>
          }

          @if (activePoint(); as point) {
            <div
              class="tip"
              [class.pin-left]="point.x < 30"
              [class.pin-right]="point.x > 70"
              [style.left.%]="point.x"
            >
              <span class="tip-rank">{{ point.rank }}</span>
              <span class="tip-lp">{{ point.lp }} LP</span>
              <span class="tip-when">{{ point.when }} · {{ point.ago }}</span>
            </div>
          }
        </div>

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

      .spark-wrap {
        position: relative;
        width: 100%;
        height: 38px;
      }

      .spark {
        width: 100%;
        height: 100%;
        display: block;
      }

      /* Sample markers: HTML so they stay circular over the stretched SVG and
         can take pointer and keyboard focus. */
      .dot {
        position: absolute;
        width: 7px;
        height: 7px;
        margin: -3.5px 0 0 -3.5px;
        padding: 0;
        border: none;
        border-radius: 50%;
        background: var(--danger);
        cursor: pointer;
        transition: transform 0.12s ease;
      }

      .dot.up {
        background: #2f9e6f;
      }

      .dot:hover,
      .dot:focus-visible,
      .dot.active {
        transform: scale(1.5);
        outline: none;
        box-shadow: 0 0 0 2px color-mix(in oklch, var(--card) 85%, transparent);
      }

      .tip {
        position: absolute;
        bottom: calc(100% + 7px);
        transform: translateX(-50%);
        z-index: 4;
        display: flex;
        flex-direction: column;
        gap: 1px;
        padding: 5px 8px;
        border-radius: 7px;
        background: var(--card);
        border: 1px solid var(--border-color);
        box-shadow: 0 6px 16px rgb(0 0 0 / 28%);
        white-space: nowrap;
        pointer-events: none;
      }

      /* Near either edge the tooltip anchors to that side instead of centring,
         so it never spills out of the (clipped) rank card. */
      .tip.pin-left {
        transform: translateX(-6px);
      }

      .tip.pin-right {
        transform: translateX(calc(-100% + 6px));
      }

      .tip-rank {
        font-size: 11px;
        font-weight: 700;
        color: var(--primary-text);
      }

      .tip-lp {
        font-size: 10.5px;
        font-weight: 700;
        color: var(--secondary-text);
        font-variant-numeric: tabular-nums;
      }

      .tip-when {
        font-size: 9.5px;
        color: var(--secondary-text);
        opacity: 0.85;
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
  snapshots = input.required<RankSnapshot[]>();
  windowDays = input<number>(30);

  readonly W = W;
  readonly H = H;

  /** Index of the sample under the pointer, or null. */
  readonly hovered = signal<number | null>(null);

  /**
   * Readings to draw, oldest first.
   *
   * The daily series already holds at most one row per day, so the old
   * collapse-consecutive-duplicates pass is gone with the noise it existed to
   * hide. It would now delete real information: a day that ended on the LP it
   * started on is a day that was *played* to a draw, not a repeated sample.
   *
   * If the requested window holds fewer than two readings the whole history is
   * used instead, and the header says so.
   */
  private readonly source = computed(() => {
    const all: Point[] = this.snapshots()
      .map((s) => ({ t: dayToLocalTime(s.day), lp: s.score }))
      .sort((a, b) => a.t - b.t);

    const windowed = all.filter((p) => p.t >= Date.now() - this.windowDays() * DAY_MS);
    if (windowed.length >= 2) return { points: windowed, windowed: true };

    return { points: all, windowed: false };
  });

  readonly windowLabel = computed(() =>
    this.source().windowed ? `Last ${this.windowDays()}d` : 'All time'
  );

  /** Points mapped to the viewBox, spaced by real elapsed time. */
  readonly plotted = computed<Plotted[]>(() => {
    const points = this.source().points;
    if (points.length < 2) return [];

    const first = points[0].t;
    const last = points[points.length - 1].t;
    const span = last - first || 1;

    const values = points.map((p) => p.lp);
    const min = Math.min(...values);
    const max = Math.max(...values);
    // A flat history would divide by zero; draw it mid-height instead.
    const range = max - min || 1;
    const flat = max === min;

    const innerW = W - PAD_X * 2;
    const innerH = H - PAD_Y * 2;

    return points.map((snapshot) => ({
      x: PAD_X + ((snapshot.t - first) / span) * innerW,
      y: flat ? H / 2 : H - PAD_Y - ((snapshot.lp - min) / range) * innerH,
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
    return pts[pts.length - 1].lp - pts[0].lp;
  });

  private readonly bounds = computed(() => {
    const values = this.source().points.map((p) => p.lp);
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

  readonly startLabel = computed(() => this.dateLabel(this.source().points[0]?.t));
  readonly endLabel = computed(() =>
    this.dateLabel(this.source().points[this.source().points.length - 1]?.t)
  );

  readonly ariaLabel = computed(
    () => `LP trend, ${this.windowLabel()}, net ${this.netLp()} LP`
  );

  /** Everything the hover card shows for the focused sample. */
  readonly activePoint = computed(() => {
    const index = this.hovered();
    if (index === null) return null;
    const point = this.plotted()[index];
    if (!point) return null;

    const { t: timestamp, lp: absolute_lp } = point.snapshot;
    return {
      x: point.x,
      rank: absoluteLpToLabel(Math.round(absolute_lp)),
      lp: Math.round(absolute_lp) % 100,
      when: new Date(timestamp).toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      }),
      ago: this.agoLabel(timestamp),
    };
  });

  /** Accessible label for one dot, mirroring the hover card. */
  tooltipFor(index: number): string {
    const point = this.plotted()[index];
    if (!point) return '';
    const lp = Math.round(point.snapshot.lp);
    return `${absoluteLpToLabel(lp)} ${lp % 100} LP, ${this.agoLabel(point.snapshot.t)}`;
  }

  private agoLabel(timestamp: number): string {
    const days = Math.floor((Date.now() - timestamp) / DAY_MS);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 30) return `${days} days ago`;
    const months = Math.round(days / 30);
    return months === 1 ? 'a month ago' : `${months} months ago`;
  }

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
