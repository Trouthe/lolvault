import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatchCacheRow } from '../../../../../types/electron';
import { AnalyticsDataService } from '../../services/analytics-data.service';
import { MatchAggregationService } from '../../services/match-aggregation.service';
import { MatchScoreService, fromSummary } from '../../services/match-score.service';
import { EmptyStateComponent } from '../../widgets/empty-state.component';
import { WinRateDialComponent } from '../../widgets/win-rate-dial.component';
import { RolePerformanceComponent } from '../../widgets/role-performance.component';
import { LpActivityComponent } from '../../widgets/lp-activity.component';
import { MostPlayedChampionsComponent } from '../../widgets/most-played-champions.component';
import { MatchCardComponent } from '../../match/match-card.component';
import { BackfillControlComponent } from '../../widgets/backfill-control.component';

@Component({
  selector: 'app-overview-screen',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    EmptyStateComponent,
    WinRateDialComponent,
    RolePerformanceComponent,
    LpActivityComponent,
    MostPlayedChampionsComponent,
    MatchCardComponent,
    BackfillControlComponent,
  ],
  templateUrl: './overview-screen.component.html',
  styleUrl: './overview-screen.component.scss',
})
export class OverviewScreenComponent {
  readonly data = inject(AnalyticsDataService);
  readonly agg = inject(MatchAggregationService);
  private scorer = inject(MatchScoreService);

  readonly matchLimit = signal(10);
  readonly expandedMatchId = signal<string | null>(null);

  readonly matches = computed(() =>
    [...this.data.matches()].sort((a, b) => b.timestamp - a.timestamp)
  );

  readonly visibleMatches = computed(() => this.matches().slice(0, this.matchLimit()));
  readonly hasMore = computed(() => this.matches().length > this.matchLimit());

  readonly roleRows = computed(() => this.agg.rolePerformance(this.matches()));

  /**
   * Rates a match from its participant summary so MVP highlighting works
   * without fetching full detail for every game.
   */
  private rate(row: MatchCacheRow) {
    const participants = this.agg.participantsOf(row);
    if (!participants.length || !row.puuid) return null;
    const scoreable = participants.map((p, i) => fromSummary(p, i + 1));
    const scores = this.scorer.score(
      scoreable,
      row.duration_seconds ?? 0,
      `sum:${row.match_id}`
    );
    return scores.byPuuid[row.puuid] ?? null;
  }

  readonly recentRecord = computed(() =>
    this.agg.recentRecord(this.matches(), this.data.puuid() ?? '', (row) => this.rate(row), 20)
  );

  readonly averages = computed(() =>
    this.agg.averages(this.matches(), this.data.puuid() ?? '')
  );

  /** Selected LP-activity year; defaults to the most recent year with data. */
  readonly activityYear = signal<number | null>(null);

  readonly activityYears = computed(() =>
    this.agg.activityYears(this.matches(), this.data.lpSnapshots())
  );

  readonly selectedYear = computed(
    () => this.activityYear() ?? this.activityYears()[0] ?? new Date().getFullYear()
  );

  readonly activity = computed(() =>
    this.agg.activityGrid(this.matches(), this.data.lpSnapshots(), this.selectedYear())
  );

  /** Top three champions, mirroring the rail but scoped to all queues. */
  readonly topChampions = computed(() => this.agg.mostPlayed(this.matches(), 3));

  toggleMatch(matchId: string): void {
    this.expandedMatchId.update((v) => (v === matchId ? null : matchId));
  }

  loadMore(): void {
    this.matchLimit.update((v) => v + 10);
  }
}
