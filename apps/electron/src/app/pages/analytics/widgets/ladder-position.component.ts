import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { LadderSweepEstimate } from '../../../../types/electron';
import { AnalyticsDataService } from '../services/analytics-data.service';
import { IconComponent } from './icon.component';

/**
 * Where this account sits on its region's ranked ladder.
 *
 * Riot publishes no such number. `entries/by-puuid` says "Emerald II, 39 LP" and
 * nothing more; the place that corresponds to is only knowable by counting the
 * players above you, which means measuring every division on the region. See
 * apps/electron/ladder.js for how, and docs/lp-history-how-dpm-lol-does-it.md §3
 * for why it is the only way.
 *
 * The whole design of this panel follows from that cost. On a development key a
 * first sweep is minutes, so it is a button and not a refresh — with the wait
 * quoted before the click, progress while it runs, and a cancel that takes
 * effect at the next page. A measured position is stamped with its age rather
 * than presented as live, because it is a reading, not a subscription.
 */
@Component({
  selector: 'app-ladder-position',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, IconComponent],
  template: `
    <section class="ladder" [class.running]="data.ladderSweepRunning()">
      <header class="ladder-head">
        <h2>Ladder Position</h2>
        @if (latest()) {
          <span class="ladder-age" [title]="measuredOn()">{{ age() }}</span>
        }
      </header>

      @if (data.ladderSweepRunning()) {
        <div class="ladder-progress">
          @if (data.ladderSweep(); as progress) {
            <div class="progress-line">
              <span class="progress-title">
                @if (progress.phase === 'census') {
                  Sizing every division…
                } @else {
                  Reading {{ tierLabel() }}…
                }
              </span>
              <span class="progress-count">
                @if (progress.phase === 'census') {
                  {{ progress.bucketsDone }} / {{ progress.bucketsTotal }}
                } @else {
                  {{ progress.pagesDone }} / {{ progress.pagesTotal }}
                }
              </span>
            </div>
            <div class="track">
              <div class="fill" [style.width.%]="percentDone(progress)"></div>
            </div>
            <span class="progress-note">
              About {{ formatEta(progress.etaSeconds) }} left at Riot's rate limit ·
              {{ progress.requests }} requests so far
            </span>
          } @else {
            <span class="progress-title">Starting…</span>
            <div class="track"><div class="fill indeterminate"></div></div>
          }
          <button type="button" class="btn ghost" (click)="cancel()">Cancel</button>
        </div>
      } @else if (latest(); as row) {
        <div class="result">
          <div class="place">
            <span class="place-value">#{{ row.position | number }}</span>
            <span class="place-of">of {{ row.total | number }} on {{ region() }}</span>
          </div>
          <div class="pct" [title]="'Higher than ' + (100 - row.percentile | number: '1.1-1') + '% of ranked players'">
            <span class="pct-value">Top {{ formatPercentile(row.percentile) }}</span>
            <span class="pct-bar">
              <!-- Filled from the left because the ladder is drawn top-down:
                   a short bar is a high place. -->
              <span class="pct-fill" [style.width.%]="Math.min(100, row.percentile)"></span>
            </span>
          </div>
        </div>

        <p class="within">
          <b>#{{ row.bucket_position | number }}</b> of
          {{ row.bucket_total | number }} in {{ tierLabelOf(row.tier, row.division) }}
          <span class="within-lp">· {{ row.league_points }} LP</span>
        </p>

        <div class="actions">
          <button type="button" class="btn" (click)="sweep()">
            <app-icon name="refresh-cw" [size]="12" />
            Re-measure
          </button>
          @if (estimate(); as est) {
            <span class="actions-note">{{ formatEta(est.etaSeconds) }}</span>
          }
        </div>
      } @else {
        <p class="empty-note">
          Riot serves no ladder position — it can only be counted. Measuring it
          reads every division on {{ region() }} once, then reads
          {{ tierLabel() }} in full to find how many players are above
          {{ leaguePoints() }} LP.
        </p>
        <div class="actions">
          <button type="button" class="btn primary" [disabled]="!ranked()" (click)="sweep()">
            Measure position
          </button>
          @if (estimate(); as est) {
            <span class="actions-note">
              ~{{ formatEta(est.etaSeconds) }} · {{ est.requests | number }} requests
              @if (!est.exact) {
                · estimate
              }
            </span>
          }
        </div>
      }

      @if (data.ladderSweepError(); as error) {
        <p class="error">{{ error }}</p>
      }
    </section>
  `,
  styles: [
    `
      .ladder {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 10px 11px 11px;
        border-radius: 11px;
        border: 1px solid var(--border-color);
        background: var(--card);
      }

      .ladder-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 8px;
      }

      .ladder-head h2 {
        margin: 0;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--secondary-text);
      }

      .ladder-age {
        font-size: 10px;
        color: var(--secondary-text);
        opacity: 0.8;
        white-space: nowrap;
      }

      .result {
        display: flex;
        flex-direction: column;
        gap: 7px;
      }

      .place {
        display: flex;
        align-items: baseline;
        gap: 7px;
        flex-wrap: wrap;
      }

      .place-value {
        font-size: 22px;
        font-weight: 800;
        line-height: 1;
        color: var(--primary-text);
        font-variant-numeric: tabular-nums;
      }

      .place-of {
        font-size: 10.5px;
        color: var(--secondary-text);
        font-variant-numeric: tabular-nums;
      }

      .pct {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .pct-value {
        font-size: 11px;
        font-weight: 700;
        color: #2f9e6f;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }

      .pct-bar {
        position: relative;
        flex: 1;
        height: 4px;
        border-radius: 999px;
        background: var(--muted);
        overflow: hidden;
      }

      .pct-fill {
        position: absolute;
        inset: 0 auto 0 0;
        border-radius: 999px;
        background: linear-gradient(90deg, #2f9e6f, var(--outline));
        min-width: 2px;
      }

      .within {
        margin: 0;
        font-size: 10.5px;
        color: var(--secondary-text);
        font-variant-numeric: tabular-nums;
      }

      .within b {
        color: var(--primary-text);
      }

      .within-lp {
        opacity: 0.8;
      }

      .empty-note,
      .progress-note {
        margin: 0;
        font-size: 10.5px;
        line-height: 1.5;
        color: var(--secondary-text);
      }

      .actions {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }

      .actions-note {
        font-size: 10px;
        color: var(--secondary-text);
        font-variant-numeric: tabular-nums;
      }

      .btn {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 5px 11px;
        border-radius: 8px;
        border: 1px solid var(--border-color);
        background: var(--muted);
        color: var(--primary-text);
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.15s ease;
      }

      .btn:hover:not(:disabled) {
        background: var(--outline);
      }

      .btn:disabled {
        opacity: 0.5;
        cursor: default;
      }

      .btn.primary {
        background: var(--outline);
      }

      .btn.ghost {
        align-self: flex-start;
        background: transparent;
        border-color: transparent;
        color: var(--secondary-text);
      }

      .btn.ghost:hover {
        color: var(--danger);
        background: transparent;
      }

      .ladder-progress {
        display: flex;
        flex-direction: column;
        gap: 5px;
      }

      .progress-line {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 8px;
      }

      .progress-title {
        font-size: 11.5px;
        font-weight: 600;
        color: var(--primary-text);
      }

      .progress-count {
        font-size: 10px;
        color: var(--secondary-text);
        font-variant-numeric: tabular-nums;
      }

      .track {
        height: 4px;
        border-radius: 999px;
        background: var(--muted);
        overflow: hidden;
      }

      .fill {
        height: 100%;
        border-radius: 999px;
        background: var(--outline);
        transition: width 0.3s ease;
      }

      .fill.indeterminate {
        width: 100%;
        animation: ladder-pulse 1.4s ease-in-out infinite;
      }

      @keyframes ladder-pulse {
        0%,
        100% {
          opacity: 0.35;
        }
        50% {
          opacity: 1;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .fill.indeterminate {
          animation: none;
          opacity: 0.7;
        }
      }

      .error {
        margin: 0;
        font-size: 10.5px;
        line-height: 1.45;
        color: var(--danger);
      }
    `,
  ],
})
export class LadderPositionComponent {
  readonly data = inject(AnalyticsDataService);

