import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivityDay } from '../models/analytics.types';

/**
 * Day-by-day LP/activity grid.
 *
 * The range starts at the first day we actually have data for — a new account
 * shows a short honest strip that grows over time rather than a wall of empty
 * cells implying a year of inactivity. Days before tracking began are rendered
 * distinctly from days that simply had no games.
 */
@Component({
  selector: 'app-lp-activity',
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
                  [class.untracked]="day.untracked"
                  [class.future]="day.future"
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
            @if (day.untracked) {
              <span class="detail-muted">Before tracking started</span>
            } @else if (day.games === 0) {
              <span class="detail-muted">No games</span>
            } @else {
              <span class="detail-games">
                {{ day.games }} {{ day.games === 1 ? 'game' : 'games' }}
              </span>
              <span class="detail-wl">
                <b class="w">{{ day.wins }}W</b> <b class="l">{{ day.losses }}L</b>
              </span>
              @if (day.netLp !== null) {
                <span class="detail-lp" [class.up]="day.netLp > 0" [class.down]="day.netLp < 0">
                  {{ day.netLp > 0 ? '+' : '' }}{{ day.netLp }} LP
                </span>
              } @else {
                <span class="detail-muted">LP not recorded</span>
              }
            }
          } @else {
            <span class="detail-hint">Hover a day for games, record and LP</span>
          }
        </div>

        <div class="legend">
          <span class="legend-label">Loss</span>
          <span class="swatch" style="background: #d6455d"></span>
          <span class="swatch" style="background: #a8404f"></span>
          <span class="swatch swatch-empty"></span>
          <span class="swatch" style="background: #2c7a58"></span>
          <span class="swatch" style="background: #35c184"></span>
          <span class="legend-label">Gain</span>
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

      /* Distinguish "we weren't tracking" from "you didn't play". */
      .cell.untracked {
        background: color-mix(in oklch, var(--muted) 45%, transparent);
        opacity: 0.5;
      }

      .cell.future {
        background: transparent;
        cursor: default;
        pointer-events: none;
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
export class LpActivityComponent {
  weeks = input.required<ActivityDay[][]>();
  monthLabels = input.required<{ index: number; label: string }[]>();
  /** Years with data, newest first. The switcher hides when there's only one. */
  years = input<number[]>([]);
  year = input<number>(new Date().getFullYear());

  yearChange = output<number>();

  readonly hovered = signal<ActivityDay | null>(null);

  /**
   * Colour encodes net LP where we have it, and falls back to win/loss balance
   * where we only know the games played — so a day is never blank just because
   * LP wasn't captured.
   */
  cellColor(day: ActivityDay): string {
    if (day.future || day.untracked) return '';
    if (day.games === 0 && day.netLp === null) return '';

    const value = day.netLp ?? (day.wins - day.losses) * 18;
    if (value === 0) return 'var(--muted)';

    const magnitude = Math.min(Math.abs(value) / 60, 1);
    const alpha = 0.35 + magnitude * 0.65;
    return value > 0 ? `rgba(47, 176, 118, ${alpha})` : `rgba(214, 69, 93, ${alpha})`;
  }

  describe(day: ActivityDay): string {
    const date = day.date.toLocaleDateString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    });
    if (day.future) return '';
    if (day.untracked) return `${date}: before tracking started`;
    if (day.games === 0) return `${date}: no games`;
    const lp = day.netLp !== null ? `, ${day.netLp > 0 ? '+' : ''}${day.netLp} LP` : '';
    return `${date}: ${day.games} games, ${day.wins}W ${day.losses}L${lp}`;
  }
}
