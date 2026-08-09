import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AnalyticsDataService } from '../../services/analytics-data.service';
import { MatchAggregationService } from '../../services/match-aggregation.service';
import { RiotApiService } from '../../../../services/riot-api.service';
import { EmptyStateComponent } from '../../widgets/empty-state.component';
import { IconComponent } from '../../widgets/icon.component';
import {
  SegmentOption,
  SegmentedToggleComponent,
} from '../../widgets/segmented-toggle.component';
import { ChampionStatRow, QUEUE_FILTER_LABELS, QueueFilter } from '../../models/analytics.types';

type SortColumn =
  | 'games'
  | 'winRate'
  | 'kda'
  | 'damagePerMin'
  | 'damageTakenPerMin'
  | 'csPerMin'
  | 'pentaKills';

/** A matchup row: how this champion performed against a specific opponent. */
interface MatchupRow {
  opponent: string;
  games: number;
  wins: number;
  winRate: number;
}

@Component({
  selector: 'app-champions-screen',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, EmptyStateComponent, SegmentedToggleComponent, IconComponent],
  templateUrl: './champions-screen.component.html',
  styleUrl: './champions-screen.component.scss',
})
export class ChampionsScreenComponent {
  private riotApi = inject(RiotApiService);
  readonly data = inject(AnalyticsDataService);
  readonly agg = inject(MatchAggregationService);

  readonly queueFilter = signal<QueueFilter>('all');
  readonly sortColumn = signal<SortColumn>('games');
  readonly sortDesc = signal(true);
  readonly search = signal('');
  readonly expanded = signal<string | null>(null);

  readonly queueOptions: SegmentOption<QueueFilter>[] = (
    ['all', 'solo', 'flex', 'normal'] as QueueFilter[]
  ).map((value) => ({ value, label: QUEUE_FILTER_LABELS[value] }));

  private readonly filteredMatches = computed(() =>
    this.agg.filterByQueue(this.data.matches(), this.queueFilter())
  );

  readonly overall = computed(() => this.agg.overallStats(this.filteredMatches()));

  readonly rows = computed(() => {
    const term = this.search().trim().toLowerCase();
    const stats = this.agg
      .championStats(this.filteredMatches())
      .filter((c) => !term || c.champion.toLowerCase().includes(term));

    const col = this.sortColumn();
    const dir = this.sortDesc() ? -1 : 1;

    return [...stats].sort((a, b) => (a[col] - b[col]) * dir);
  });

  /** Opponent breakdown for one champion, from the cached participant summaries. */
  readonly matchupsFor = computed(() => {
    const champion = this.expanded();
    if (!champion) return [];

    const selfPuuid = this.data.puuid();
    if (!selfPuuid) return [];

    const map = new Map<string, { games: number; wins: number }>();

    for (const m of this.filteredMatches()) {
      if (m.champion !== champion) continue;
      const participants = this.agg.participantsOf(m);
      const me = participants.find((p) => p.puuid === selfPuuid);
      if (!me?.teamPosition) continue;

      const opponent = participants.find(
        (p) => p.teamId !== me.teamId && p.teamPosition === me.teamPosition
      );
      if (!opponent?.championName) continue;

      const e = map.get(opponent.championName) ?? { games: 0, wins: 0 };
      e.games++;
      if (m.win === 1) e.wins++;
      map.set(opponent.championName, e);
    }

    return [...map.entries()]
      .map(([opponent, e]): MatchupRow => ({
        opponent,
        games: e.games,
        wins: e.wins,
        winRate: (e.wins / e.games) * 100,
      }))
      .sort((a, b) => b.games - a.games);
  });

  readonly hasMatches = computed(() => this.data.matches().length > 0);

  setSort(col: SortColumn): void {
    if (this.sortColumn() === col) {
      this.sortDesc.update((v) => !v);
    } else {
      this.sortColumn.set(col);
      this.sortDesc.set(true);
    }
  }

  toggleExpanded(champion: string): void {
    this.expanded.update((v) => (v === champion ? null : champion));
  }

  onSearch(event: Event): void {
    this.search.set((event.target as HTMLInputElement).value);
  }

  championIcon(name: string): string {
    return this.riotApi.getChampionIconUrl(name);
  }

  trackChampion(_index: number, row: ChampionStatRow): string {
    return row.champion;
  }
}
