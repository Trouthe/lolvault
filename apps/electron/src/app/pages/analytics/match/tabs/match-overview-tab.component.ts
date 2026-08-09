import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NgApexchartsModule } from 'ng-apexcharts';
import {
  CompactTimeline,
  MatchCacheRow,
  MatchDetail,
  MatchDetailParticipant,
} from '../../../../../types/electron';
import { RiotApiService } from '../../../../services/riot-api.service';
import { ChampionCatalogService } from '../../../../services/champion-catalog.service';
import { GameDataService } from '../../../../services/game-data.service';
import { ChartThemeService } from '../../services/chart-theme.service';
import { MatchScoreService, fromDetail } from '../../services/match-score.service';
import { TF } from '../../models/analytics.types';
import { OBJECTIVE_ROWS, objectiveIcon, roleIcon } from '../../services/game-assets';

interface TeamView {
  teamId: number;
  win: boolean;
  players: MatchDetailParticipant[];
  bans: number[];
  kills: number;
  deaths: number;
  gold: number;
  damage: number;
  objectives: Record<string, { first?: boolean; kills?: number }>;
}

@Component({
  selector: 'app-match-overview-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, NgApexchartsModule],
  templateUrl: './match-overview-tab.component.html',
  styleUrl: './match-overview-tab.component.scss',
})
export class MatchOverviewTabComponent {
  private riotApi = inject(RiotApiService);
  private champions = inject(ChampionCatalogService);
  private gameData = inject(GameDataService);
  private chartTheme = inject(ChartThemeService);
  private scorer = inject(MatchScoreService);

  match = input.required<MatchCacheRow>();
  detail = input.required<MatchDetail>();
  timeline = input.required<CompactTimeline | null>();

  /** Gold graph is revealed on hover/focus of the gold bar, per the spec. */
  readonly showGoldGraph = signal(false);

  readonly objectiveRows = OBJECTIVE_ROWS;

  readonly teams = computed<TeamView[]>(() => {
    const detail = this.detail();
    return detail.teams.map((team) => {
      const players = detail.participants.filter((p) => p.teamId === team.teamId);
      return {
        teamId: team.teamId,
        win: team.win,
        players,
        bans: team.bans.map((b) => b.championId).filter((id) => id > 0),
        kills: players.reduce((n, p) => n + p.kills, 0),
        deaths: players.reduce((n, p) => n + p.deaths, 0),
        gold: players.reduce((n, p) => n + p.goldEarned, 0),
        damage: players.reduce((n, p) => n + p.totalDamageDealtToChampions, 0),
        objectives: team.objectives ?? {},
      };
    });
  });

  /** The account holder's team first, so "us" is always on the left. */
  readonly orderedTeams = computed(() => {
    const teams = this.teams();
    const myTeamId = this.match().team_id;
    if (myTeamId === null || myTeamId === undefined) return teams;
    return [...teams].sort((a, b) => (a.teamId === myTeamId ? -1 : b.teamId === myTeamId ? 1 : 0));
  });

  readonly totalGold = computed(() => this.teams().reduce((n, t) => n + t.gold, 0));

  readonly goldShare = computed(() => {
    const teams = this.orderedTeams();
    const total = this.totalGold();
    if (!total || teams.length < 2) return 50;
    return (teams[0].gold / total) * 100;
  });

  /** Per-match ratings, so the scoreboard can flag MVP and show placements. */
  private readonly scores = computed(() => {
    const detail = this.detail();
    return this.scorer.score(
      detail.participants.map(fromDetail),
      detail.gameDuration ?? this.match().duration_seconds ?? 0,
      `det:${detail.matchId}`
    );
  });

  /** Highest single damage figure, for scaling the per-player damage bars. */
  readonly maxDamage = computed(() =>
    Math.max(...this.detail().participants.map((p) => p.totalDamageDealtToChampions), 1)
  );

  // ── Gold lead ──────────────────────────────────────────────────────────────

  readonly goldLeadSeries = computed(() => {
    const tl = this.timeline();
    const myTeamId = this.match().team_id;
    if (!tl?.frames?.length || myTeamId === null || myTeamId === undefined) return null;

    const allyIds = new Set(
      this.detail()
        .participants.filter((p) => p.teamId === myTeamId)
        .map((p) => p.participantId)
    );
    if (!allyIds.size) return null;

    const points = tl.frames.map((frame, index) => {
      let ally = 0;
      let enemy = 0;
      for (let pid = 1; pid <= 10; pid++) {
        const gold = frame[pid - 1]?.[TF.TOTAL_GOLD] ?? 0;
        if (allyIds.has(pid)) ally += gold;
        else enemy += gold;
      }
      return { x: index, y: ally - enemy };
    });

    return [{ name: 'Gold lead', data: points }];
  });

