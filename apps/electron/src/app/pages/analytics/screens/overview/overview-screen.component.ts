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
import { MatchCardComponent } from '../../match/match-card.component';
import { BackfillControlComponent } from '../../widgets/backfill-control.component';
import { SegmentOption, SegmentedToggleComponent } from '../../widgets/segmented-toggle.component';
import { MatchDayGroup, queueName } from '../../models/analytics.types';

/**
 * Local 'YYYY-MM-DD' for a date.
 *
 * Matches the key `rank_snapshots.day` is written with in the main process
 * (`database.js` `localDay`), so a day's games and a day's LP reading line up
 * without either side converting. Built by hand rather than via `toISOString`,
 * which would silently shift a late-night session into the next day.
 */
function localDayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

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
   * Solo-queue days only. `rankSnapshots` carries every queue so one IPC call
   * feeds the heatmap, the match-day headers and the rail's per-queue cards;
   * every consumer narrows to the queue it means.
   */
  readonly soloRankSeries = computed(() =>
    this.data.rankSnapshots().filter((s) => s.queue === 'RANKED_SOLO_5x5')
  );

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

  /**
   * Visible matches grouped into the days they were played on.
   *
   * The list is already sorted newest-first, so a single pass produces groups in
   * the right order without a second sort. Day boundaries are local: a game at
   * 01:00 belongs to the night it was played, which is the day the player would
   * name, not the UTC one.
   */
  readonly matchDays = computed<MatchDayGroup<MatchCacheRow>[]>(() => {
    // Solo-queue LP by day. Only ranked solo has a series, so a day of ARAM
    // gets a header with no LP on it rather than a fabricated zero.
    const lpByDay = new Map<string, number>();
    for (const row of this.soloRankSeries()) {
      // A series break is a reset, not a swing — its delta is already zeroed.
      if (!row.series_start) lpByDay.set(row.day, row.difference);
    }

    const groups: MatchDayGroup<MatchCacheRow>[] = [];
    let current: MatchDayGroup<MatchCacheRow> | null = null;
    let scoreSum = 0;
    let scoreCount = 0;

    const closeGroup = () => {
      if (!current) return;
      current.avgScore = scoreCount ? scoreSum / scoreCount : null;
      scoreSum = 0;
      scoreCount = 0;
    };

    for (const match of this.visibleMatches()) {
      const date = new Date(match.timestamp);
      const key = localDayKey(date);

      if (!current || current.key !== key) {
        closeGroup();
        const midnight = new Date(date);
        midnight.setHours(0, 0, 0, 0);
        current = {
          key,
          date: midnight,
          games: [],
          wins: 0,
          losses: 0,
          remakes: 0,
          avgScore: null,
          lpChange: lpByDay.get(key) ?? null,
        };
        groups.push(current);
      }

      current.games.push(match);
      // Remakes are neither a win nor a loss. The threshold is the card's own
      // (`match-card.component.ts` `remake`) rather than a second opinion — a
      // header that counts a game the card below it labels "Remake" as a win is
      // worse than either rule on its own.
      if ((match.duration_seconds ?? 0) < 300) {
        current.remakes++;
      } else if (match.win === 1) current.wins++;
      else if (match.win === 0) current.losses++;

      const rated = this.rate(match);
      if (rated) {
        scoreSum += rated.score;
        scoreCount++;
      }
    }

    closeGroup();
    return groups;
  });

  /** "Today", "Yesterday", or "06 Aug" — with the year once it stops being obvious. */
  dayLabel(date: Date): string {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const days = Math.round((today.getTime() - date.getTime()) / 86_400_000);

    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';

    return date.toLocaleDateString(undefined, {
      day: '2-digit',
      month: 'short',
      ...(date.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
    });
  }

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
  // year vanish from the picker just because it holds no ARAM games. The rank
  // series counts too, so a year the recorder covered is offered even when no
  // game from it has been pulled yet.
  readonly activityYears = computed(() =>
    this.agg.activityYears(this.data.matches(), this.soloRankSeries())
  );

  readonly selectedYear = computed(
    () => this.activityYear() ?? this.activityYears()[0] ?? new Date().getFullYear()
  );

  /**
   * The grid reads both sources: cached ranked games for the record, and the
   * daily rank series for LP and for days no game was ever cached. The series
   * is solo-queue only, matching the games the grid counts — every ladder
   * sweep and every recorder pass adds to it.
   */
  readonly activity = computed(() =>
    this.agg.activityGrid(this.rankedMatches(), this.selectedYear(), this.soloRankSeries())
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
