import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { AnalyticsDataService } from './services/analytics-data.service';
import { MatchAggregationService } from './services/match-aggregation.service';
import { AnalyticsScreen } from './models/analytics.types';
import { SettingsService } from '../../services/settings.service';
import { RiotApiService } from '../../services/riot-api.service';
import { EmptyStateComponent } from './widgets/empty-state.component';
import { OverviewScreenComponent } from './screens/overview/overview-screen.component';
import { ChampionsScreenComponent } from './screens/champions/champions-screen.component';
import { InsightsScreenComponent } from './screens/insights/insights-screen.component';

@Component({
  selector: 'app-analytics-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    EmptyStateComponent,
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
  private settings = inject(SettingsService);
  private riotApi = inject(RiotApiService);

  readonly data = inject(AnalyticsDataService);
  readonly agg = inject(MatchAggregationService);

  readonly screen = signal<AnalyticsScreen>('overview');

  readonly screens: { id: AnalyticsScreen; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'champions', label: 'Champions' },
    { id: 'insights', label: 'Analytics' },
  ];

  readonly sidebarMode = computed(() => this.settings.settings().analyticsLeft === 'sidebar');

  readonly soloQueue = computed(
    () => this.data.ranked().find((e) => e.queueType === 'RANKED_SOLO_5x5') ?? null
  );
  readonly flexQueue = computed(
    () => this.data.ranked().find((e) => e.queueType === 'RANKED_FLEX_SR') ?? null
  );

  readonly accountName = computed(() => {
    const raw = this.data.account()?.name ?? '';
    const [game, tag] = raw.split('#');
    return { game: game || raw, tag: tag || '' };
  });

  readonly profileIconUrl = computed(() =>
    this.riotApi.getProfileIconUrl(this.data.account()?.profileIconId)
  );

  readonly rankEmblemUrl = computed(() => {
    const sq = this.soloQueue();
    if (!sq?.tier) return null;
    const tier = sq.tier.charAt(0).toUpperCase() + sq.tier.slice(1).toLowerCase();
    return `assets/emblems/${tier}.png`;
  });

  readonly rankLabel = computed(() => {
    const sq = this.soloQueue();
    if (!sq) return 'Unranked';
    return `${this.titleCase(sq.tier)} ${sq.rank}`;
  });

  readonly rankSlug = computed(() => (this.soloQueue()?.tier ?? 'unranked').toLowerCase());

  readonly soloRecord = computed(() => {
    const sq = this.soloQueue();
    if (!sq) return null;
    const total = sq.wins + sq.losses;
    return {
      wins: sq.wins,
      losses: sq.losses,
      winRate: total ? (sq.wins / total) * 100 : 0,
      lp: sq.leaguePoints,
      games: total,
    };
  });

  readonly streak = computed(() => this.agg.currentStreak(this.data.matches()));

  constructor() {
    const vaultId = this.route.snapshot.paramMap.get('vaultId') ?? '';
    this.data.reset();
    void this.data.load(vaultId);
  }

  setScreen(screen: AnalyticsScreen): void {
    this.screen.set(screen);
  }

  goBack(): void {
    void this.router.navigate(['/dashboard']);
  }

  private titleCase(value: string): string {
    if (!value) return '';
    return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
  }
}
