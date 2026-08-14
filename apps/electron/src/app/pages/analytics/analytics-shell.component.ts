import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { Location } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AnalyticsDataService } from './services/analytics-data.service';
import { MatchAggregationService } from './services/match-aggregation.service';
import { MatchScoreService, fromSummary } from './services/match-score.service';
import {
  AnalyticsScreen,
  PINNED_QUEUES,
  PlayedWithMode,
  QUEUE_FILTER_LABELS,
  QueueCard,
  QueueFilter,
  isClashQueue,
  queueTypeLabel,
} from './models/analytics.types';
import { roleIcon, roleLabel } from './services/game-assets';
import { SettingsService } from '../../services/settings.service';
import { RiotApiService } from '../../services/riot-api.service';
import { EmptyStateComponent } from './widgets/empty-state.component';
import { IconComponent } from './widgets/icon.component';
import { SkeletonComponent } from './widgets/skeleton.component';
import { OverviewSkeletonComponent } from './widgets/overview-skeleton.component';
import { absoluteLpToLabel } from './widgets/lp-climb-chart.component';
import { SegmentOption, SegmentedToggleComponent } from './widgets/segmented-toggle.component';
import { QueueCardComponent } from './widgets/queue-card.component';
import { MostPlayedChampionsComponent } from './widgets/most-played-champions.component';
import { PlayedWithPanelComponent } from './widgets/played-with-panel.component';
import { OverviewScreenComponent } from './screens/overview/overview-screen.component';
import { ChampionsScreenComponent } from './screens/champions/champions-screen.component';
import { InsightsScreenComponent } from './screens/insights/insights-screen.component';

@Component({
  selector: 'app-analytics-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    EmptyStateComponent,
    IconComponent,
    SkeletonComponent,
    OverviewSkeletonComponent,
    SegmentedToggleComponent,
    QueueCardComponent,
    MostPlayedChampionsComponent,
    PlayedWithPanelComponent,
    OverviewScreenComponent,
    ChampionsScreenComponent,
    InsightsScreenComponent,
  ],
  templateUrl: './analytics-shell.component.html',
  styleUrl: './analytics-shell.component.scss',
})
export class AnalyticsShellComponent {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private location = inject(Location);

  /** Profiles opened by clicking through, so Back knows if it can step back. */
  private visitedProfiles = 0;
  private settings = inject(SettingsService);
  private riotApi = inject(RiotApiService);
  private scorer = inject(MatchScoreService);

  readonly data = inject(AnalyticsDataService);
  readonly agg = inject(MatchAggregationService);

  readonly screen = signal<AnalyticsScreen>('overview');
  readonly champQueue = signal<QueueFilter>('all');
  readonly playedWithMode = signal<PlayedWithMode>('with');

