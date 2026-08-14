import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatchCacheRow } from '../../../../../types/electron';
import { AnalyticsDataService } from '../../services/analytics-data.service';
import { MatchAggregationService } from '../../services/match-aggregation.service';
import { MatchScoreService, fromSummary } from '../../services/match-score.service';
import { EmptyStateComponent } from '../../widgets/empty-state.component';
import { IconComponent } from '../../widgets/icon.component';
import { WinRateDialComponent } from '../../widgets/win-rate-dial.component';
import { RolePerformanceComponent } from '../../widgets/role-performance.component';
import { ActivityHeatmapComponent } from '../../widgets/activity-heatmap.component';
import { MostPlayedChampionsComponent } from '../../widgets/most-played-champions.component';
import { MasteryPodiumComponent } from '../../widgets/mastery-podium.component';
import { HistoryDepthComponent } from '../../widgets/history-depth.component';
import { LpClimbChartComponent } from '../../widgets/lp-climb-chart.component';
import { MatchCardComponent } from '../../match/match-card.component';
import { BackfillControlComponent } from '../../widgets/backfill-control.component';
import { SegmentOption, SegmentedToggleComponent } from '../../widgets/segmented-toggle.component';
import { queueName } from '../../models/analytics.types';

@Component({
  selector: 'app-overview-screen',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    EmptyStateComponent,
    IconComponent,
    WinRateDialComponent,
    RolePerformanceComponent,
    ActivityHeatmapComponent,
    MostPlayedChampionsComponent,
    MasteryPodiumComponent,
    HistoryDepthComponent,
    LpClimbChartComponent,
    MatchCardComponent,
    BackfillControlComponent,
    SegmentedToggleComponent,
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

  /**
   * Net LP across the recorded series, for the panel header.
   *
   * Labelled with the date the series *starts*, not with how many rows it has.
   * "over 4 days" was read as "in the last four days" when it actually meant
   * "across the four days we happened to record" — for an account first seen in
   * June and next seen in August, that is a two-month gain described as four
   * days of work. Naming the start date cannot be misread that way.
   *
   * Null until there are two days to compare.
   */
  readonly rankTrend = computed<{ net: number; since: string } | null>(() => {
    const all = this.data.rankSnapshots();

    // Measure from the start of the *current* ladder. Spanning a split reset
    // would subtract last season's rank from this one and call the difference
    // progress — the same mistake `difference` avoids per-row.
    const lastReset = all.map((s) => s.series_start).lastIndexOf(1);
    const series = lastReset > 0 ? all.slice(lastReset) : all;
    if (series.length < 2) return null;

    const first = series[0];
    const last = series[series.length - 1];
    const [y, m, d] = first.day.split('-').map(Number);

    return {
      net: last.score - first.score,
      since: new Date(y, m - 1, d).toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
      }),
    };
  });

  /** Selected queue id, or `all`. Everything on this screen respects it. */
  readonly queueFilter = signal<number | 'all'>('all');

  /**
   * Queue tabs built from the games actually cached, most-played first, rather
   * than from a fixed list. A ranked-only account should not be offered an ARAM
   * tab that selects nothing, and an account with ten queues should not have
   * seven of them hidden behind a hardcoded four.
   */
  readonly queueOptions = computed<SegmentOption<number | 'all'>[]>(() => {
    const counts = new Map<number, { label: string; games: number }>();

    for (const match of this.data.matches()) {
      if (match.queue_id === null || match.queue_id === undefined) continue;
      const entry = counts.get(match.queue_id) ?? {
        label: queueName(match.queue_id, match.queue_type),
        games: 0,
      };
      entry.games++;
      counts.set(match.queue_id, entry);
    }

    const options: SegmentOption<number | 'all'>[] = [{ value: 'all', label: 'All' }];
    if (counts.size < 2) return options;

    for (const [queueId, entry] of [...counts].sort((a, b) => b[1].games - a[1].games)) {
      options.push({ value: queueId, label: entry.label });
    }
    return options;
  });

  readonly matches = computed(() => {
    const filter = this.queueFilter();
    const rows =
      filter === 'all'
        ? this.data.matches()
        : this.data.matches().filter((m) => m.queue_id === filter);
    return [...rows].sort((a, b) => b.timestamp - a.timestamp);
  });

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

  /** Selected heatmap year; defaults to the most recent year with data. */
  readonly activityYear = signal<number | null>(null);

  /**
   * Games the heatmap reports on: ranked solo/duo, always.
   *
   * Deliberately not tied to the queue toggle above it. The grid is a record of
   * a climb, and a climb happens in one queue — mixing ARAM and normals into it
   * turns "how did the season go" into "how often did I open the game", which
   * the match list already answers. Fixing the queue also makes filling the
   * grid dramatically cheaper: the year sweep can ask Riot for queue 420 alone
   * instead of listing every mode and paying a request for games the grid would
   * not count. The (i) beside the title says so on screen.
   */
  readonly rankedMatches = computed(() =>
    this.agg.filterByQueue(this.data.matches(), 'solo')
  );

  // Years come from the unfiltered pool: switching to ARAM should not make a
  // year vanish from the picker just because it holds no ARAM games.
  readonly activityYears = computed(() => this.agg.activityYears(this.data.matches()));

  readonly selectedYear = computed(
    () => this.activityYear() ?? this.activityYears()[0] ?? new Date().getFullYear()
  );

  readonly activity = computed(() =>
    this.agg.activityGrid(this.rankedMatches(), this.selectedYear())
  );

  /**
   * Top three champions. Three rather than the rail's five: this panel shares a
   * column with the mastery podium, and together they have to stand exactly as
   * tall as the five-lane Roles panel beside them.
   */
  readonly topChampions = computed(() => this.agg.mostPlayed(this.matches(), 3));

  setQueueFilter(value: number | 'all'): void {
    this.queueFilter.set(value);
    // A narrower pool almost always means fewer games than are on screen.
    this.matchLimit.set(10);
    this.expandedMatchId.set(null);
  }

  toggleMatch(matchId: string): void {
    this.expandedMatchId.update((v) => (v === matchId ? null : matchId));
  }

  loadMore(): void {
    this.matchLimit.update((v) => v + 10);
  }
}
