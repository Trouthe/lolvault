import { ChangeDetectionStrategy, Component, computed, input, model } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RankSnapshot } from '../../../../types/electron';
import { QueueCard } from '../models/analytics.types';
import { RankStepperComponent } from './rank-stepper.component';
import { LpTrendMiniComponent } from './lp-trend-mini.component';
import { IconComponent } from './icon.component';

/**
 * Collapsible ranked-queue card for the rail.
 *
 * Rendered even for queues with no games so the card is always there to expand;
 * an unranked queue says so rather than showing a fabricated 0-0 record.
 */
@Component({
  selector: 'app-queue-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, RankStepperComponent, LpTrendMiniComponent, IconComponent],
  template: `
    <section class="queue" [class.open]="open()" [class.unranked]="!queue().ranked">
      <button
        type="button"
        class="queue-head"
        [attr.aria-expanded]="open()"
        (click)="open.set(!open())"
      >
        <span class="queue-name">{{ queue().label }}</span>
        <span class="queue-tier" [class.muted]="!queue().ranked">{{ tierLabel() }}</span>
        <app-icon class="chevron" [class.up]="open()" name="chevron-down" [size]="15" />
      </button>

      @if (open()) {
        <div class="queue-body">
          @if (queue().ranked) {
            <div class="rank-row">
              @if (emblemUrl()) {
                <img class="emblem" [src]="emblemUrl()" [alt]="tierLabel()" />
              }
              <div class="rank-meta">
                <span class="rank-name">{{ tierLabel() }}</span>
                <span class="rank-lp">{{ queue().leaguePoints }} LP</span>
              </div>
              <div class="rank-record">
                <span class="record-wl">
                  <b class="wins">{{ queue().wins }}W</b> <b class="losses">{{ queue().losses }}L</b>
                </span>
                <span class="record-wr" [class.positive]="queue().winRate >= 50">
                  Win Rate {{ queue().winRate | number: '1.0-0' }}%
                </span>
              </div>
            </div>

            <app-rank-stepper [tier]="queue().tier" [division]="queue().rank" />

            @if (snapshots().length >= 2) {
              <app-lp-trend-mini [snapshots]="snapshots()" />
            } @else {
              <p class="no-trend">
                LP trend appears once LoL Vault has recorded a few ranked games for this queue.
              </p>
            }
          } @else {
            <p class="no-trend">
              No ranked games in this queue yet. Play a placement game to see rank, LP and trend
              here.
            </p>
          }
        </div>
      }
    </section>
  `,
  styles: [
    `
      .queue {
        border-radius: 11px;
        border: 1px solid var(--border-color);
        background: var(--card);
        overflow: hidden;
      }

      .queue.unranked .queue-name {
        color: var(--secondary-text);
      }

      .queue-head {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto auto;
        align-items: center;
        gap: 8px;
        width: 100%;
        padding: 9px 11px;
        border: none;
        background: transparent;
        cursor: pointer;
        text-align: left;
        transition: background 0.15s ease;
      }

      .queue-head:hover {
        background: var(--muted);
      }

      .queue-name {
        font-size: 12px;
        font-weight: 700;
        color: var(--primary-text);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .queue-tier {
        font-size: 11px;
        color: var(--secondary-text);
        white-space: nowrap;
      }

      .queue-tier.muted {
        opacity: 0.7;
      }

      .chevron {
        color: var(--secondary-text);
        transition: transform 0.18s ease;
      }

      .chevron.up {
        transform: rotate(180deg);
      }

      .queue-body {
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 2px 11px 11px;
      }

      .rank-row {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr);
        grid-template-areas: 'emblem meta' 'emblem record';
        align-items: center;
        gap: 2px 10px;
      }

      .emblem {
        grid-area: emblem;
        width: 44px;
        height: 44px;
        object-fit: contain;
      }

      .rank-meta {
        grid-area: meta;
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 8px;
      }

      .rank-name {
        font-size: 13px;
        font-weight: 700;
        color: var(--primary-text);
      }

      .rank-lp {
        font-size: 11px;
        font-weight: 700;
        color: var(--secondary-text);
        font-variant-numeric: tabular-nums;
      }

      .rank-record {
        grid-area: record;
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 8px;
      }

      .record-wl {
        font-size: 10.5px;
        font-variant-numeric: tabular-nums;
      }

      .record-wl .wins {
        color: var(--primary-text);
      }

      .record-wl .losses {
        color: var(--secondary-text);
        margin-left: 3px;
      }

      .record-wr {
        font-size: 10.5px;
        color: var(--danger);
        font-variant-numeric: tabular-nums;
      }

      .record-wr.positive {
        color: #2f9e6f;
      }

      .no-trend {
        margin: 0;
        font-size: 10.5px;
        line-height: 1.5;
        color: var(--secondary-text);
      }
    `,
  ],
})
export class QueueCardComponent {
  queue = input.required<QueueCard>();
  snapshots = input<RankSnapshot[]>([]);

  /** Two-way so the shell can expand the primary queue by default. */
  open = model<boolean>(false);

  readonly tierLabel = computed(() => {
    const q = this.queue();
    if (!q.ranked || !q.tier) return 'Unranked';
    const tier = q.tier.charAt(0) + q.tier.slice(1).toLowerCase();
    // Apex tiers have no meaningful division to display.
    const apex = ['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(q.tier.toUpperCase());
    return apex ? tier : `${tier} ${q.rank}`;
  });

  readonly emblemUrl = computed(() => {
    const tier = this.queue().tier;
    if (!tier) return '';
    return `assets/emblems/${tier.charAt(0).toUpperCase()}${tier.slice(1).toLowerCase()}.png`;
  });
}