  readonly screens: { id: AnalyticsScreen; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'champions', label: 'Champions' },
    { id: 'insights', label: 'Analytics' },
  ];

  readonly queueOptions: SegmentOption<QueueFilter>[] = (
    ['all', 'solo', 'flex', 'normal'] as QueueFilter[]
  ).map((value) => ({ value, label: QUEUE_FILTER_LABELS[value] }));

  readonly playedWithOptions: SegmentOption<PlayedWithMode>[] = [
    { value: 'with', label: 'With' },
    { value: 'against', label: 'Against' },
  ];

  readonly sidebarMode = computed(() => this.settings.settings().analyticsLeft === 'sidebar');

  // ── Account identity ───────────────────────────────────────────────────────

  readonly accountName = computed(() => {
    const raw = this.data.account()?.name ?? '';
    const [game, tag] = raw.split('#');
    return { game: game || raw, tag: tag || '' };
  });

  readonly profileIconUrl = computed(() =>
    this.riotApi.getProfileIconUrl(this.data.account()?.profileIconId)
  );

  /** Most-played role across cached games, shown under the account name. */
  readonly mainRole = computed(() => {
    const roles = this.agg.rolePerformance(this.data.matches());
    if (!roles.length) return null;
    const top = roles[0];
    return {
      key: top.roleKey,
      label: roleLabel(top.roleKey),
      icon: roleIcon(top.roleKey),
      share: top.share,
      games: top.games,
    };
  });

  /**
   * Highest rank ever recorded for this account, from the LP snapshot history.
   * Only shown once it beats the current rank — otherwise "peak" would just
   * restate what the rank card already says.
   */
  readonly peakRank = computed(() => {
    // The two halves of that comparison arrive at different times: snapshots
    // come from the local database, the current rank from Riot a moment later.
    // Deciding before both are in made the badge appear and then vanish as the
    // rank landed and revealed the peak was not a peak after all.
    if (this.data.loading()) return null;

    const snaps = this.data.lpSnapshots();
    if (!snaps.length) return null;

    const best = snaps.reduce((a, b) => (b.absolute_lp > a.absolute_lp ? b : a));
    const current = this.soloCurrentAbsoluteLp();
    if (current !== null && best.absolute_lp <= current) return null;

    const label = absoluteLpToLabel(best.absolute_lp);
    const [tier, division] = label.split(' ');
    const roman: Record<string, string> = { IV: '4', III: '3', II: '2', I: '1' };

    return {
      full: label,
      short: `${tier?.charAt(0) ?? ''}${roman[division] ?? ''}`,
      emblem: tier ? `assets/emblems/${tier}.png` : '',
      when: new Date(best.timestamp).toLocaleDateString(undefined, {
        month: 'short',
        year: 'numeric',
      }),
    };
  });

  /** Current solo-queue rank on the same absolute LP scale as the snapshots. */
  private readonly soloCurrentAbsoluteLp = computed(() => {
    const solo = this.data.ranked().find((e) => e.queueType === 'RANKED_SOLO_5x5');
    if (!solo?.tier) return null;

    const tiers = [
      'IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM',
      'EMERALD', 'DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER',
    ];
    const divisions: Record<string, number> = { IV: 0, III: 100, II: 200, I: 300 };
    const tierIndex = tiers.indexOf(solo.tier.toUpperCase());
    if (tierIndex < 0) return null;

    return tierIndex * 400 + (divisions[solo.rank?.toUpperCase() ?? ''] ?? 0) + solo.leaguePoints;
  });

  // ── Ranked queues ──────────────────────────────────────────────────────────

  /**
   * Pinned queues always render (so the card exists to expand from day one),
   * plus any other ranked queue the API returns. Clash is excluded outright.
   */
  readonly queueCards = computed<QueueCard[]>(() => {
    const entries = this.data.ranked().filter((e) => !isClashQueue(e.queueType));
    const byType = new Map(entries.map((e) => [e.queueType, e]));

    const build = (queueType: string, label: string): QueueCard => {
      const e = byType.get(queueType);
      const games = e ? e.wins + e.losses : 0;
      return {
        queueType,
        label,
        tier: e?.tier ?? '',
        rank: e?.rank ?? '',
        leaguePoints: e?.leaguePoints ?? 0,
        wins: e?.wins ?? 0,
        losses: e?.losses ?? 0,
        winRate: games ? ((e?.wins ?? 0) / games) * 100 : 0,
        games,
        ranked: !!e?.tier,
      };
    };

    const cards = PINNED_QUEUES.map((q) => build(q.queueType, q.label));
    const pinned = new Set(PINNED_QUEUES.map((q) => q.queueType));
    for (const e of entries) {
      if (pinned.has(e.queueType)) continue;
      cards.push(build(e.queueType, queueTypeLabel(e.queueType)));
    }
    return cards;
  });

  /** Solo/duo starts expanded; everything else is collapsed. */
  readonly openQueues = signal<Record<string, boolean>>({ RANKED_SOLO_5x5: true });

  isQueueOpen(queueType: string): boolean {
    return !!this.openQueues()[queueType];
  }

  setQueueOpen(queueType: string, open: boolean): void {
    this.openQueues.update((state) => ({ ...state, [queueType]: open }));
  }

  /** LP snapshots only track solo/duo today, so other queues get none. */
  /**
   * Recorded days for one queue's card.
   *
   * Was solo-only, because the old `lp_snapshots` table had no queue column and
   * everything in it was assumed to be solo — so the flex card could never show
   * a trend no matter how much flex was played. The daily series is keyed by
   * queue, so each card now gets its own history.
   */
  snapshotsFor(queueType: string) {
    return this.data.rankSnapshots().filter((s) => s.queue === queueType);
  }

  // ── Rail panels ────────────────────────────────────────────────────────────

  readonly mostPlayed = computed(() =>
    this.agg.mostPlayed(this.agg.filterByQueue(this.data.matches(), this.champQueue()), 5)
  );

  readonly playedWithRows = computed(() => {
    const puuid = this.data.puuid();
    if (!puuid) return [];
    return this.agg.playedWith(this.data.matches(), puuid, this.playedWithMode()).slice(0, 5);
  });

  readonly sampleSize = computed(() => this.data.matches().length);

  constructor() {
    // Two shapes of route share this shell: one of our own vault entries, and
    // an arbitrary player clicked through to from a match. Re-reading the
    // params on every navigation matters because Angular reuses the component
    // when you hop straight from one profile to another.
    this.route.paramMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      const puuid = params.get('puuid');
      this.data.reset();
      this.screen.set('overview');

      if (puuid) {
        const platform = params.get('platform') ?? 'euw1';
        const name = this.route.snapshot.queryParamMap.get('name') ?? '';
        this.visitedProfiles++;
        void this.data.loadPlayer(puuid, platform, name);
      } else {
        void this.data.load(params.get('vaultId') ?? '');
      }
    });
  }

  setScreen(screen: AnalyticsScreen): void {
    this.screen.set(screen);
  }

  /**
   * Someone else's profile is a detour, so it steps back to wherever you came
   * from; a vault account is a destination, so it returns to the dashboard.
   */
  /** Leaves the click-through trail outright, however deep it goes. */
  goHome(): void {
    void this.router.navigate(['/dashboard']);
  }

  goBack(): void {
    // `visited` only counts profiles opened inside this session, so a page
    // reached by reload or deep link still has somewhere sensible to go.
    if (this.data.external() && this.visitedProfiles > 0) {
      this.visitedProfiles--;
      this.location.back();
      return;
    }
    void this.router.navigate(['/dashboard']);
  }

  /** Rates a cached match from its participant summary, for MVP detection. */
  scoreOf(matchId: string) {
    const row = this.data.matches().find((m) => m.match_id === matchId);
    if (!row) return null;
    const participants = this.agg.participantsOf(row);
    if (!participants.length) return null;
    const scoreable = participants.map((p, i) => fromSummary(p, i + 1));
    return this.scorer.score(scoreable, row.duration_seconds ?? 0, `sum:${matchId}`)
      .byPuuid[row.puuid ?? ''];
  }
}
