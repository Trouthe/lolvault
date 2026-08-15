import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivityDay } from '../models/analytics.types';

/**
 * Day-by-day activity heatmap.
 *
 * The grid always spans a full calendar year so the strip keeps one shape all
 * year round. Days we hold nothing for — before the first cached game, and
 * after today — are drawn as faint "no data" cells rather than being left
 * blank, which made the year look truncated partway through.
 */
@Component({
  selector: 'app-activity-heatmap',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
  template: `
    <div class="activity">
      @if (years().length > 1) {
        <div class="years" role="tablist" aria-label="Activity year">
          @for (y of years(); track y) {
            <button
              type="button"
              role="tab"
              class="year"
              [class.active]="y === year()"
              [attr.aria-selected]="y === year()"
              (click)="yearChange.emit(y)"
            >
              {{ y }}
            </button>
          }
        </div>
      }

      <div class="grid-wrap">
        <div class="months" [style.--cols]="weeks().length">
          @for (label of monthLabels(); track label.index) {
            <span class="month" [style.grid-column-start]="label.index + 1">{{ label.label }}</span>
          }
        </div>

        <div class="grid" (mouseleave)="hovered.set(null)">
          @for (week of weeks(); track $index) {
            <div class="week">
              @for (day of week; track $index) {
                <div
                  class="cell"
                  [class.no-data]="day.untracked || day.future"
                  [class.empty]="!day.games && !day.untracked && !day.future"
                  [style.background]="cellColor(day)"
                  [attr.aria-label]="describe(day)"
                  (mouseenter)="hovered.set(day)"
                ></div>
              }
            </div>
          }
        </div>
      </div>

      <footer class="legend-row">
        <div class="detail" [class.visible]="!!hovered()">
          @if (hovered(); as day) {
            <span class="detail-date">{{ day.date | date: 'EEE d MMM y' }}</span>
            @if (day.untracked || day.future) {
              <span class="detail-muted">No Data</span>
            } @else if (day.games === 0 && day.lpChange === null) {
              <span class="detail-muted">No games</span>
            } @else {
              @if (day.games) {
                <span class="detail-games">
                  {{ day.games }} {{ day.games === 1 ? 'game' : 'games' }}
                </span>
              }
              <!-- Only cached games carry a result, so a day known only from the
                   rank series shows its LP and says nothing it cannot know. -->
              @if (!day.estimated && day.games) {
                <span class="detail-wl">
                  <b class="w">{{ day.wins }}W</b> <b class="l">{{ day.losses }}L</b>
                </span>
                <span
                  class="detail-rate"
                  [class.up]="day.wins > day.losses"
                  [class.down]="day.wins < day.losses"
                >
                  {{ (day.wins / day.games) * 100 | number: '1.0-0' }}%
                </span>
              }
              @if (day.lpChange !== null) {
                <span
                  class="detail-lp"
                  [class.up]="day.lpChange > 0"
                  [class.down]="day.lpChange < 0"
                >
                  {{ day.lpChange > 0 ? '+' : '' }}{{ day.lpChange }} LP
                </span>
              }
              @if (day.rank; as rank) {
                <span class="detail-rank">{{ rankLabel(rank) }}</span>
              }
              @if (day.inactive) {
                <span class="detail-muted" title="Riot flagged this account as decaying">
                  decay
                </span>
              }
            }
          } @else {
            <span class="detail-hint">Hover a day for games, record and LP</span>
          }
        </div>

        <div class="legend">
          <span class="legend-label">Losing</span>
          <span class="swatch" style="background: #d6455d"></span>
          <span class="swatch" style="background: #a8404f"></span>
          <span class="swatch swatch-empty"></span>
          <span class="swatch" style="background: #2c7a58"></span>
          <span class="swatch" style="background: #35c184"></span>
          <span class="legend-label">Winning</span>
        </div>
      </footer>
    </div>
  `,
  styles: [
    `
      .activity {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .years {
        display: inline-flex;
        align-self: flex-start;
        gap: 2px;
        padding: 3px;
        border-radius: 9px;
        background: var(--muted);
        border: 1px solid var(--border-color);
      }

      .year {
        padding: 3px 11px;
        border: none;
        border-radius: 6px;
        background: transparent;
        color: var(--secondary-text);
        font-size: 10.5px;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        cursor: pointer;
        transition:
          background 0.15s ease,
          color 0.15s ease;
      }

      .year:hover:not(.active) {
        color: var(--primary-text);
      }

      .year.active {
        background: var(--card);
        color: var(--primary-text);
      }

      .grid-wrap {
        overflow-x: auto;
        padding-bottom: 2px;
        scrollbar-width: none;
        -ms-overflow-style: none;
      }

      .grid-wrap::-webkit-scrollbar {
        height: 0;
        display: none;
      }

      /* A full year is 53 columns; cells flex so the grid always fills the
         available width rather than stopping at the last week played. */
      .months {
        display: grid;
        grid-template-columns: repeat(var(--cols), minmax(0, 1fr));
        gap: 2px;
        margin-bottom: 4px;
        min-width: 460px;
      }

      .month {
        grid-row: 1;
        font-size: 9px;
        color: var(--secondary-text);
        white-space: nowrap;
      }

      .grid {
        display: flex;
        gap: 2px;
        width: 100%;
        min-width: 460px;
      }

      .week {
        display: flex;
        flex-direction: column;
        gap: 2px;
        flex: 1 1 0;
        min-width: 0;
      }

      .cell {
        width: 100%;
        aspect-ratio: 1 / 1;
        border-radius: 2px;
        background: var(--muted);
        cursor: default;
        transition: outline-color 0.1s ease;
        outline: 1px solid transparent;
      }

      .cell:hover {
        outline-color: var(--primary-text);
      }

      /* Distinguish "we hold nothing for this day" from "you didn't play".
         Runs to 31 Dec so the year always reads as a complete strip. */
      .cell.no-data {
        background: color-mix(in oklch, var(--muted) 45%, transparent);
        opacity: 0.5;
      }

      .legend-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
      }

      .detail {
        display: flex;
        align-items: baseline;
        gap: 8px;
        font-size: 11px;
        min-height: 16px;
      }

      .detail-date {
        font-weight: 700;
        color: var(--primary-text);
      }

      .detail-games,
      .detail-wl {
        color: var(--secondary-text);
        font-variant-numeric: tabular-nums;
      }

      .detail-wl .w {
        color: #2f9e6f;
      }

      .detail-wl .l {
        color: var(--danger);
        margin-left: 3px;
      }

      .detail-rate {
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        color: var(--secondary-text);
      }

      .detail-rate.up {
        color: #2f9e6f;
      }

      .detail-rate.down {
        color: var(--danger);
      }

      .detail-lp {
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        color: var(--secondary-text);
      }

      .detail-lp.up {
        color: #2f9e6f;
      }

      .detail-lp.down {
        color: var(--danger);
      }

      .detail-rank {
        color: var(--secondary-text);
        opacity: 0.85;
      }

      .detail-muted,
      .detail-hint {
        color: var(--secondary-text);
        opacity: 0.75;
      }

      .legend {
        display: flex;
        align-items: center;
        gap: 3px;
      }

      .legend-label {
        font-size: 9.5px;
        color: var(--secondary-text);
        margin: 0 3px;
      }

      .swatch {
        width: 11px;
        height: 11px;
        border-radius: 3px;
      }

      .swatch-empty {
        background: var(--muted);
      }
    `,
  ],
})
export class ActivityHeatmapComponent {
  weeks = input.required<ActivityDay[][]>();
  monthLabels = input.required<{ index: number; label: string }[]>();
  /** Years with data, newest first. The switcher hides when there's only one. */
  years = input<number[]>([]);
  year = input<number>(new Date().getFullYear());
  /** Games on the year's busiest day, used to scale cell opacity. */
  busiestDay = input<number>(1);

