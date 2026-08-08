import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AnalyticsDataService } from '../../services/analytics-data.service';
import { MatchAggregationService } from '../../services/match-aggregation.service';
import {
  PlayedWithMode,
  QUEUE_FILTER_LABELS,
  QueueFilter,
} from '../../models/analytics.types';
import { EmptyStateComponent } from '../../widgets/empty-state.component';
import {
  SegmentOption,
  SegmentedToggleComponent,
} from '../../widgets/segmented-toggle.component';
import { LpClimbChartComponent } from '../../widgets/lp-climb-chart.component';
import { RolePerformanceComponent } from '../../widgets/role-performance.component';
import { MostPlayedChampionsComponent } from '../../widgets/most-played-champions.component';
import { PlayedWithPanelComponent } from '../../widgets/played-with-panel.component';
import { MatchCardComponent } from '../../match/match-card.component';

@Component({
  selector: 'app-overview-screen',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    EmptyStateComponent,
    SegmentedToggleComponent,
    LpClimbChartComponent,
    RolePerformanceComponent,
    MostPlayedChampionsComponent,
    PlayedWithPanelComponent,
    MatchCardComponent,
  ],
  templateUrl: './overview-screen.component.html',
  styleUrl: './overview-screen.component.scss',
})
export class OverviewScreenComponent {
  readonly data = inject(AnalyticsDataService);
  readonly agg = inject(MatchAggregationService);

  readonly champQueue = signal<QueueFilter>('all');
  readonly playedWithMode = signal<PlayedWithMode>('with');
  readonly matchLimit = signal(10);
  readonly expandedMatchId = signal<string | null>(null);

  readonly queueOptions: SegmentOption<QueueFilter>[] = (
    ['all', 'solo', 'flex', 'normal'] as QueueFilter[]
  ).map((value) => ({ value, label: QUEUE_FILTER_LABELS[value] }));

  readonly playedWithOptions: SegmentOption<PlayedWithMode>[] = [
    { value: 'with', label: 'Played with' },
    { value: 'against', label: 'Played against' },
  ];

  readonly matches = computed(() =>
    [...this.data.matches()].sort((a, b) => b.timestamp - a.timestamp)
  );

  readonly visibleMatches = computed(() => this.matches().slice(0, this.matchLimit()));

  readonly hasMore = computed(() => this.matches().length > this.matchLimit());

  readonly roleRows = computed(() => this.agg.rolePerformance(this.matches()));

  readonly mostPlayed = computed(() =>
    this.agg.mostPlayed(this.agg.filterByQueue(this.matches(), this.champQueue()), 5)
  );

  readonly playedWithRows = computed(() => {
    const puuid = this.data.puuid();
    if (!puuid) return [];
    return this.agg.playedWith(this.matches(), puuid, this.playedWithMode()).slice(0, 6);
  });

  /** Sample size backing the played-with panel, stated explicitly in the UI. */
  readonly sampleSize = computed(() => this.matches().length);

  readonly recentForm = computed(() => {
    const recent = this.matches().slice(0, 20).filter((m) => m.win !== null);
    if (!recent.length) return null;
    const wins = recent.filter((m) => m.win === 1).length;
    return { wins, losses: recent.length - wins, games: recent.length, winRate: (wins / recent.length) * 100 };
  });

  toggleMatch(matchId: string): void {
    this.expandedMatchId.update((v) => (v === matchId ? null : matchId));
  }

  loadMore(): void {
    this.matchLimit.update((v) => v + 10);
  }
}
