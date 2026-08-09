import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RecentGame } from '../models/analytics.types';

const RADIUS = 26;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * Win-rate dial with the recent-result strip beneath it.
 *
 * MVP games sweep through the spectrum — MVP is our own rating's top score on
 * the winning team (Riot exposes no MVP flag), so it reads as a highlight
 * rather than an official award.
 */
@Component({
  selector: 'app-win-rate-dial',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
  template: `
    <div class="dial-card">
      <div class="dial">
        <svg viewBox="0 0 64 64" aria-hidden="true">
          <circle class="dial-track" cx="32" cy="32" r="26" />
          <circle
            class="dial-fill"
            [class.positive]="winRate() >= 50"
            cx="32"
            cy="32"
            r="26"
            [attr.stroke-dasharray]="dash()"
          />
        </svg>
        <span class="dial-value">{{ winRate() | number: '1.0-0' }}%</span>
      </div>

      <div class="dial-meta">
        <span class="record">
          <b class="wins">{{ wins() }}W</b>
          <span class="dot">·</span>
          <b class="losses">{{ losses() }}L</b>
        </span>

        <ol class="strip" [attr.aria-label]="'Last ' + games().length + ' results, newest last'">
          @for (game of ordered(); track game.matchId) {
            <li
              class="pip"
              [class.win]="game.win"
              [class.loss]="!game.win"
              [class.mvp]="game.mvp"
              [title]="tooltip(game)"
            ></li>
          }
        </ol>

        @if (mvpCount() > 0) {
          <span class="mvp-count">{{ mvpCount() }} MVP</span>
        }
      </div>
    </div>
  `,
  styles: [
    `
      /* Dial left, record + form strip right — the card stays short so the
         Overview band doesn't grow a column of dead space beside it. */
      .dial-card {
        display: flex;
        flex-direction: row;
        align-items: center;
        gap: 14px;
      }

      .dial {
        position: relative;
        width: 92px;
        height: 92px;
        flex-shrink: 0;
      }

      .dial svg {
        width: 100%;
        height: 100%;
        transform: rotate(-90deg);
      }

      .dial-track {
        fill: none;
        stroke: var(--muted);
        stroke-width: 7;
      }

      .dial-fill {
        fill: none;
        stroke: var(--danger);
        stroke-width: 7;
        stroke-linecap: round;
        transition: stroke-dasharray 0.5s ease;
      }

      .dial-fill.positive {
        stroke: #2f9e6f;
      }

      .dial-value {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 22px;
        font-weight: 700;
        color: var(--primary-text);
        font-variant-numeric: tabular-nums;
      }

      .dial-meta {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 6px;
        min-width: 0;
        flex: 1;
      }

      .record {
        display: flex;
        align-items: baseline;
        gap: 5px;
        font-size: 13px;
        font-variant-numeric: tabular-nums;
      }

      .wins {
        color: #2f9e6f;
      }

      .losses {
        color: var(--danger);
      }

      .dot {
        color: var(--secondary-text);
        opacity: 0.6;
      }

      /* A fixed 10-wide grid: 20 recent games always read as two tidy rows
         rather than reflowing with the card width. */
      .strip {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        grid-template-columns: repeat(10, 10px);
        gap: 3px;
      }

      .pip {
        width: 10px;
        height: 10px;
        border-radius: 2px;
      }

      .pip.win {
        background: #2f9e6f;
      }

      .pip.loss {
        background: #d6455d;
      }

      .pip.mvp {
        background: linear-gradient(115deg, #ff5f6d, #ffc371, #47e08d, #38b6ff, #b06fd6, #ff5f6d);
        background-size: 300% 100%;
        animation: pip-sweep 3.2s linear infinite;
      }

      @keyframes pip-sweep {
        to {
          background-position: -300% 0;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .pip.mvp {
          animation: none;
          background-position: 40% 0;
        }
      }

      .mvp-count {
        font-size: 9.5px;
        font-weight: 700;
        letter-spacing: 0.3px;
        color: var(--secondary-text);
      }
    `,
  ],
})
export class WinRateDialComponent {
  games = input.required<RecentGame[]>();
  wins = input.required<number>();
  losses = input.required<number>();
  winRate = input.required<number>();

  /** Games arrive newest-first; the strip reads left-to-right oldest → newest. */
  readonly ordered = computed(() => [...this.games()].reverse());

  readonly mvpCount = computed(() => this.games().filter((g) => g.mvp).length);

  readonly dash = computed(() => {
    const pct = Math.max(0, Math.min(100, this.winRate()));
    return `${(pct / 100) * CIRCUMFERENCE} ${CIRCUMFERENCE}`;
  });

  tooltip(game: RecentGame): string {
    const date = new Date(game.timestamp).toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
    });
    const result = game.win ? 'Victory' : 'Defeat';
    return game.mvp ? `${result} · MVP · ${date}` : `${result} · ${date}`;
  }
}
