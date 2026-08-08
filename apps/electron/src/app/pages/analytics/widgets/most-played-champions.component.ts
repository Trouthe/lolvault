import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ChampionStatRow } from '../models/analytics.types';
import { RiotApiService } from '../../../services/riot-api.service';
import { EmptyStateComponent } from './empty-state.component';

/** Most-played champions with win rate, KDA and CS/m. */
@Component({
  selector: 'app-most-played-champions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, EmptyStateComponent],
  template: `
    @if (rows().length === 0) {
      <app-empty-state inline title="No games in this queue" hint="Try a different queue filter." />
    } @else {
      <ul class="champs">
        @for (row of rows(); track row.champion) {
          <li class="champ">
            <img
              class="champ-icon"
              [src]="icon(row.champion)"
              [alt]="row.champion"
              loading="lazy"
            />

            <div class="champ-body">
              <div class="champ-line">
                <span class="champ-name">{{ row.champion }}</span>
                <span class="champ-games">{{ row.games }}G</span>
              </div>
              <div class="champ-line sub">
                <span class="champ-kda">{{ row.kda | number: '1.2-2' }} KDA</span>
                <span class="champ-cs">{{ row.csPerMin | number: '1.1-1' }} CS/m</span>
              </div>
              <div class="champ-bar">
                <div class="champ-bar-fill" [style.width.%]="row.winRate"></div>
              </div>
            </div>

            <div class="champ-wr" [class.positive]="row.winRate >= 50">
              <span class="champ-wr-pct">{{ row.winRate | number: '1.0-0' }}%</span>
              <span class="champ-wr-record">{{ row.wins }}W {{ row.losses }}L</span>
            </div>
          </li>
        }
      </ul>
    }
  `,
  styles: [
    `
      .champs {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      .champ {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 10px;
        border-radius: 10px;
        background: var(--card);
        border: 1px solid var(--border-color);
      }

      .champ-icon {
        width: 34px;
        height: 34px;
        border-radius: 9px;
        object-fit: cover;
        flex-shrink: 0;
      }

      .champ-body {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 3px;
      }

      .champ-line {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 8px;
      }

      .champ-name {
        font-size: 12.5px;
        font-weight: 600;
        color: var(--primary-text);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .champ-games,
      .champ-kda,
      .champ-cs {
        font-size: 10.5px;
        color: var(--secondary-text);
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }

      .champ-line.sub {
        gap: 10px;
        justify-content: flex-start;
      }

      .champ-bar {
        height: 3px;
        border-radius: 999px;
        background: var(--muted);
        overflow: hidden;
      }

      .champ-bar-fill {
        height: 100%;
        border-radius: 999px;
        background: var(--outline);
      }

      .champ-wr {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 1px;
        flex-shrink: 0;
        color: var(--danger);
      }

      .champ-wr.positive {
        color: #2f9e6f;
      }

      .champ-wr-pct {
        font-size: 13px;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
      }

      .champ-wr-record {
        font-size: 10px;
        color: var(--secondary-text);
        font-variant-numeric: tabular-nums;
      }
    `,
  ],
})
export class MostPlayedChampionsComponent {
  private riotApi = inject(RiotApiService);

  rows = input.required<ChampionStatRow[]>();

  icon(champion: string): string {
    return this.riotApi.getChampionIconUrl(champion);
  }
}
