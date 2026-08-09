import { Injectable } from '@angular/core';
import { MatchDetailParticipant } from '../../../../types/electron';
import { ParticipantSummary } from './match-aggregation.service';
import { RoleKey, isRoleKey } from './game-assets';

/**
 * Minimum shape needed to rate a player.
 *
 * Both the trimmed `_allParticipants` summary (present on every cached match)
 * and the full `MatchDetail` participant satisfy this, so collapsed cards and
 * the recent-record strip can be rated without fetching match detail.
 */
export interface ScoreableParticipant {
  puuid: string;
  participantId: number;
  teamId: number;
  teamPosition: string;
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  cs: number;
  damageToChampions: number;
  goldEarned: number;
  visionScore: number;
  /** Objective + turret damage. Absent for summary-only data. */
  objectiveDamage?: number;
}

export interface PlayerScore {
  puuid: string;
  participantId: number;
  teamId: number;
  /** 0-100 performance rating, relative to the other players in this match. */
  score: number;
  /** 1-10 placement across all players in the match. */
  rank: number;
  /** Top score on the winning team. */
  isMvp: boolean;
  /** Top score on the losing team. */
  isAce: boolean;
}

export interface MatchScores {
  byPuuid: Record<string, PlayerScore>;
  byParticipantId: Record<number, PlayerScore>;
  mvpPuuid: string | null;
  acePuuid: string | null;
}

/**
 * Relative metric weights per role. Roles are judged on what their job actually
 * is — a support with 20 CS is not underperforming, and a jungler's objective
 * damage matters more than a mid laner's.
 */
const WEIGHTS: Record<RoleKey | 'DEFAULT', Record<string, number>> = {
  TOP: { kda: 0.22, dmg: 0.2, kp: 0.14, cs: 0.16, vision: 0.05, obj: 0.09, survive: 0.14 },
  JUNGLE: { kda: 0.2, dmg: 0.15, kp: 0.22, cs: 0.09, vision: 0.1, obj: 0.14, survive: 0.1 },
  MIDDLE: { kda: 0.22, dmg: 0.24, kp: 0.16, cs: 0.14, vision: 0.05, obj: 0.06, survive: 0.13 },
  BOTTOM: { kda: 0.2, dmg: 0.26, kp: 0.14, cs: 0.16, vision: 0.04, obj: 0.08, survive: 0.12 },
  UTILITY: { kda: 0.2, dmg: 0.08, kp: 0.24, cs: 0.02, vision: 0.24, obj: 0.04, survive: 0.18 },
  DEFAULT: { kda: 0.21, dmg: 0.2, kp: 0.17, cs: 0.12, vision: 0.09, obj: 0.08, survive: 0.13 },
};

/** Maps a raw ratio to 0..1.35 with diminishing returns past `target`. */
function ratio(value: number, target: number): number {
  if (target <= 0) return 0;
  return Math.max(0, Math.min(1.35, Math.sqrt(Math.max(0, value / target))));
}

/** Adapts a trimmed `_allParticipants` entry. */
export function fromSummary(p: ParticipantSummary, participantId: number): ScoreableParticipant {
  return {
    puuid: p.puuid,
    participantId,
    teamId: p.teamId,
    teamPosition: p.teamPosition,
    win: p.win,
    kills: p.kills,
    deaths: p.deaths,
    assists: p.assists,
    cs: p.cs,
    damageToChampions: p.totalDamageDealtToChampions,
    goldEarned: p.goldEarned,
    visionScore: p.visionScore,
  };
}

/** Adapts a full match-detail participant. */
export function fromDetail(p: MatchDetailParticipant): ScoreableParticipant {
  return {
    puuid: p.puuid,
    participantId: p.participantId,
    teamId: p.teamId,
    teamPosition: p.teamPosition,
    win: p.win,
    kills: p.kills,
    deaths: p.deaths,
    assists: p.assists,
    cs: p.totalMinionsKilled + p.neutralMinionsKilled,
    damageToChampions: p.totalDamageDealtToChampions,
    goldEarned: p.goldEarned,
    visionScore: p.visionScore,
    objectiveDamage: p.damageDealtToObjectives + p.damageDealtToTurrets,
  };
}

/**
 * Derives a per-player performance rating and placement for a match.
 *
 * This is LoL Vault's own heuristic, not a Riot-provided number — Riot exposes
 * no match rating, so anything of this kind is computed locally. It is scored
 * relative to the other nine players in the same game, which keeps it
 * meaningful across elos and game lengths.
 */
@Injectable({ providedIn: 'root' })
export class MatchScoreService {
  private cache = new Map<string, MatchScores>();