  readonly goldChartOptions = computed(() => {
    this.chartTheme.revision();
    const base = this.chartTheme.baseOptions(160);
    const palette = this.chartTheme.palette();
    const frames = this.timeline()?.frames.length ?? 0;

    return {
      ...base,
      chart: { ...base.chart, type: 'line' as const },
      colors: [palette.gold],
      stroke: { curve: 'smooth' as const, width: 2 },
      xaxis: {
        type: 'numeric' as const,
        // At most four labels, so a 20-minute game doesn't print every minute.
        tickAmount: Math.min(4, Math.max(2, frames - 1)),
        labels: {
          style: this.chartTheme.axisLabelStyle(),
          formatter: (val: string) => `${Math.round(Number(val))}m`,
        },
        axisBorder: { show: false },
        tooltip: { enabled: false },
      },
      yaxis: {
        labels: {
          style: this.chartTheme.axisLabelStyle(),
          formatter: (val: number) => {
            const abs = Math.abs(val);
            return abs >= 1000 ? `${(val / 1000).toFixed(1)}k` : `${Math.round(val)}`;
          },
        },
      },
      annotations: {
        yaxis: [{ y: 0, borderColor: palette.border, strokeDashArray: 0 }],
      },
      tooltip: {
        ...base.tooltip,
        x: { formatter: (val: number) => `${Math.round(val)} min` },
        y: {
          formatter: (val: number) => {
            const rounded = Math.round(val);
            return rounded >= 0
              ? `+${rounded.toLocaleString()} ahead`
              : `${Math.abs(rounded).toLocaleString()} behind`;
          },
        },
      },
    };
  });

  // ── Helpers ────────────────────────────────────────────────────────────────

  championIcon(name: string): string {
    return this.riotApi.getChampionIconUrl(name);
  }

  /** Bans arrive as numeric champion keys, resolved via the bundled catalog. */
  championIconById(id: number): string {
    return this.champions.getIconUrl(String(id));
  }

  championNameById(id: number): string {
    return this.champions.getChampionId(String(id));
  }

  itemIcon(id: number): string {
    return this.riotApi.getItemIconUrl(id);
  }

  itemName(id: number): string {
    return this.gameData.getItemName(id);
  }

  spellIcon(id: number): string {
    return this.gameData.getSummonerSpellIconUrl(id);
  }

  spellName(id: number): string {
    return this.gameData.getSummonerSpell(id)?.name ?? '';
  }

  roleIconFor(position: string): string {
    return roleIcon(position);
  }

  /** Official objective art, coloured for the team that took it. */
  objectiveIconFor(kind: string, teamId: number): string {
    return objectiveIcon(
      kind as 'baron' | 'dragon' | 'herald' | 'tower' | 'inhibitor',
      teamId === 200 ? 200 : 100
    );
  }

  isSelf(participant: MatchDetailParticipant): boolean {
    return participant.puuid === this.match().puuid;
  }

  isMvp(participant: MatchDetailParticipant): boolean {
    return this.scores().byPuuid[participant.puuid]?.isMvp ?? false;
  }

  scoreOf(participant: MatchDetailParticipant): number {
    return this.scores().byPuuid[participant.puuid]?.score ?? 0;
  }

  kda(p: MatchDetailParticipant): number {
    return p.deaths === 0 ? p.kills + p.assists : (p.kills + p.assists) / p.deaths;
  }

  csOf(p: MatchDetailParticipant): number {
    return p.totalMinionsKilled + p.neutralMinionsKilled;
  }

  csPerMin(p: MatchDetailParticipant): number {
    const minutes = (this.detail().gameDuration ?? this.match().duration_seconds ?? 0) / 60;
    return minutes > 0 ? this.csOf(p) / minutes : 0;
  }

  killParticipation(p: MatchDetailParticipant, team: TeamView): number {
    if (!team.kills) return 0;
    return ((p.kills + p.assists) / team.kills) * 100;
  }

  damageShare(p: MatchDetailParticipant): number {
    return (p.totalDamageDealtToChampions / this.maxDamage()) * 100;
  }

  objectiveCount(team: TeamView, key: string): number {
    return team.objectives?.[key]?.kills ?? 0;
  }
}
