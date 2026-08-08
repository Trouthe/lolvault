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
import { TF } from '../../models/analytics.types';
import { SegmentOption, SegmentedToggleComponent } from '../../widgets/segmented-toggle.component';
import { EmptyStateComponent } from '../../widgets/empty-state.component';

type Direction = 'dealt' | 'taken';
type DamageType = 'total' | 'physical' | 'magic' | 'true';

interface DamageRow {
  participant: MatchDetailParticipant;
  value: number;
  share: number;
  isSelf: boolean;
}

@Component({
  selector: 'app-match-damage-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, NgApexchartsModule, SegmentedToggleComponent, EmptyStateComponent],
  templateUrl: './match-damage-tab.component.html',
  styleUrl: './match-damage-tab.component.scss',
})
export class MatchDamageTabComponent {
  private riotApi = inject(RiotApiService);
  private chartTheme = inject(ChartThemeService);

  match = input.required<MatchCacheRow>();
  detail = input.required<MatchDetail>();
  timeline = input.required<CompactTimeline | null>();

  readonly direction = signal<Direction>('dealt');
  readonly damageType = signal<DamageType>('total');

  readonly directionOptions: SegmentOption<Direction>[] = [
    { value: 'dealt', label: 'Dealt' },
    { value: 'taken', label: 'Taken' },
  ];

  readonly typeOptions = computed<SegmentOption<DamageType>[]>(() => [
    { value: 'total', label: 'Total' },
    { value: 'physical', label: 'Physical' },
    { value: 'magic', label: 'Magic' },
    { value: 'true', label: 'True' },
  ]);

  /** Per-player totals for the current direction/type selection. */
  readonly rows = computed<DamageRow[]>(() => {
    const detail = this.detail();
    const selfPuuid = this.match().puuid;
    const dir = this.direction();
    const type = this.damageType();

    const valueOf = (p: MatchDetailParticipant): number => {
      if (dir === 'dealt') {
        switch (type) {
          case 'physical':
            return p.physicalDamageDealtToChampions;
          case 'magic':
            return p.magicDamageDealtToChampions;
          case 'true':
            return p.trueDamageDealtToChampions;
          default:
            return p.totalDamageDealtToChampions;
        }
      }
      switch (type) {
        case 'physical':
          return p.physicalDamageTaken;
        case 'magic':
          return p.magicDamageTaken;
        case 'true':
          return p.trueDamageTaken;
        default:
          return p.totalDamageTaken;
      }
    };

    const values = detail.participants.map((p) => ({ participant: p, value: valueOf(p) }));
    const max = Math.max(...values.map((v) => v.value), 1);

    return values
      .map((v) => ({
        participant: v.participant,
        value: v.value,
        share: (v.value / max) * 100,
        isSelf: v.participant.puuid === selfPuuid,
      }))
      .sort((a, b) => b.value - a.value);
  });

  readonly myTeamRows = computed(() => {
    const myTeam = this.match().team_id;
    return this.rows().filter((r) => r.participant.teamId === myTeam);
  });

  readonly enemyTeamRows = computed(() => {
    const myTeam = this.match().team_id;
    return this.rows().filter((r) => r.participant.teamId !== myTeam);
  });

  /**
   * Per-minute damage for the account holder against their team's average.
   *
   * Timeline `damageStats` is cumulative, so this differences consecutive frames
   * to show damage *in* each minute rather than a monotonic running total.
   */
  readonly series = computed(() => {
    const tl = this.timeline();
    const myPid = this.match().participant_id;
    if (!tl?.frames?.length || !myPid) return null;

    const field = this.timelineField();
    if (field === null) return null;

    const detail = this.detail();
    const myTeamId = this.match().team_id;
    const allyIds = detail.participants
      .filter((p) => p.teamId === myTeamId && p.participantId !== myPid)
      .map((p) => p.participantId);

    const mine: { x: number; y: number }[] = [];
    const teamAvg: { x: number; y: number }[] = [];

    for (let i = 1; i < tl.frames.length; i++) {
      const cur = tl.frames[i];
      const prev = tl.frames[i - 1];

      const delta = (pid: number) => Math.max(0, (cur[pid - 1]?.[field] ?? 0) - (prev[pid - 1]?.[field] ?? 0));

      mine.push({ x: i, y: delta(myPid) });

      if (allyIds.length) {
        const sum = allyIds.reduce((n, pid) => n + delta(pid), 0);
        teamAvg.push({ x: i, y: Math.round(sum / allyIds.length) });
      }
    }

    if (!mine.length) return null;

    const seriesList = [{ name: 'You', data: mine }];
    if (teamAvg.length) seriesList.push({ name: 'Team average', data: teamAvg });
    return seriesList;
  });

  /**
   * Timeline frame index for the current selection.
   *
   * The compacted timeline keeps the champion-damage breakdown for dealt
   * damage, but only a total for damage taken — so the physical/magic/true
   * split has no per-minute series and the chart falls back to totals.
   */
  private readonly timelineField = computed<number | null>(() => {
    if (this.direction() === 'taken') return TF.DMG_TAKEN_TOTAL;
    switch (this.damageType()) {
      case 'physical':
        return TF.DMG_DONE_PHYSICAL;
      case 'magic':
        return TF.DMG_DONE_MAGIC;
      case 'true':
        return TF.DMG_DONE_TRUE;
      default:
        return TF.DMG_DONE_TOTAL;
    }
  });

  /** True when the chart cannot honour the selected damage type. */
  readonly typeNotChartable = computed(
    () => this.direction() === 'taken' && this.damageType() !== 'total'
  );

  readonly chartOptions = computed(() => {
    this.chartTheme.revision();
    const base = this.chartTheme.baseOptions(190);
    const palette = this.chartTheme.palette();

    return {
      ...base,
      chart: { ...base.chart, type: 'line' as const },
      colors: [palette.gold, palette.secondaryText],
      stroke: { curve: 'smooth' as const, width: [2.5, 1.5], dashArray: [0, 4] },
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
          formatter: (val: number) =>
            val >= 1000 ? `${(val / 1000).toFixed(1)}k` : `${Math.round(val)}`,
        },
      },
      legend: { ...base.legend, show: true, position: 'top' as const, horizontalAlign: 'right' as const },
      tooltip: {
        ...base.tooltip,
        shared: true,
        x: { formatter: (val: number) => `Minute ${Math.round(val)}` },
        y: { formatter: (val: number) => `${Math.round(val).toLocaleString()} dmg` },
      },
    };
  });

  championIcon(name: string): string {
    return this.riotApi.getChampionIconUrl(name);
  }

  readonly directionLabel = computed(() =>
    this.direction() === 'dealt' ? 'Damage to champions' : 'Damage taken'
  );
}