  yearChange = output<number>();

  readonly hovered = signal<ActivityDay | null>(null);

  /**
   * Hue is the day's win/loss balance, opacity is how much was played.
   *
   * Volume is scaled against the year's busiest day rather than a fixed ceiling
   * so the grid reads the same for someone who plays two games a night and
   * someone who plays twenty.
   */
  cellColor(day: ActivityDay): string {
    // Empty string leaves the class-driven "no data" background in place.
    if (day.future || day.untracked || day.games === 0) return '';

    const volume = Math.min(1, day.games / Math.max(1, this.busiestDay()));
    const alpha = 0.32 + volume * 0.68;

    // Days with cached games are coloured by their record. Days known only from
    // the rank series have no record, so LP movement stands in for one — it is
    // the same question ("did the day go well") answered from the other source.
    const balance = day.estimated
      ? Math.sign(day.lpChange ?? 0) * Math.min(1, Math.abs(day.lpChange ?? 0) / 60)
      : (day.wins - day.losses) / day.games;

    // An even day is neither red nor green — it gets a neutral slate so a 3-3
    // session does not have to pick a side.
    if (Math.abs(balance) < 0.001) return `rgba(126, 138, 158, ${alpha})`;

    const strength = 0.45 + Math.abs(balance) * 0.55;
    return balance > 0
      ? `rgba(47, 176, 118, ${alpha * strength})`
      : `rgba(214, 69, 93, ${alpha * strength})`;
  }

  /** "Emerald II 39 LP", or just the tier for apex ranks, which have no division. */
  rankLabel(rank: { tier: string; division: string; leaguePoints: number }): string {
    const tier = rank.tier.charAt(0) + rank.tier.slice(1).toLowerCase();
    const apex = ['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(rank.tier.toUpperCase());
    return apex
      ? `${tier} ${rank.leaguePoints} LP`
      : `${tier} ${rank.division} ${rank.leaguePoints} LP`;
  }

  describe(day: ActivityDay): string {
    const date = day.date.toLocaleDateString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    });
    if (day.future || day.untracked) return `${date}: no data`;
    if (day.games === 0 && day.lpChange === null) return `${date}: no games`;

    const parts: string[] = [];
    if (day.games) parts.push(`${day.games} games`);
    if (!day.estimated && day.games) parts.push(`${day.wins}W ${day.losses}L`);
    if (day.lpChange !== null) {
      parts.push(`${day.lpChange > 0 ? '+' : ''}${day.lpChange} LP`);
    }
    return `${date}: ${parts.join(', ')}`;
  }
}
