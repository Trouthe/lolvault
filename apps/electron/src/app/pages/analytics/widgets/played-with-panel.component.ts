import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { PlayedWithRow, PlayedWithMode } from '../models/analytics.types';
import { RiotApiService } from '../../../services/riot-api.service';
import { EmptyStateComponent } from './empty-state.component';

/**
 * Players seen repeatedly alongside or against the account.
 *
 * Win rate always reads from the account holder's perspective — for opponents
 * it is "how often I won against them", which is the useful direction.
 */
@Component({
  selector: 'app-played-with-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, EmptyStateComponent],
  template: `
    @if (rows().length === 0) {
      <app-empty-state
        inline
        [title]="mode() === 'with' ? 'No recurring teammates' : 'No recurring opponents'"
        [hint]="
          mode() === 'with'
            ? 'Players you queued with at least twice in the last ' + sampleSize() + ' games appear here.'
            : 'Players you faced at least twice in the last ' + sampleSize() + ' games appear here.'
        "
      />
    } @else {
      <ul class="players">
        @for (row of rows(); track row.puuid) {
          <li class="player">
            <div class="player-champs">
              @for (champ of row.championsPlayed.slice(0, 3); track champ) {
                <img class="player-champ" [src]="icon(champ)" [alt]="champ" loading="lazy" />
              }
            </div>

            <div class="player-body">
              <span class="player-name" [title]="row.name + (row.tagline ? '#' + row.tagline : '')">
                {{ row.name }}
                @if (row.tagline) {
                  <span class="player-tag">#{{ row.tagline }}</span>
                }
              </span>
              <span class="player-games">
                {{ row.games }} {{ row.games === 1 ? 'game' : 'games' }}
              </span>
            </div>

            <div class="player-record">
              <span class="player-wr" [class.positive]="row.winRate >= 50">
                {{ row.winRate | number: '1.0-0' }}%
              </span>
              <span class="player-wl">{{ row.wins }}W {{ row.games - row.wins }}L</span>
            </div>
          </li>
        }
      </ul>
    }
  `,
  styles: [
    `
      .players {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 5px;
      }

      .player {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 7px 10px;
        border-radius: 10px;
        background: var(--card);
        border: 1px solid var(--border-color);
      }

      .player-champs {
        display: flex;
        flex-shrink: 0;
      }

      .player-champ {
        width: 26px;
        height: 26px;
        border-radius: 7px;
        object-fit: cover;
        border: 1.5px solid var(--card);
        margin-left: -8px;
      }

      .player-champ:first-child {
        margin-left: 0;
      }

      .player-body {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 1px;
      }

      .player-name {
        font-size: 12px;
        font-weight: 600;
        color: var(--primary-text);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .player-tag {
        font-size: 10px;
        font-weight: 500;
        color: var(--secondary-text);
        opacity: 0.75;
      }

      .player-games {
        font-size: 10.5px;
        color: var(--secondary-text);
        font-variant-numeric: tabular-nums;
      }

      .player-record {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 1px;
        flex-shrink: 0;
      }

      .player-wr {
        font-size: 12.5px;
        font-weight: 700;
        color: var(--danger);
        font-variant-numeric: tabular-nums;
      }

      .player-wr.positive {
        color: #2f9e6f;
      }

      .player-wl {
        font-size: 10px;
        color: var(--secondary-text);
        font-variant-numeric: tabular-nums;
      }
    `,
  ],
})
export class PlayedWithPanelComponent {
  private riotApi = inject(RiotApiService);

  rows = input.required<PlayedWithRow[]>();
  mode = input.required<PlayedWithMode>();
  sampleSize = input.required<number>();

  icon(champion: string): string {
    return this.riotApi.getChampionIconUrl(champion);
  }
}
