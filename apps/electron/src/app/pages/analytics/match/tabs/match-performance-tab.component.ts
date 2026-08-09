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
import { ChartThemeService } from '../../services/chart-theme.service';
import { TF, frameCs } from '../../models/analytics.types';
import { SegmentOption, SegmentedToggleComponent } from '../../widgets/segmented-toggle.component';
import { EmptyStateComponent } from '../../widgets/empty-state.component';

/** Metrics that can be plotted over time from the timeline. */
type GraphMetric = 'gold' | 'cs' | 'xp' | 'damage' | 'taken' | 'level';

/** A stat always shown as plain numbers rather than a graph. */
interface FixedStat {
  label: string;
  left: number;
  right: number;
  /** Lower is better. */
  inverse?: boolean;
  format: 'int' | 'kda' | 'time';
}

@Component({
  selector: 'app-match-performance-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, NgApexchartsModule, SegmentedToggleComponent, EmptyStateComponent],
  templateUrl: './match-performance-tab.component.html',
  styleUrl: './match-performance-tab.component.scss',
})
export class MatchPerformanceTabComponent {
  private riotApi = inject(RiotApiService);
  private chartTheme = inject(ChartThemeService);

  match = input.required<MatchCacheRow>();
  detail = input.required<MatchDetail>();
  timeline = input.required<CompactTimeline | null>();

  readonly leftPid = signal<number | null>(null);
  readonly rightPid = signal<number | null>(null);
  readonly metric = signal<GraphMetric>('gold');

  readonly metricOptions: SegmentOption<GraphMetric>[] = [
    { value: 'gold', label: 'Gold' },
    { value: 'cs', label: 'CS' },
    { value: 'xp', label: 'XP' },
    { value: 'damage', label: 'Damage' },
    { value: 'taken', label: 'Taken' },
    { value: 'level', label: 'Level' },
  ];

  readonly players = computed(() => {
    const detail = this.detail();
    const myTeam = this.match().team_id;
    return {
      allies: detail.participants.filter((p) => p.teamId === myTeam),
      enemies: detail.participants.filter((p) => p.teamId !== myTeam),
    };
  });

  /** Defaults: the account holder vs their lane opponent. */
  readonly left = computed<MatchDetailParticipant | null>(() => {
    const pid = this.leftPid() ?? this.match().participant_id;
    return this.detail().participants.find((p) => p.participantId === pid) ?? null;
  });

  readonly right = computed<MatchDetailParticipant | null>(() => {
    const explicit = this.rightPid();
    if (explicit !== null) {
      return this.detail().participants.find((p) => p.participantId === explicit) ?? null;
    }
    const me = this.left();
    if (!me) return null;
    return (
      this.detail().participants.find(
        (p) => p.teamId !== me.teamId && p.teamPosition === me.teamPosition
      ) ??
      this.players().enemies[0] ??
      null
    );
  });

  /** Stats the spec pins as always-visible numbers rather than graphs. */
  readonly fixedStats = computed<FixedStat[]>(() => {
    const l = this.left();
    const r = this.right();
    if (!l || !r) return [];

    const kda = (p: MatchDetailParticipant) =>
      p.deaths === 0 ? p.kills + p.assists : (p.kills + p.assists) / p.deaths;

    return [
      { label: 'KDA', left: kda(l), right: kda(r), format: 'kda' },
      { label: 'Kills', left: l.kills, right: r.kills, format: 'int' },
      { label: 'Deaths', left: l.deaths, right: r.deaths, inverse: true, format: 'int' },
      { label: 'Assists', left: l.assists, right: r.assists, format: 'int' },
      { label: 'Wards placed', left: l.wardsPlaced, right: r.wardsPlaced, format: 'int' },
      {
        label: 'Time dead',
        left: l.totalTimeSpentDead,
        right: r.totalTimeSpentDead,
        inverse: true,
        format: 'time',
      },
    ];
  });

  /**
   * @15 differentials. Null when the game ended before minute 15 — remakes and
   * early surrenders get an explicit empty state, not a misleading zero.
   */
  readonly diffs15 = computed(() => {
    const tl = this.timeline();
    const l = this.left();
    const r = this.right();
    if (!tl?.frames?.length || !l || !r) return null;

    const frame = tl.frames[15];
    if (!frame) return null;

    const lf = frame[l.participantId - 1];
    const rf = frame[r.participantId - 1];
    if (!lf || !rf) return null;

    return {
      gold: lf[TF.TOTAL_GOLD] - rf[TF.TOTAL_GOLD],
      cs: frameCs(lf) - frameCs(rf),
      xp: lf[TF.XP] - rf[TF.XP],
    };
  });

  readonly gameTooShort = computed(() => {
    const duration = this.match().duration_seconds ?? 0;
    return duration > 0 && duration < 15 * 60;
  });

  // ── Comparison graph ───────────────────────────────────────────────────────