  /**
   * @param cacheKey Match id. Detail-based results supersede summary-based ones,
   *                 so pass a distinct key (or clear) when upgrading precision.
   */
  score(
    players: ScoreableParticipant[],
    durationSeconds: number,
    cacheKey?: string
  ): MatchScores {
    if (cacheKey) {
      const cached = this.cache.get(cacheKey);
      if (cached) return cached;
    }

    const empty: MatchScores = {
      byPuuid: {},
      byParticipantId: {},
      mvpPuuid: null,
      acePuuid: null,
    };
    if (!players.length) return empty;

    const durationMin = Math.max(1, durationSeconds / 60);
    const hasObjective = players.some((p) => typeof p.objectiveDamage === 'number');

    const teamTotals = new Map<number, { kills: number; damage: number; deaths: number }>();
    for (const p of players) {
      const t = teamTotals.get(p.teamId) ?? { kills: 0, damage: 0, deaths: 0 };
      t.kills += p.kills;
      t.damage += p.damageToChampions;
      t.deaths += p.deaths;
      teamTotals.set(p.teamId, t);
    }

    // Benchmarks are the lobby's own maxima, so a rating reflects how a player
    // did relative to this specific game rather than an absolute scale.
    const maxCsPerMin = Math.max(...players.map((p) => p.cs / durationMin), 1);
    const maxVisionPerMin = Math.max(...players.map((p) => p.visionScore / durationMin), 0.1);
    const maxObjDamage = Math.max(...players.map((p) => p.objectiveDamage ?? 0), 1);

    const rated = players.map((p) => {
      const team = teamTotals.get(p.teamId) ?? { kills: 1, damage: 1, deaths: 1 };
      const role = isRoleKey(p.teamPosition) ? p.teamPosition : 'DEFAULT';
      const w = { ...WEIGHTS[role] };

      // Without objective damage, fold its weight into damage and KP rather
      // than scoring every player as if they did nothing to objectives.
      if (!hasObjective) {
        w['dmg'] += w['obj'] * 0.5;
        w['kp'] += w['obj'] * 0.5;
        w['obj'] = 0;
      }

      const kda = p.deaths === 0 ? p.kills + p.assists : (p.kills + p.assists) / p.deaths;
      const kp = team.kills > 0 ? (p.kills + p.assists) / team.kills : 0;
      const dmgShare = team.damage > 0 ? p.damageToChampions / team.damage : 0;
      const csPerMin = p.cs / durationMin;
      const visionPerMin = p.visionScore / durationMin;
      const deathShare = team.deaths > 0 ? p.deaths / team.deaths : 0.2;

      const value =
        w['kda'] * ratio(kda, 3.5) +
        w['dmg'] * ratio(dmgShare, 0.25) +
        w['kp'] * ratio(kp, 0.55) +
        w['cs'] * ratio(csPerMin, maxCsPerMin) +
        w['vision'] * ratio(visionPerMin, maxVisionPerMin) +
        (w['obj'] ? w['obj'] * ratio(p.objectiveDamage ?? 0, maxObjDamage) : 0) +
        // Dying less than an even share of the team's deaths is a positive.
        w['survive'] * ratio(Math.max(0, 0.4 - deathShare) / 0.4, 0.5);

      // Winning matters, but shouldn't erase a strong losing performance.
      return { p, value: value * (p.win ? 1.08 : 0.96) };
    });

    const byPuuid: Record<string, PlayerScore> = {};
    const byParticipantId: Record<number, PlayerScore> = {};

    const best = (winning: boolean) =>
      rated
        .filter((r) => r.p.win === winning)
        .sort((a, b) => b.value - a.value)[0]?.p ?? null;

    const mvp = best(true);
    const ace = best(false);

    [...rated]
      .sort((a, b) => b.value - a.value)
      .forEach((entry, index) => {
        const score: PlayerScore = {
          puuid: entry.p.puuid,
          participantId: entry.p.participantId,
          teamId: entry.p.teamId,
          score: Math.round(Math.max(0, Math.min(100, entry.value * 100))),
          rank: index + 1,
          isMvp: mvp?.puuid === entry.p.puuid,
          isAce: ace?.puuid === entry.p.puuid,
        };
        byPuuid[score.puuid] = score;
        byParticipantId[score.participantId] = score;
      });

    const result: MatchScores = {
      byPuuid,
      byParticipantId,
      mvpPuuid: mvp?.puuid ?? null,
      acePuuid: ace?.puuid ?? null,
    };

    if (cacheKey) this.cache.set(cacheKey, result);
    return result;
  }

  /** Ordinal suffix for a placement, e.g. 1 → "1ST". */
  ordinal(rank: number): string {
    if (rank % 100 >= 11 && rank % 100 <= 13) return `${rank}TH`;
    switch (rank % 10) {
      case 1:
        return `${rank}ST`;
      case 2:
        return `${rank}ND`;
      case 3:
        return `${rank}RD`;
      default:
        return `${rank}TH`;
    }
  }
}