  /** Which ranked queue to place. One sweep only ever measures one ladder. */
  queueType = input<string>('RANKED_SOLO_5x5');

  /** Exposed for the template's width clamp. */
  protected readonly Math = Math;

  readonly estimate = signal<LadderSweepEstimate | null>(null);

  constructor() {
    // The estimate depends on what the census already holds, so it is re-read
    // after every sweep rather than once on load: the second sweep of a week is
    // dramatically cheaper than the first, and the button should say so.
    effect(() => {
      // Track the inputs that change the answer.
      this.data.ranked();
      this.queueType();
      this.data.ladderSweepRunning();
      void this.refreshEstimate();
    });
  }

  private async refreshEstimate(): Promise<void> {
    if (this.data.ladderSweepRunning()) return;
    this.estimate.set(await this.data.ladderSweepEstimate(this.queueType()));
  }

  readonly ranked = computed(() => {
    const entry = this.data.ranked().find((e) => e.queueType === this.queueType());
    return entry?.tier ? entry : null;
  });

  readonly leaguePoints = computed(() => this.ranked()?.leaguePoints ?? 0);

  /** Newest measurement for this queue, or null before the first sweep. */
  readonly latest = computed(() => {
    const rows = this.data.ladderPositions().filter((p) => p.queue === this.queueType());
    return rows.length ? rows[rows.length - 1] : null;
  });

