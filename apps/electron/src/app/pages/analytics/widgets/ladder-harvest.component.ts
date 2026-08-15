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
import { LadderHarvestPlan } from '../../../../types/electron';
import { AnalyticsDataService } from '../services/analytics-data.service';
import { IconComponent } from './icon.component';

/**
 * Fills the local rank cache by paging whole divisions from Riot's ladder.
 *
 * The trade this control exists to offer:
 *
 *   · Showing the rank of the nine other players in a match, player by player,
 *     is 9 requests per card — around 11 seconds of a development key's budget
 *     per row, every time the list is drawn.
 *   · A ladder page returns 205 players for one request. Harvesting the
 *     divisions around your own covers nearly everyone you get matched with,
 *     and covers future matches too.
 *
 * So it is minutes now against nothing later, which is why it is a button with
 * a quoted wait rather than something that happens on page load. The panel
 * states the cache size before and after so the trade is visible, not implied.
 */
@Component({
  selector: 'app-ladder-harvest',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, IconComponent],
  template: `
    <section class="harvest" [class.running]="data.ladderHarvestRunning()">
      <header class="harvest-head">
        <h2>Rank Cache</h2>
        @if (plan(); as p) {
          <span class="harvest-count" [title]="cacheAge()">
            {{ p.cache.players | number }} players
          </span>
        }
      </header>

      @if (data.ladderHarvestRunning()) {
        <div class="progress">
          @if (data.ladderHarvest(); as progress) {
            <div class="progress-line">
              <span class="progress-title">
                @if (progress.phase === 'sizing') {
                  Measuring {{ divisionLabel(progress.bucket) }}…
                } @else {
                  Reading {{ divisionLabel(progress.bucket) }}…
                }
              </span>
              <span class="progress-count">
                {{ progress.pagesDone | number }} / {{ progress.pagesTotal | number }}
              </span>
            </div>
            <div class="track">
              <div
                class="fill"
                [class.indeterminate]="progress.phase === 'sizing'"
                [style.width.%]="
                  progress.pagesTotal ? (progress.pagesDone / progress.pagesTotal) * 100 : 100
                "
              ></div>
            </div>
            <span class="note">
              {{ progress.playersCached | number }} players cached · about
              {{ formatEta(progress.etaSeconds) }} left at Riot's rate limit
            </span>
          } @else {
            <span class="progress-title">Starting…</span>
            <div class="track"><div class="fill indeterminate" style="width: 100%"></div></div>
          }
          <button type="button" class="btn ghost" (click)="cancel()">Cancel</button>
        </div>
      } @else {
        <p class="note">
          @if (plan(); as p) {
            One ladder page is 205 players, so caching
            {{ divisionList(p) }} costs about as much as looking up
            {{ p.requests | number }} players — and then every match card shows
            ranks without a request.
          } @else {
            Ranks for the other players in a match come from a local cache. It
            fills from Riot's ladder, 205 players per request, instead of one
            request per player.
          }
        </p>

        <div class="actions">
          <button type="button" class="btn primary" [disabled]="!plan()" (click)="harvest()">
            <app-icon name="refresh-cw" [size]="12" />
            {{ plan()?.cache?.players ? 'Refresh cache' : 'Fill cache' }}
          </button>
          @if (plan(); as p) {
            <span class="actions-note">
              ~{{ formatEta(p.etaSeconds) }} · {{ p.requests | number }} requests
              @if (!p.exact) {
                · estimate
              }
            </span>
          }
        </div>
      }

      @if (data.ladderHarvestError(); as error) {
        <p class="error">{{ error }}</p>
      }
    </section>
  `,
  styles: [
    `
      .harvest {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 10px 11px 11px;
        border-radius: 11px;
        border: 1px solid var(--border-color);
        background: var(--card);
      }

      .harvest-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 8px;
      }

      .harvest-head h2 {
        margin: 0;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--secondary-text);
      }

      .harvest-count {
        font-size: 10px;
        color: var(--secondary-text);
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }

      .note {
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

      .progress {
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

      /* Sizing has no meaningful total yet, so the bar pulses rather than
         lying about progress. */
      .fill.indeterminate {
        animation: harvest-pulse 1.4s ease-in-out infinite;
      }

      @keyframes harvest-pulse {
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
export class LadderHarvestComponent {
  readonly data = inject(AnalyticsDataService);

  /** Which ranked queue's ladder to cache. */
  queueType = input<string>('RANKED_SOLO_5x5');

  /**
   * Divisions to reach either side of the account's own.
   *
   * One is the useful default: matchmaking rarely reaches further, and each
   * extra division is another few hundred requests.
   */
  spread = input<number>(1);

  readonly plan = signal<LadderHarvestPlan | null>(null);

  constructor() {
    // Re-planned after every harvest: the second run of a week is far cheaper
    // than the first because the census already knows every page count, and the
    // quoted wait should say so.
    effect(() => {
      this.data.ranked();
      this.queueType();
      this.spread();
      this.data.ladderHarvestRunning();
      void this.refreshPlan();
    });
  }

  private async refreshPlan(): Promise<void> {
    if (this.data.ladderHarvestRunning()) return;
    this.plan.set(await this.data.ladderHarvestPlan(this.queueType(), this.spread()));
  }

  readonly cacheAge = computed(() => {
    const newest = this.plan()?.cache?.newest;
    if (!newest) return 'Nothing cached yet';
    return `Last filled ${new Date(newest).toLocaleString()}`;
  });

  /** "EMERALD/II" → "Emerald II". */
  divisionLabel(bucket: string): string {
    if (!bucket) return 'the ladder';
    const [tier, division] = bucket.split('/');
    const name = tier.charAt(0) + tier.slice(1).toLowerCase();
    const apex = ['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(tier);
    return apex ? name : `${name} ${division}`;
  }

  /** "Emerald III–Emerald I" — the range, not a list of every division. */
  divisionList(plan: LadderHarvestPlan): string {
    if (!plan.buckets.length) return 'your division';
    const first = plan.buckets[0];
    const last = plan.buckets[plan.buckets.length - 1];
    const label = (b: { tier: string; division: string }) =>
      this.divisionLabel(`${b.tier}/${b.division}`);
    return first === last ? label(first) : `${label(first)}–${label(last)}`;
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

  async harvest(): Promise<void> {
    await this.data.harvestLadder(this.queueType(), this.spread());
  }

  async cancel(): Promise<void> {
    await this.data.cancelLadderHarvest();
  }
}