  private valueAt(frame: number[][], pid: number, metric: GraphMetric): number {
    const row = frame[pid - 1];
    if (!row) return 0;
    switch (metric) {
      case 'cs':
        return frameCs(row);
      case 'xp':
        return row[TF.XP];
      case 'damage':
        return row[TF.DMG_DONE_TOTAL];
      case 'taken':
        return row[TF.DMG_TAKEN_TOTAL];
      case 'level':
        return row[TF.LEVEL];
      default:
        return row[TF.TOTAL_GOLD];
    }
  }

  readonly series = computed(() => {
    const tl = this.timeline();
    const l = this.left();
    const r = this.right();
    if (!tl?.frames?.length || !l || !r) return null;

    const metric = this.metric();
    const leftData: { x: number; y: number }[] = [];
    const rightData: { x: number; y: number }[] = [];

    tl.frames.forEach((frame, minute) => {
      leftData.push({ x: minute, y: this.valueAt(frame, l.participantId, metric) });
      rightData.push({ x: minute, y: this.valueAt(frame, r.participantId, metric) });
    });

    return [
      { name: l.riotIdGameName || l.championName, data: leftData },
      { name: r.riotIdGameName || r.championName, data: rightData },
    ];
  });

  readonly chartOptions = computed(() => {
    this.chartTheme.revision();
    const base = this.chartTheme.baseOptions(210);
    const palette = this.chartTheme.palette();
    const frames = this.timeline()?.frames.length ?? 0;

    return {
      ...base,
      chart: { ...base.chart, type: 'line' as const },
      colors: [palette.blueTeam, palette.redTeam],
      stroke: { curve: 'smooth' as const, width: 2.4 },
      xaxis: {
        type: 'numeric' as const,
        // Cap ticks so a 40-minute game doesn't print every single minute.
        tickAmount: Math.min(6, Math.max(2, frames - 1)),
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
          formatter: (val: number) =>
            val >= 1000 ? `${(val / 1000).toFixed(1)}k` : `${Math.round(val)}`,
        },
      },
      legend: {
        ...base.legend,
        show: true,
        position: 'top' as const,
        horizontalAlign: 'right' as const,
      },
      tooltip: {
        ...base.tooltip,
        shared: true,
        x: { formatter: (val: number) => `Minute ${Math.round(val)}` },
        y: { formatter: (val: number) => Math.round(val).toLocaleString() },
      },
    };
  });

  readonly metricLabel = computed(
    () => this.metricOptions.find((o) => o.value === this.metric())?.label ?? ''
  );

  // ── Team totals ────────────────────────────────────────────────────────────

  readonly teamTotals = computed(() => {
    const detail = this.detail();
    const myTeam = this.match().team_id;
    const sum = (list: MatchDetailParticipant[], pick: (p: MatchDetailParticipant) => number) =>
      list.reduce((n, p) => n + pick(p), 0);

    const allies = detail.participants.filter((p) => p.teamId === myTeam);
    const enemies = detail.participants.filter((p) => p.teamId !== myTeam);

    return [
      { label: 'Kills', ally: sum(allies, (p) => p.kills), enemy: sum(enemies, (p) => p.kills) },
      { label: 'Gold', ally: sum(allies, (p) => p.goldEarned), enemy: sum(enemies, (p) => p.goldEarned) },
      {
        label: 'Damage',
        ally: sum(allies, (p) => p.totalDamageDealtToChampions),
        enemy: sum(enemies, (p) => p.totalDamageDealtToChampions),
      },
      { label: 'Vision', ally: sum(allies, (p) => p.visionScore), enemy: sum(enemies, (p) => p.visionScore) },
    ];
  });

  // ── Helpers ────────────────────────────────────────────────────────────────

  selectLeft(pid: number): void {
    this.leftPid.set(pid);
  }

  selectRight(pid: number): void {
    this.rightPid.set(pid);
  }

  championIcon(name: string): string {
    return this.riotApi.getChampionIconUrl(name);
  }

  isLeft(p: MatchDetailParticipant): boolean {
    return p.participantId === this.left()?.participantId;
  }

  isRight(p: MatchDetailParticipant): boolean {
    return p.participantId === this.right()?.participantId;
  }

  leftShare(stat: FixedStat): number {
    const total = stat.left + stat.right;
    if (total <= 0) return 50;
    return (stat.left / total) * 100;
  }

  leftWins(stat: FixedStat): boolean {
    return stat.inverse ? stat.left < stat.right : stat.left > stat.right;
  }

  rightWins(stat: FixedStat): boolean {
    return stat.inverse ? stat.right < stat.left : stat.right > stat.left;
  }

  formatStat(stat: FixedStat, value: number): string {
    if (stat.format === 'kda') return value.toFixed(2);
    if (stat.format === 'time') {
      const m = Math.floor(value / 60);
      const s = Math.round(value % 60);
      return `${m}:${s.toString().padStart(2, '0')}`;
    }
    return Math.round(value).toLocaleString();
  }

  formatDiff(value: number): string {
    const rounded = Math.round(value);
    return rounded > 0 ? `+${rounded.toLocaleString()}` : rounded.toLocaleString();
  }

  teamShare(ally: number, enemy: number): number {
    const total = ally + enemy;
    if (total <= 0) return 50;
    return (ally / total) * 100;
  }
}
