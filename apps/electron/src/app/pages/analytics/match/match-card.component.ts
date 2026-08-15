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
import {
  MatchAggregationService,
  ParticipantSummary,
} from '../services/match-aggregation.service';
import { MatchScoreService, fromDetail, fromSummary } from '../services/match-score.service';
import { RiotApiService } from '../../../services/riot-api.service';
import { PlayerNavService } from '../services/player-nav.service';
import { GameDataService } from '../../../services/game-data.service';
import { MatchTab, queueName } from '../models/analytics.types';
import { absoluteLpToTier, absoluteLpToTierLabel } from '../../../models/rank-scale';
import { roleIcon, roleLabel } from '../services/game-assets';
import { SegmentOption, SegmentedToggleComponent } from '../widgets/segmented-toggle.component';
import { IconComponent } from '../widgets/icon.component';
import { MatchOverviewTabComponent } from './tabs/match-overview-tab.component';
import { MatchPerformanceTabComponent } from './tabs/match-performance-tab.component';
import { MatchDamageTabComponent } from './tabs/match-damage-tab.component';
import { MatchBuildTabComponent } from './tabs/match-build-tab.component';
import { MatchMapTabComponent } from './tabs/match-map-tab.component';

/** Root of `raw_json` — the account holder's own full participant record. */
interface SelfRaw {
  summoner1Id?: number;
  summoner2Id?: number;
  champLevel?: number;
  perks?: {
    styles?: { description?: string; style?: number; selections?: { perk: number }[] }[];
  };
  [key: string]: unknown;
}

@Component({
  selector: 'app-match-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    SegmentedToggleComponent,
    IconComponent,
    MatchOverviewTabComponent,
    MatchPerformanceTabComponent,
    MatchDamageTabComponent,
    MatchBuildTabComponent,
    MatchMapTabComponent,
  ],
  templateUrl: './match-card.component.html',
  styleUrl: './match-card.component.scss',
})
export class MatchCardComponent {
  private riotApi = inject(RiotApiService);
  private gameData = inject(GameDataService);
  private data = inject(AnalyticsDataService);
  private scorer = inject(MatchScoreService);
  readonly agg = inject(MatchAggregationService);
  readonly playerNav = inject(PlayerNavService);

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
    { value: 'map', label: 'Map' },
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

  readonly queueName = computed(() => queueName(this.match().queue_id, this.match().queue_type));

  /**
   * Average rank of everyone in the lobby, from the local rank cache.
   *
   * Averaged on the absolute-LP scale, which is the entire reason that scale
   * exists — you cannot take the mean of "Emerald II" and "Platinum I" without
   * first collapsing tier, division and LP into one number.
   *
   * Null until at least half the lobby is known. A "lobby average" computed from
   * two players is not an average of the lobby, and quietly presenting one would
   * be worse than showing nothing: the number would look identical to a real
   * one. `known` is exposed so the badge can say what it is based on.
   */
  readonly averageRank = computed<{ label: string; tier: string; known: number; total: number } | null>(
    () => {
      const participants = this.agg.participantsOf(this.match());
      if (!participants.length) return null;

      const ranks = this.data.playerRanks();
      let sum = 0;
      let known = 0;

      for (const p of participants) {
        const rank = p.puuid ? ranks[p.puuid] : undefined;
        if (!rank) continue;
        sum += rank.score;
        known++;
      }

      if (known < Math.ceil(participants.length / 2)) return null;

      const mean = sum / known;
      return {
        label: absoluteLpToTierLabel(mean),
        tier: absoluteLpToTier(mean),
        known,
        total: participants.length,
      };
    }
  );

  /** Emblem for the averaged tier, matching the rail's naming. */
  readonly averageRankEmblem = computed(() => {
    const avg = this.averageRank();
    if (!avg) return '';
    return `assets/emblems/${avg.tier.charAt(0)}${avg.tier.slice(1).toLowerCase()}.png`;
  });

