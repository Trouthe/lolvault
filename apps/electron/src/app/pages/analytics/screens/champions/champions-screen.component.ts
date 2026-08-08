import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AnalyticsDataService } from '../../services/analytics-data.service';
import { MatchAggregationService } from '../../services/match-aggregation.service';
import { RiotApiService } from '../../../../services/riot-api.service';
import { EmptyStateComponent } from '../../widgets/empty-state.component';
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
  | 'goldDiff15';

/** A matchup row: how this champion performed against a specific opponent. */
interface MatchupRow {
  opponent: string;
  games: number;
  wins: number;
  winRate: number;
  goldDiff15: number | null;
}

@Component({
  selector: 'app-champions-screen',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, EmptyStateComponent, SegmentedToggleComponent],
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

    return [...stats].sort((a, b) => {
      const av = a[col];
      const bv = b[col];
      // Champions without timeline-derived gold diff sort last either way,
      // rather than being treated as a real 0.
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return (av - bv) * dir;
    });
  });

  /** Opponent breakdown for one champion, from the cached participant summaries. */
  readonly matchupsFor = computed(() => {
    const champion = this.expanded();
    if (!champion) return [];

    const selfPuuid = this.data.puuid();
    if (!selfPuuid) return [];

    const map = new Map<string, { games: number; wins: number; diffSum: number; diffN: number }>();

    for (const m of this.filteredMatches()) {
      if (m.champion !== champion) continue;
      const participants = this.agg.participantsOf(m);
      const me = participants.find((p) => p.puuid === selfPuuid);
      if (!me?.teamPosition) continue;

      const opponent = participants.find(
        (p) => p.teamId !== me.teamId && p.teamPosition === me.teamPosition
      );
      if (!opponent?.championName) continue;

      const e = map.get(opponent.championName) ?? { games: 0, wins: 0, diffSum: 0, diffN: 0 };
      e.games++;
      if (m.win === 1) e.wins++;
      if (m.gold_diff_15 !== null && m.gold_diff_15 !== undefined) {
        e.diffSum += m.gold_diff_15;
        e.diffN++;
      }
      map.set(opponent.championName, e);
    }

    return [...map.entries()]
      .map(([opponent, e]): MatchupRow => ({
        opponent,
        games: e.games,
        wins: e.wins,
        winRate: (e.wins / e.games) * 100,
        goldDiff15: e.diffN > 0 ? e.diffSum / e.diffN : null,
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

  /** Formats a gold diff with an explicit sign; em dash when unavailable. */
  formatDiff(value: number | null): string {
    if (value === null) return '—';
    const rounded = Math.round(value);
    return rounded > 0 ? `+${rounded}` : `${rounded}`;
  }

  trackChampion(_index: number, row: ChampionStatRow): string {
    return row.champion;
  }
}
