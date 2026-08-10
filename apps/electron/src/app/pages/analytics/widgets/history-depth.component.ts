import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AnalyticsDataService } from '../services/analytics-data.service';
import { RANKED_SOLO_QUEUE } from '../models/analytics.types';

/**
 * Pulls a calendar year of ranked solo/duo games so the heatmap has a year to
 * show.
 *
 * The routine history fetch only asks Riot for the newest handful of games,
 * which leaves the grid with a few busy weeks and eleven blank months. Filling
 * it in costs one request per game against a ~0.83 req/s budget, so it is an
 * explicit action with a stated ETA and a cancel button rather than something
 * that quietly runs on page load.
 *
 * The wait is the design problem here, not the fetch. Minutes of progress bar
 * with nothing else moving reads as a hang, so games are merged into the grid
 * as they arrive: the bar is a secondary signal and the heatmap filling in is
 * the primary one.
 */
@Component({
  selector: 'app-history-depth',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
  template: `
    <div class="depth" [class.running]="data.yearHistoryRunning()">
      @if (data.yearHistoryRunning()) {
        <div class="depth-body">
          @if (data.yearHistory(); as progress) {
            <div class="depth-line">
              <span class="depth-title">
                @if (progress.phase === 'scanning') {
                  Scanning {{ year() }} for ranked games…
                } @else {
                  Filling in {{ year() }}…
                }
              </span>
              @if (progress.phase === 'fetching' && progress.total) {
                <span class="depth-count">{{ progress.processed }} / {{ progress.total }}</span>
              }
            </div>
            <div class="depth-track">
              <div
                class="depth-fill"
                [class.indeterminate]="progress.phase === 'scanning' || !progress.total"
                [style.width.%]="
                  progress.phase === 'fetching' && progress.total
                    ? (progress.processed / progress.total) * 100
                    : 100
                "
              ></div>
            </div>
            <span class="depth-note">
              @if (progress.phase === 'scanning') {
                Asking Riot which ranked games you played — a few seconds.
              } @else {
                <!-- The ETA is the honest one: Riot's own limit, not ours. -->
                About {{ formatEta(progress.etaSeconds) }} left at Riot's rate limit · days
                fill in above as games arrive
                @if (progress.reused) {
                  · {{ progress.reused }} already on disk
                }
                @if (progress.failed > 0) {
                  · {{ progress.failed }} failed
                }
              }
            </span>
          } @else {
            <span class="depth-title">Starting…</span>
            <div class="depth-track">
              <div class="depth-fill indeterminate" style="width: 100%"></div>
            </div>
          }
        </div>
        <button type="button" class="depth-btn ghost" (click)="cancel()">Cancel</button>
      } @else {
        <div class="depth-body">
          <span class="depth-note">
            Only games already pulled from Riot appear above. Loading {{ year() }} costs one
            request per ranked game and runs at Riot's rate limit — the grid fills in as it
            goes, you can keep browsing, and it only has to run once.
          </span>
        </div>
        <button type="button" class="depth-btn" (click)="load()">Load {{ year() }}</button>
      }
    </div>
  `,
  styles: [
    `
      .depth {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 9px 11px;
        border-radius: 10px;
        background: color-mix(in oklch, var(--muted) 45%, transparent);
        border: 1px dashed var(--border-color);
      }

      .depth.running {
        border-style: solid;
        border-color: var(--outline);
      }

      .depth-body {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 3px;
      }

      .depth-line {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 10px;
      }

      .depth-title {
        font-size: 11.5px;
        font-weight: 600;
        color: var(--primary-text);
      }

      .depth-count {
        font-size: 10.5px;
        color: var(--secondary-text);
        font-variant-numeric: tabular-nums;
      }

      .depth-note {
        font-size: 10.5px;
        line-height: 1.45;
        color: var(--secondary-text);
      }

      .depth-track {
        height: 4px;
        border-radius: 999px;
        background: var(--muted);
        overflow: hidden;
      }

      .depth-fill {
        height: 100%;
        border-radius: 999px;
        background: var(--outline);
        transition: width 0.3s ease;
      }

      /* Scanning has no meaningful total, so the bar pulses instead of lying
         about progress. */
      .depth-fill.indeterminate {
        animation: depth-pulse 1.4s ease-in-out infinite;
      }

      @keyframes depth-pulse {
        0%,
        100% {
          opacity: 0.35;
        }
        50% {
          opacity: 1;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .depth-fill.indeterminate {
          animation: none;
          opacity: 0.7;
        }
      }

      .depth-btn {
        flex-shrink: 0;
        padding: 6px 13px;
        border-radius: 8px;
        border: 1px solid var(--border-color);
        background: var(--card);
        color: var(--primary-text);
        font-size: 11.5px;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.15s ease;

        &:hover {
          background: var(--outline);
        }

        &.ghost {
          background: transparent;
          color: var(--secondary-text);
        }

        &.ghost:hover {
          color: var(--danger);
          background: transparent;
        }
      }
    `,
  ],
})
export class HistoryDepthComponent {
  readonly data = inject(AnalyticsDataService);

  year = input.required<number>();

  /** Riot's matchlist has no timestamps before 16 June 2021 to window on. */
  readonly supported = computed(() => this.year() >= 2021);

  async load(): Promise<void> {
    // Ranked solo/duo only, matching what the grid above actually counts. Riot
    // applies this to the id listing itself, so games in other modes never cost
    // a request at all.
    await this.data.fetchYear(this.year(), RANKED_SOLO_QUEUE);
  }

  async cancel(): Promise<void> {
    await this.data.cancelYearHistory();
  }

  formatEta(seconds: number): string {
    if (seconds <= 0) return 'a moment';
    if (seconds < 60) return `${Math.round(seconds)} seconds`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `${hours}h ${rest}m` : `${hours}h`;
  }
}