  /** The account holder's own full participant record, stored on raw_json. */
  private readonly selfRaw = computed<SelfRaw>(() => (this.match().raw_json ?? {}) as SelfRaw);

  readonly summonerSpells = computed(() => {
    const raw = this.selfRaw();
    return [raw.summoner1Id, raw.summoner2Id]
      .filter((id): id is number => typeof id === 'number' && id > 0)
      .map((id) => ({
        id,
        name: this.gameData.getSummonerSpell(id)?.name ?? '',
        icon: this.gameData.getSummonerSpellIconUrl(id),
      }))
      .filter((s) => s.icon);
  });

  /** Keystone + secondary tree, the two rune icons shown on the collapsed row. */
  readonly runeIcons = computed(() => {
    const styles = this.selfRaw().perks?.styles;
    if (!styles?.length) return [];

    const primary = styles.find((s) => s.description === 'primaryStyle') ?? styles[0];
    const secondary = styles.find((s) => s.description === 'subStyle') ?? styles[1];

    const keystoneId = primary?.selections?.[0]?.perk;
    const out: { icon: string; name: string; keystone: boolean }[] = [];

    if (keystoneId) {
      const icon = this.gameData.getRuneIconUrl(keystoneId);
      if (icon) {
        out.push({ icon, name: this.gameData.getRune(keystoneId)?.name ?? '', keystone: true });
      }
    }
    if (secondary?.style) {
      const icon = this.gameData.getRuneIconUrl(secondary.style);
      if (icon) {
        out.push({
          icon,
          name: this.gameData.getRune(secondary.style)?.name ?? '',
          keystone: false,
        });
      }
    }
    return out;
  });

  readonly champLevel = computed(() => this.selfRaw().champLevel ?? 0);

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
      return (JSON.parse(raw) as number[]).slice(0, 6);
    } catch {
      return [];
    }
  });

  readonly trinket = computed(() => {
    const raw = this.match().items;
    if (!raw) return 0;
    try {
      return (JSON.parse(raw) as number[])[6] ?? 0;
    } catch {
      return 0;
    }
  });

  readonly roleIconUrl = computed(() => roleIcon(this.match().position));
  readonly roleName = computed(() => roleLabel(this.match().position));

  /**
   * Performance rating and placement for the account holder.
   *
   * Uses the richer detail-based rating once a card has been expanded, and the
   * always-available participant summary before that, so the badge is present
   * on collapsed cards without costing an API call.
   */
  readonly selfScore = computed(() => {
    const m = this.match();
    if (!m.puuid) return null;

    const detail = this.detail();
    if (detail?.participants?.length) {
      return (
        this.scorer.score(
          detail.participants.map(fromDetail),
          detail.gameDuration ?? m.duration_seconds ?? 0,
          `det:${m.match_id}`
        ).byPuuid[m.puuid] ?? null
      );
    }

    const participants = this.agg.participantsOf(m);
    if (!participants.length) return null;
    return (
      this.scorer.score(
        participants.map((p, i) => fromSummary(p, i + 1)),
        m.duration_seconds ?? 0,
        `sum:${m.match_id}`
      ).byPuuid[m.puuid] ?? null
    );
  });

  readonly isMvp = computed(() => !!this.selfScore()?.isMvp);
  readonly isAce = computed(() => !!this.selfScore()?.isAce);

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

  itemName(id: number): string {
    return this.gameData.getItemName(id);
  }

  onToggle(): void {
    this.toggled.emit();
  }

  /** Opens a roster member's own analytics without expanding the card. */
  openPlayer(event: Event, participant: ParticipantSummary): void {
    if (!this.playerNav.canOpen(participant.puuid)) return;
    event.stopPropagation();
    this.playerNav.open(participant.puuid, participant.riotIdGameName, participant.riotIdTagline);
  }

  setTab(tab: MatchTab): void {
    this.activeTab.set(tab);
  }
}
