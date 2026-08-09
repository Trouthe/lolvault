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
import { EmptyStateComponent } from '../../widgets/empty-state.component';

type Direction = 'dealt' | 'taken';
type DamageType = 'total' | 'physical' | 'magic' | 'true';

interface DamageRow {
  participant: MatchDetailParticipant;
  value: number;
  share: number;
  isSelf: boolean;
}

/**
 * Glyphs for the damage controls. League has no official physical/magic/true
 * stat art in the public CDNs, so these are drawn inline — crisp at any size,
 * themeable, and available offline.
 */
const ICONS: Record<string, string> = {
  // Crossed sword — damage dealt.
  dealt: 'M6.9 3 3 6.9l7.1 7.1 1.9-1.9L6.9 3Zm10.2 0-4.4 4.4 1.9 1.9L21 6.9 17.1 3ZM8.6 15.7 3 21.3 4.7 23l5.6-5.6-1.7-1.7Zm6.8 0-1.7 1.7L19.3 23l1.7-1.7-5.6-5.6Z',
  // Shield — damage taken.
  taken: 'M12 2 4 5.2v6.3c0 5 3.4 9.7 8 10.5 4.6-.8 8-5.5 8-10.5V5.2L12 2Z',
  // Sword — physical.
  physical: 'M14.5 2 21 8.5 9.9 19.6 6.4 16 17.5 4.9 14.5 2ZM5 17.5 3 22l4.5-2L5 17.5Z',
  // Spark — magic.
  magic: 'M12 2l1.9 5.8L20 9.7l-4.9 3.6L16.6 20 12 16.5 7.4 20l1.5-6.7L4 9.7l6.1-1.9L12 2Z',
  // Bolt — true damage.
  true: 'M13 2 4 14h6l-1 8 9-12h-6l1-8Z',
  // Concentric burst — total.
  total: 'M12 2 9.6 8.2 3 9.1l4.8 4.5L6.5 20 12 16.8 17.5 20l-1.3-6.4L21 9.1l-6.6-.9L12 2Z',
};

@Component({
  selector: 'app-match-damage-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, NgApexchartsModule, EmptyStateComponent],
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

  readonly directionOptions: { value: Direction; label: string; icon: string }[] = [
    { value: 'dealt', label: 'Dealt', icon: ICONS['dealt'] },
    { value: 'taken', label: 'Taken', icon: ICONS['taken'] },
  ];

  readonly typeOptions: { value: DamageType; label: string; icon: string; color: string }[] = [
    { value: 'total', label: 'Total', icon: ICONS['total'], color: 'var(--primary-text)' },
    { value: 'physical', label: 'Physical', icon: ICONS['physical'], color: '#e8994f' },
    { value: 'magic', label: 'Magic', icon: ICONS['magic'], color: '#4fb0e8' },
    { value: 'true', label: 'True', icon: ICONS['true'], color: '#e8e0d0' },
  ];

  readonly activeTypeIcon = computed(
    () => this.typeOptions.find((t) => t.value === this.damageType())?.icon ?? ''
  );

  // ── Per-player totals ──────────────────────────────────────────────────────

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

  // ── Cumulative curve ───────────────────────────────────────────────────────

  /**
   * Timeline field for the current selection.
   *
   * The compacted timeline keeps the champion-damage breakdown for damage
   * dealt, but only a total for damage taken — so the type split has no
   * per-minute series in that direction and the chart falls back to totals.
   */
  private readonly timelineField = computed<number>(() => {
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

  readonly typeNotChartable = computed(
    () => this.direction() === 'taken' && this.damageType() !== 'total'
  );

  /**
   * Running totals for the account holder against each team's per-player
   * average. Cumulative rather than per-minute, so the line always climbs and a
   * strong game reads as pulling away from both baselines.
   */
  readonly series = computed(() => {
    const tl = this.timeline();
    const myPid = this.match().participant_id;
    if (!tl?.frames?.length || !myPid) return null;

    const field = this.timelineField();
    const detail = this.detail();
    const myTeamId = this.match().team_id;

    const allyIds = detail.participants
      .filter((p) => p.teamId === myTeamId && p.participantId !== myPid)
      .map((p) => p.participantId);
    const enemyIds = detail.participants
      .filter((p) => p.teamId !== myTeamId)
      .map((p) => p.participantId);

    const mine: { x: number; y: number }[] = [];
    const allyAvg: { x: number; y: number }[] = [];
    const enemyAvg: { x: number; y: number }[] = [];

    tl.frames.forEach((frame, minute) => {
      const read = (pid: number) => frame[pid - 1]?.[field] ?? 0;

      mine.push({ x: minute, y: read(myPid) });

      if (allyIds.length) {
        const sum = allyIds.reduce((n, pid) => n + read(pid), 0);
        allyAvg.push({ x: minute, y: Math.round(sum / allyIds.length) });
      }
      if (enemyIds.length) {
        const sum = enemyIds.reduce((n, pid) => n + read(pid), 0);
        enemyAvg.push({ x: minute, y: Math.round(sum / enemyIds.length) });
      }
    });

    if (!mine.length) return null;

    const out = [{ name: 'You', data: mine }];
    if (allyAvg.length) out.push({ name: 'Ally avg', data: allyAvg });
    if (enemyAvg.length) out.push({ name: 'Enemy avg', data: enemyAvg });
    return out;
  });

  readonly chartOptions = computed(() => {
    this.chartTheme.revision();
    const base = this.chartTheme.baseOptions(215);
    const palette = this.chartTheme.palette();
    const frames = this.timeline()?.frames.length ?? 0;

    return {
      ...base,
      chart: { ...base.chart, type: 'area' as const },
      colors: [palette.gold, palette.blueTeam, palette.redTeam],
      stroke: { curve: 'smooth' as const, width: [3, 1.8, 1.8] },
      fill: {
        type: 'gradient' as const,
        gradient: { shadeIntensity: 1, opacityFrom: [0.28, 0.06, 0.06], opacityTo: 0, stops: [0, 100] },
      },
      xaxis: {
        type: 'numeric' as const,
        // Cap ticks so a long game doesn't print every single minute.
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
        y: { formatter: (val: number) => `${Math.round(val).toLocaleString()} total` },
      },
    };
  });

  readonly directionLabel = computed(() =>
    this.direction() === 'dealt' ? 'Damage to champions' : 'Damage taken'
  );

  championIcon(name: string): string {
    return this.riotApi.getChampionIconUrl(name);
  }
}
