import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MasteryEntry } from '../services/analytics-data.service';
import { ChampionCatalogService } from '../../../services/champion-catalog.service';
import { RiotApiService } from '../../../services/riot-api.service';
import { masteryCrest } from '../services/game-assets';
import { EmptyStateComponent } from './empty-state.component';

interface PodiumItem {
  championId: number;
  name: string;
  icon: string;
  crest: string;
  level: number;
  points: number;
  pointsLabel: string;
  /** The single highest-mastery champion, rendered larger and centred. */
  lead: boolean;
}

/**
 * Top three champion masteries, arranged as a podium: the highest sits in the
 * middle and larger, the runners-up flank it. Each carries its crest and point
 * total, so the panel answers "what does this account actually play" at a
 * glance rather than needing the numbers read in order.
 */
@Component({
  selector: 'app-mastery-podium',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, EmptyStateComponent],
  template: `
    @if (podium().length === 0) {
      <app-empty-state
        inline
        title="No mastery data"
        hint="Champion mastery comes from Riot when this account is opened."
      />
    } @else {
      <ul class="podium">
        @for (item of podium(); track item.championId) {
          <li
            class="slot"
            [class.lead]="item.lead"
            [title]="item.name + ' — mastery ' + item.level + ', ' + item.points + ' points'"
          >
            <img class="champ" [src]="item.icon" [alt]="item.name" loading="lazy" />
            <span class="score">
              <img class="crest" [src]="item.crest" [alt]="'Mastery ' + item.level" />
              <span class="points">{{ item.pointsLabel }}</span>
            </span>
          </li>
        }
      </ul>
    }
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        justify-content: center;
      }

      /* Bottom-aligned so the three score rows share a line and only the lead
         champion's portrait rises above them. */
      .podium {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        align-items: flex-end;
        justify-content: center;
        gap: 14px;
      }

      .slot {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 5px;
        min-width: 0;
      }

      .champ {
        width: 38px;
        height: 38px;
        border-radius: 10px;
        object-fit: cover;
        border: 1px solid var(--border-color);
        background: var(--muted);
        display: block;
      }

      .slot.lead .champ {
        width: 52px;
        height: 52px;
        border-radius: 13px;
        border-color: color-mix(in oklch, var(--tone-gold) 55%, var(--border-color));
        box-shadow: 0 0 0 1px color-mix(in oklch, var(--tone-gold) 22%, transparent);
      }

      .score {
        display: inline-flex;
        align-items: center;
        gap: 3px;
      }

      .crest {
        width: 15px;
        height: 15px;
        object-fit: contain;
        flex-shrink: 0;
      }

      .slot.lead .crest {
        width: 18px;
        height: 18px;
      }

      .points {
        font-size: 10.5px;
        font-weight: 700;
        color: var(--secondary-text);
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }

      .slot.lead .points {
        font-size: 12px;
        color: var(--primary-text);
      }
    `,
  ],
})
export class MasteryPodiumComponent {
  private catalog = inject(ChampionCatalogService);
  private riotApi = inject(RiotApiService);

  entries = input.required<MasteryEntry[]>();

  readonly podium = computed<PodiumItem[]>(() => {
    const top = [...this.entries()]
      .sort((a, b) => b.championPoints - a.championPoints)
      .slice(0, 3);
    if (!top.length) return [];

    const items = top.map((entry, index) => {
      const key = String(entry.championId);
      const championId = this.catalog.getChampionId(key);
      return {
        championId: entry.championId,
        name: championId || `Champion ${entry.championId}`,
        icon: championId ? this.riotApi.getChampionIconUrl(championId) : '',
        crest: masteryCrest(entry.championLevel),
        level: entry.championLevel,
        points: entry.championPoints,
        pointsLabel: compactPoints(entry.championPoints),
        lead: index === 0,
      };
    });

    // Second, first, third — the highest belongs in the middle of a podium.
    return items.length === 3
      ? [items[1], items[0], items[2]]
      : items.length === 2
        ? [items[1], items[0]]
        : items;
  });
}

/** 1_284_301 → "1.28M", 84_120 → "84.1K". */
function compactPoints(points: number): string {
  if (points >= 1_000_000) return `${(points / 1_000_000).toFixed(2)}M`;
  if (points >= 10_000) return `${Math.round(points / 1000)}K`;
  if (points >= 1000) return `${(points / 1000).toFixed(1)}K`;
  return String(points);
}
