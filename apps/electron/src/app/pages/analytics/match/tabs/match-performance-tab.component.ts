import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  CompactTimeline,
  MatchCacheRow,
  MatchDetail,
  MatchDetailParticipant,
} from '../../../../../types/electron';
import { RiotApiService } from '../../../../services/riot-api.service';
import { TF, frameCs } from '../../models/analytics.types';
import { EmptyStateComponent } from '../../widgets/empty-state.component';
import { MapHeatmapComponent } from '../../widgets/map-heatmap.component';

/** One head-to-head metric row. */
interface CompareRow {
  label: string;
  left: number;
  right: number;
  /** Lower is better (deaths, time dead). */
  inverse?: boolean;
  format: 'int' | 'one' | 'kda';
}

@Component({
  selector: 'app-match-performance-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, EmptyStateComponent, MapHeatmapComponent],
  templateUrl: './match-performance-tab.component.html',
  styleUrl: './match-performance-tab.component.scss',
})
export class MatchPerformanceTabComponent {
  private riotApi = inject(RiotApiService);

  match = input.required<MatchCacheRow>();
  detail = input.required<MatchDetail>();
  timeline = input.required<CompactTimeline | null>();

  readonly leftPid = signal<number | null>(null);
  readonly rightPid = signal<number | null>(null);

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
    const opponent = this.detail().participants.find(
      (p) => p.teamId !== me.teamId && p.teamPosition === me.teamPosition
    );
    return opponent ?? this.players().enemies[0] ?? null;
  });

  readonly compareRows = computed<CompareRow[]>(() => {
    const l = this.left();
    const r = this.right();
    if (!l || !r) return [];

    const cs = (p: MatchDetailParticipant) => p.totalMinionsKilled + p.neutralMinionsKilled;
    const kda = (p: MatchDetailParticipant) =>
      p.deaths === 0 ? p.kills + p.assists : (p.kills + p.assists) / p.deaths;

    return [
      { label: 'KDA', left: kda(l), right: kda(r), format: 'kda' },
      { label: 'Kills', left: l.kills, right: r.kills, format: 'int' },
      { label: 'Deaths', left: l.deaths, right: r.deaths, inverse: true, format: 'int' },
      { label: 'Assists', left: l.assists, right: r.assists, format: 'int' },
      { label: 'CS', left: cs(l), right: cs(r), format: 'int' },
      { label: 'Gold', left: l.goldEarned, right: r.goldEarned, format: 'int' },
      {
        label: 'Damage dealt',
        left: l.totalDamageDealtToChampions,
        right: r.totalDamageDealtToChampions,
        format: 'int',
      },
      { label: 'Damage taken', left: l.totalDamageTaken, right: r.totalDamageTaken, format: 'int' },
      { label: 'Vision score', left: l.visionScore, right: r.visionScore, format: 'int' },
      { label: 'Wards placed', left: l.wardsPlaced, right: r.wardsPlaced, format: 'int' },
      {
        label: 'Time dead',
        left: l.totalTimeSpentDead,
        right: r.totalTimeSpentDead,
        inverse: true,
        format: 'int',
      },
    ];
  });

  /**
   * Gold/CS/XP differentials at 15 minutes.
   *
   * Returns null when the game ended before minute 15 — remakes and early
   * surrenders get an explicit empty state rather than a misleading zero.
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

  readonly teamTotals = computed(() => {
    const detail = this.detail();
    const myTeam = this.match().team_id;
    const sum = (list: MatchDetailParticipant[], pick: (p: MatchDetailParticipant) => number) =>
      list.reduce((n, p) => n + pick(p), 0);

    const allies = detail.participants.filter((p) => p.teamId === myTeam);
    const enemies = detail.participants.filter((p) => p.teamId !== myTeam);

    return [
      {
        label: 'Kills',
        ally: sum(allies, (p) => p.kills),
        enemy: sum(enemies, (p) => p.kills),
      },
      {
        label: 'Gold',
        ally: sum(allies, (p) => p.goldEarned),
        enemy: sum(enemies, (p) => p.goldEarned),
      },
      {
        label: 'Damage',
        ally: sum(allies, (p) => p.totalDamageDealtToChampions),
        enemy: sum(enemies, (p) => p.totalDamageDealtToChampions),
      },
      {
        label: 'Vision',
        ally: sum(allies, (p) => p.visionScore),
        enemy: sum(enemies, (p) => p.visionScore),
      },
    ];
  });

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

  /** Share of a comparison row's bar belonging to the left player. */
  leftShare(row: CompareRow): number {
    const total = row.left + row.right;
    if (total <= 0) return 50;
    return (row.left / total) * 100;
  }

  leftWins(row: CompareRow): boolean {
    return row.inverse ? row.left < row.right : row.left > row.right;
  }

  rightWins(row: CompareRow): boolean {
    return row.inverse ? row.right < row.left : row.right > row.left;
  }

  formatValue(row: CompareRow, value: number): string {
    if (row.format === 'kda') return value.toFixed(2);
    if (row.format === 'one') return value.toFixed(1);
    if (row.label === 'Time dead') {
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
