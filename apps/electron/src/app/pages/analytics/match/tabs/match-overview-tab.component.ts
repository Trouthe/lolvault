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
import { ChartThemeService } from '../../services/chart-theme.service';
import { TF } from '../../models/analytics.types';

interface TeamView {
  teamId: number;
  win: boolean;
  players: MatchDetailParticipant[];
  bans: number[];
  kills: number;
  gold: number;
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
  private chartTheme = inject(ChartThemeService);

  match = input.required<MatchCacheRow>();
  detail = input.required<MatchDetail>();
  timeline = input.required<CompactTimeline | null>();

  /** Gold graph is revealed on hover/focus of the gold bar, per the spec. */
  readonly showGoldGraph = signal(false);

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
        gold: players.reduce((n, p) => n + p.goldEarned, 0),
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

  /** Objectives shown in the centre column, in the order they matter. */
  readonly objectiveKeys = ['baron', 'dragon', 'riftHerald', 'tower', 'inhibitor'] as const;

  readonly objectiveLabels: Record<string, string> = {
    baron: 'Baron',
    dragon: 'Dragon',
    riftHerald: 'Herald',
    tower: 'Towers',
    inhibitor: 'Inhibs',
  };

  /** Gold lead over time — positive means the account holder's team is ahead. */
  readonly goldLeadSeries = computed(() => {
    const tl = this.timeline();
    const myTeamId = this.match().team_id;
    if (!tl?.frames?.length || myTeamId === null || myTeamId === undefined) return null;

    const detail = this.detail();
    const allyIds = new Set(
      detail.participants.filter((p) => p.teamId === myTeamId).map((p) => p.participantId)
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
    const base = this.chartTheme.baseOptions(150);
    const palette = this.chartTheme.palette();

    return {
      ...base,
      chart: { ...base.chart, type: 'area' as const },
      colors: [palette.blueTeam],
      stroke: { curve: 'straight' as const, width: 2 },
      fill: {
        type: 'gradient' as const,
        gradient: {
          shadeIntensity: 1,
          type: 'vertical' as const,
          // Above the axis = ahead (blue), below = behind (red).
          colorStops: [
            { offset: 0, color: palette.blueTeam, opacity: 0.42 },
            { offset: 50, color: palette.blueTeam, opacity: 0.04 },
            { offset: 50, color: palette.redTeam, opacity: 0.04 },
            { offset: 100, color: palette.redTeam, opacity: 0.42 },
          ],
        },
      },
      xaxis: {
        type: 'numeric' as const,
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

  isSelf(participant: MatchDetailParticipant): boolean {
    return participant.puuid === this.match().puuid;
  }

  kda(p: MatchDetailParticipant): number {
    return p.deaths === 0 ? p.kills + p.assists : (p.kills + p.assists) / p.deaths;
  }

  csOf(p: MatchDetailParticipant): number {
    return p.totalMinionsKilled + p.neutralMinionsKilled;
  }

  objectiveCount(team: TeamView, key: string): number {
    return team.objectives?.[key]?.kills ?? 0;
  }
}