  readonly region = computed(() => this.data.account()?.server || this.data.platform());

  readonly tierLabel = computed(() => {
    const entry = this.ranked();
    return entry ? this.tierLabelOf(entry.tier, entry.rank) : 'your division';
  });

  tierLabelOf(tier: string, division: string): string {
    if (!tier) return 'Unranked';
    const name = tier.charAt(0) + tier.slice(1).toLowerCase();
    const apex = ['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(tier.toUpperCase());
    return apex ? name : `${name} ${division}`;
  }

  /** How long ago the measurement was taken — it is a reading, not a feed. */
  readonly age = computed(() => {
    const row = this.latest();
    if (!row) return '';
    const days = Math.floor((Date.now() - row.observed_at) / 86_400_000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 30) return `${days}d ago`;
    const months = Math.round(days / 30);
    return `${months}mo ago`;
  });

  readonly measuredOn = computed(() => {
    const row = this.latest();
    if (!row) return '';
    return `Measured ${new Date(row.observed_at).toLocaleString()}`;
  });

  /**
   * Percentiles are only interesting at the precision the number supports.
   * "Top 0.4%" is worth a decimal; "Top 62%" is not.
   */
  formatPercentile(percentile: number): string {
    if (percentile < 1) return `${percentile.toFixed(2)}%`;
    if (percentile < 10) return `${percentile.toFixed(1)}%`;
    return `${Math.round(percentile)}%`;
  }

  percentDone(progress: { phase: string; bucketsDone: number; bucketsTotal: number; pagesDone: number; pagesTotal: number }): number {
    if (progress.phase === 'census') {
      return progress.bucketsTotal ? (progress.bucketsDone / progress.bucketsTotal) * 100 : 0;
    }
    return progress.pagesTotal ? (progress.pagesDone / progress.pagesTotal) * 100 : 0;
  }

  formatEta(seconds: number): string {
    if (seconds <= 0) return 'a moment';
    if (seconds < 60) return `${Math.round(seconds)}s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `${hours}h ${rest}m` : `${hours}h`;
  }

  async sweep(): Promise<void> {
    await this.data.sweepLadderPosition(this.queueType());
  }

  async cancel(): Promise<void> {
    await this.data.cancelLadderSweep();
  }
}
