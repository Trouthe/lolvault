import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AnalyticsDataService } from '../services/analytics-data.service';

/**
 * Builds full history for cached matches missing detail or timeline data.
 *
 * Riot's sustained budget is ~0.83 requests/second, so this can take minutes.
 * The ETA is shown up front and the run is cancellable — deliberately not a
 * spinner hiding an open-ended job.
 */
@Component({
  selector: 'app-backfill-control',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
  template: `
    @if (visible()) {
      <div class="backfill" [class.running]="data.backfillRunning()">
        @if (data.backfillRunning()) {
          @if (data.backfill(); as progress) {
            <div class="bf-body">
              <div class="bf-line">
                <span class="bf-title">Building match history…</span>
                <span class="bf-count">{{ progress.processed }} / {{ progress.total }}</span>
              </div>
              <div class="bf-track">
                <div
                  class="bf-fill"
                  [style.width.%]="progress.total ? (progress.processed / progress.total) * 100 : 0"
                ></div>
              </div>
              <span class="bf-eta">
                About {{ formatEta(progress.etaSeconds) }} remaining
                @if (progress.failed > 0) {
                  · {{ progress.failed }} failed
                }
              </span>
            </div>
          } @else {
            <div class="bf-body">
              <span class="bf-title">Starting…</span>
            </div>
          }
          <button type="button" class="bf-btn ghost" (click)="cancel()">Cancel</button>
        } @else {
          <div class="bf-body">
            <span class="bf-title">
              {{ status().pendingMatches }} older
              {{ status().pendingMatches === 1 ? 'game is' : 'games are' }} missing full data
            </span>
            <span class="bf-eta">
              Fetching adds heatmaps, builds and &#64;15 stats — about
              {{ formatEta(status().etaSeconds) }} at Riot's rate limit.
            </span>
          </div>
          <button type="button" class="bf-btn" (click)="start()">Build history</button>
        }
      </div>
    }
  `,
  styles: [
    `
      .backfill {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 10px 12px;
        border-radius: 10px;
        background: var(--card);
        border: 1px dashed var(--border-color);
      }

      .backfill.running {
        border-style: solid;
        border-color: var(--outline);
      }

      .bf-body {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 3px;
      }

      .bf-line {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 10px;
      }

      .bf-title {
        font-size: 12px;
        font-weight: 600;
        color: var(--primary-text);
      }

      .bf-count {
        font-size: 11px;
        color: var(--secondary-text);
        font-variant-numeric: tabular-nums;
      }

      .bf-eta {
        font-size: 10.5px;
        line-height: 1.45;
        color: var(--secondary-text);
      }

      .bf-track {
        height: 5px;
        border-radius: 999px;
        background: var(--muted);
        overflow: hidden;
      }

      .bf-fill {
        height: 100%;
        border-radius: 999px;
        background: var(--outline);
        transition: width 0.3s ease;
      }

      .bf-btn {
        flex-shrink: 0;
        padding: 7px 14px;
        border-radius: 8px;
        border: 1px solid var(--border-color);
        background: var(--muted);
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
export class BackfillControlComponent {
  readonly data = inject(AnalyticsDataService);

  readonly status = signal({ pendingMatches: 0, pendingRequests: 0, etaSeconds: 0 });

  readonly visible = computed(
    () => this.data.backfillRunning() || this.status().pendingMatches > 0
  );

  constructor() {
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    this.status.set(await this.data.backfillStatus());
  }

  async start(): Promise<void> {
    await this.data.startBackfill();
    await this.refresh();
  }

  async cancel(): Promise<void> {
    await this.data.cancelBackfill();
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
