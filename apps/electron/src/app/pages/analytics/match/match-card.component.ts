import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { CompactTimeline, MatchCacheRow, MatchDetail } from '../../../../types/electron';
import { AnalyticsDataService } from '../services/analytics-data.service';
import { MatchAggregationService } from '../services/match-aggregation.service';
import { RiotApiService } from '../../../services/riot-api.service';
import { MatchTab } from '../models/analytics.types';
import {
  SegmentOption,
  SegmentedToggleComponent,
} from '../widgets/segmented-toggle.component';
import { MatchOverviewTabComponent } from './tabs/match-overview-tab.component';
import { MatchPerformanceTabComponent } from './tabs/match-performance-tab.component';
import { MatchDamageTabComponent } from './tabs/match-damage-tab.component';
import { MatchBuildTabComponent } from './tabs/match-build-tab.component';

const QUEUE_NAMES: Record<number, string> = {
  400: 'Normal Draft',
  420: 'Solo/Duo',
  430: 'Normal Blind',
  440: 'Flex 5v5',
  450: 'ARAM',
  1700: 'Arena',
};

@Component({
  selector: 'app-match-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    SegmentedToggleComponent,
    MatchOverviewTabComponent,
    MatchPerformanceTabComponent,
    MatchDamageTabComponent,
    MatchBuildTabComponent,
  ],
  templateUrl: './match-card.component.html',
  styleUrl: './match-card.component.scss',
})
export class MatchCardComponent {
  private riotApi = inject(RiotApiService);
  private data = inject(AnalyticsDataService);
  readonly agg = inject(MatchAggregationService);

  match = input.required<MatchCacheRow>();
  expanded = input.required<boolean>();

  /** Named `toggled` rather than `toggle` to avoid shadowing the native event. */
  toggled = output<void>();

  readonly activeTab = signal<MatchTab>('overview');
  readonly detail = signal<MatchDetail | null>(null);
  readonly timeline = signal<CompactTimeline | null>(null);
  readonly loadingDetail = signal(false);
  readonly detailFailed = signal(false);

  readonly tabs: SegmentOption<MatchTab>[] = [
    { value: 'overview', label: 'Overview' },
    { value: 'performance', label: 'Performance' },
    { value: 'damage', label: 'Damage' },
    { value: 'build', label: 'Build' },
  ];

  constructor() {
    // Detail and timeline are fetched only when a card is actually opened —
    // eagerly loading them for every match would cost minutes of rate budget.
    effect(() => {
      if (!this.expanded()) return;
      const matchId = this.match().match_id;
      if (this.detail() || this.loadingDetail()) return;
      void this.loadDetail(matchId);
    });
  }

  private async loadDetail(matchId: string): Promise<void> {
    this.loadingDetail.set(true);
    this.detailFailed.set(false);
    try {
      const [detail, timeline] = await Promise.all([
        this.data.detail(matchId),
        this.data.timeline(matchId),
      ]);
      this.detail.set(detail);
      this.timeline.set(timeline);
      if (!detail) this.detailFailed.set(true);
    } catch {
      this.detailFailed.set(true);
    } finally {
      this.loadingDetail.set(false);
    }
  }

  // ── Derived display values ─────────────────────────────────────────────────

  readonly won = computed(() => this.match().win === 1);
  readonly remake = computed(() => (this.match().duration_seconds ?? 0) < 300);

  readonly outcomeLabel = computed(() => {
    if (this.remake()) return 'Remake';
    if (this.match().win === null) return '—';
    return this.won() ? 'Victory' : 'Defeat';
  });

  readonly queueName = computed(() => {
    const id = this.match().queue_id;
    if (id !== null && id !== undefined && QUEUE_NAMES[id]) return QUEUE_NAMES[id];
    return this.match().queue_type?.replace(/_/g, ' ') ?? 'Match';
  });

  readonly kda = computed(() => {
    const m = this.match();
    const k = m.kills ?? 0;
    const d = m.deaths ?? 0;
    const a = m.assists ?? 0;
    return d === 0 ? k + a : (k + a) / d;
  });

  readonly duration = computed(() => {
    const seconds = this.match().duration_seconds ?? 0;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  });

  readonly timeAgo = computed(() => {
    const diff = Date.now() - this.match().timestamp;
    const minutes = Math.floor(diff / 60_000);
    if (minutes < 60) return `${Math.max(1, minutes)}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    return new Date(this.match().timestamp).toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
    });
  });

  readonly items = computed(() => {
    const raw = this.match().items;
    if (!raw) return [];
    try {
      const parsed: number[] = JSON.parse(raw);
      return parsed.slice(0, 6);
    } catch {
      return [];
    }
  });

  readonly trinket = computed(() => {
    const raw = this.match().items;
    if (!raw) return 0;
    try {
      const parsed: number[] = JSON.parse(raw);
      return parsed[6] ?? 0;
    } catch {
      return 0;
    }
  });

  /** Kill participation needs teammate kills, available from the cached summary. */
  readonly killParticipation = computed(() => {
    const m = this.match();
    const participants = this.agg.participantsOf(m);
    const me = participants.find((p) => p.puuid === m.puuid);
    if (!me) return null;
    const teamKills = participants
      .filter((p) => p.teamId === me.teamId)
      .reduce((n, p) => n + p.kills, 0);
    if (!teamKills) return null;
    return ((me.kills + me.assists) / teamKills) * 100;
  });

  readonly teams = computed(() => {
    const m = this.match();
    const participants = this.agg.participantsOf(m);
    const me = participants.find((p) => p.puuid === m.puuid);
    if (!me) return { allies: [], enemies: [] };
    return {
      allies: participants.filter((p) => p.teamId === me.teamId),
      enemies: participants.filter((p) => p.teamId !== me.teamId),
    };
  });

  championIcon(name: string): string {
    return this.riotApi.getChampionIconUrl(name);
  }

  itemIcon(id: number): string {
    return this.riotApi.getItemIconUrl(id);
  }

  onToggle(): void {
    this.toggled.emit();
  }

  setTab(tab: MatchTab): void {
    this.activeTab.set(tab);
  }
}
