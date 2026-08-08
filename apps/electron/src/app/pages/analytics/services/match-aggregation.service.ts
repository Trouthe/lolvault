import { Injectable } from '@angular/core';
import { MatchCacheRow } from '../../../../types/electron';
import {
  ChampionStatRow,
  PlayedWithRow,
  QUEUE_FILTER_IDS,
  QueueFilter,
  RolePerformanceRow,
} from '../models/analytics.types';

/** Trimmed participant record stored on `match_cache.raw_json._allParticipants`. */
export interface ParticipantSummary {
  puuid: string;
  riotIdGameName: string;
  riotIdTagline?: string;
  championName: string;
  championId?: number;
  teamId: number;
  kills: number;
  deaths: number;
  assists: number;
  cs: number;
  totalDamageDealtToChampions: number;
  goldEarned: number;
  items: number[];
  win: boolean;
  teamPosition: string;
  visionScore: number;
}

interface RawJsonShape {
  _allParticipants?: ParticipantSummary[];
  totalDamageTaken?: number;
  [key: string]: unknown;
}

const ROLE_LABELS: Record<string, string> = {
  TOP: 'Top',
  JUNGLE: 'Jungle',
  MIDDLE: 'Mid',
  BOTTOM: 'Bot',
  UTILITY: 'Support',
};

/**
 * Pure aggregation over cached match rows.
 *
 * Components render; this service computes. Keeping the maths here means it can
 * be exercised directly without instantiating any Angular view.
 */
@Injectable({ providedIn: 'root' })
export class MatchAggregationService {
  /** Filters matches to a queue group. `all` passes everything through. */
  filterByQueue(matches: MatchCacheRow[], filter: QueueFilter): MatchCacheRow[] {
    const ids = QUEUE_FILTER_IDS[filter];
    if (!ids) return matches;
    return matches.filter((m) => m.queue_id !== null && ids.includes(m.queue_id));
  }

  participantsOf(row: MatchCacheRow): ParticipantSummary[] {
    return (row.raw_json as RawJsonShape)?._allParticipants ?? [];
  }

  /** Per-champion aggregate rows for the Champions screen. */
  championStats(matches: MatchCacheRow[]): ChampionStatRow[] {
    const map = new Map<
      string,
      {
        championId: number;
        games: number;
        wins: number;
        kills: number;
        deaths: number;
        assists: number;
        csPerMinSum: number;
        dmgPerMinSum: number;
        dmgTakenPerMinSum: number;
        goldDiffSum: number;
        goldDiffCount: number;
      }
    >();

    for (const m of matches) {
      const champ = m.champion;
      if (!champ) continue;

      const entry = map.get(champ) ?? {
        championId: m.champion_id ?? 0,
        games: 0,
        wins: 0,
        kills: 0,
        deaths: 0,
        assists: 0,
        csPerMinSum: 0,
        dmgPerMinSum: 0,
        dmgTakenPerMinSum: 0,
        goldDiffSum: 0,
        goldDiffCount: 0,
      };

      const minutes = (m.duration_seconds ?? 0) / 60;
      entry.games++;
      if (m.win === 1) entry.wins++;
      entry.kills += m.kills ?? 0;
      entry.deaths += m.deaths ?? 0;
      entry.assists += m.assists ?? 0;
      entry.csPerMinSum += m.cs_per_min ?? 0;
      if (minutes > 0) {
        entry.dmgPerMinSum += (m.damage_dealt ?? 0) / minutes;
        const taken = (m.raw_json as RawJsonShape)?.totalDamageTaken;
        if (typeof taken === 'number') entry.dmgTakenPerMinSum += taken / minutes;
      }
      // Only games with timeline data contribute, so an average over few games
      // isn't diluted by zeros from games we never fetched a timeline for.
      if (m.gold_diff_15 !== null && m.gold_diff_15 !== undefined) {
        entry.goldDiffSum += m.gold_diff_15;
        entry.goldDiffCount++;
      }

      map.set(champ, entry);
    }

    return [...map.entries()]
      .map(([champion, s]) => ({
        champion,
        championId: s.championId,
        games: s.games,
        wins: s.wins,
        losses: s.games - s.wins,
        winRate: s.games ? (s.wins / s.games) * 100 : 0,
        kills: s.kills / s.games,
        deaths: s.deaths / s.games,
        assists: s.assists / s.games,
        kda: s.deaths > 0 ? (s.kills + s.assists) / s.deaths : s.kills + s.assists,
        csPerMin: s.csPerMinSum / s.games,
        damagePerMin: s.dmgPerMinSum / s.games,
        damageTakenPerMin: s.dmgTakenPerMinSum / s.games,
        goldDiff15: s.goldDiffCount > 0 ? s.goldDiffSum / s.goldDiffCount : null,
      }))
      .sort((a, b) => b.games - a.games);
  }

  /** Aggregate row across every match, for the "All Champions" summary line. */
  overallStats(matches: MatchCacheRow[]): ChampionStatRow | null {
    if (!matches.length) return null;
    const all = this.championStats(matches);
    if (!all.length) return null;

    const games = all.reduce((n, c) => n + c.games, 0);
    const wins = all.reduce((n, c) => n + c.wins, 0);
    const weighted = (pick: (c: ChampionStatRow) => number) =>
      all.reduce((n, c) => n + pick(c) * c.games, 0) / games;

    const withDiff = all.filter((c) => c.goldDiff15 !== null);
    const diffGames = withDiff.reduce((n, c) => n + c.games, 0);

    const kills = weighted((c) => c.kills);
    const deaths = weighted((c) => c.deaths);
    const assists = weighted((c) => c.assists);

    return {
      champion: 'All Champions',
      championId: 0,
      games,
      wins,
      losses: games - wins,
      winRate: (wins / games) * 100,
      kills,
      deaths,
      assists,
      kda: deaths > 0 ? (kills + assists) / deaths : kills + assists,
      csPerMin: weighted((c) => c.csPerMin),
      damagePerMin: weighted((c) => c.damagePerMin),
      damageTakenPerMin: weighted((c) => c.damageTakenPerMin),
      goldDiff15:
        diffGames > 0
          ? withDiff.reduce((n, c) => n + (c.goldDiff15 ?? 0) * c.games, 0) / diffGames
          : null,
    };
  }

  /** Win rate and KDA split by role, for the role performance panel. */
  rolePerformance(matches: MatchCacheRow[]): RolePerformanceRow[] {
    const map = new Map<
      string,
      { games: number; wins: number; kills: number; deaths: number; assists: number }
    >();

    for (const m of matches) {
      const role = m.position || 'UNKNOWN';
      if (role === 'UNKNOWN' || role === '') continue;
      const e = map.get(role) ?? { games: 0, wins: 0, kills: 0, deaths: 0, assists: 0 };
      e.games++;
      if (m.win === 1) e.wins++;
      e.kills += m.kills ?? 0;
      e.deaths += m.deaths ?? 0;
      e.assists += m.assists ?? 0;
      map.set(role, e);
    }

    const total = [...map.values()].reduce((n, e) => n + e.games, 0);

    return [...map.entries()]
      .map(([role, e]) => ({
        role: ROLE_LABELS[role] ?? role,
        games: e.games,
        wins: e.wins,
        winRate: (e.wins / e.games) * 100,
        kda: e.deaths > 0 ? (e.kills + e.assists) / e.deaths : e.kills + e.assists,
        share: total ? (e.games / total) * 100 : 0,
      }))
      .sort((a, b) => b.games - a.games);
  }

  /**
   * Players seen most often alongside (or against) the account.
   *
   * Grouped by puuid, not display name: the cached summary historically stored
   * `riotIdGameName` without a tagline, so names alone collide.
   */
  playedWith(
    matches: MatchCacheRow[],
    selfPuuid: string,
    mode: 'with' | 'against',
    minGames = 2
  ): PlayedWithRow[] {
    const map = new Map<
      string,
      { name: string; tagline: string; games: number; wins: number; champs: Set<string> }
    >();

    for (const m of matches) {
      const participants = this.participantsOf(m);
      if (!participants.length) continue;

      const me = participants.find((p) => p.puuid === selfPuuid);
      if (!me) continue;

      for (const p of participants) {
        if (p.puuid === selfPuuid) continue;
        const sameTeam = p.teamId === me.teamId;
        if (mode === 'with' ? !sameTeam : sameTeam) continue;

        const e = map.get(p.puuid) ?? {
          name: p.riotIdGameName || 'Unknown',
          tagline: p.riotIdTagline || '',
          games: 0,
          wins: 0,
          champs: new Set<string>(),
        };
        e.games++;
        // For opponents, "wins" counts games where WE won, so the rate always
        // reads from the account holder's perspective.
        if (m.win === 1) e.wins++;
        if (p.championName) e.champs.add(p.championName);
        // Prefer the most recent non-empty tagline we have seen.
        if (!e.tagline && p.riotIdTagline) e.tagline = p.riotIdTagline;
        map.set(p.puuid, e);
      }
    }

    return [...map.entries()]
      .filter(([, e]) => e.games >= minGames)
      .map(([puuid, e]) => ({
        puuid,
        name: e.name,
        tagline: e.tagline,
        games: e.games,
        wins: e.wins,
        winRate: (e.wins / e.games) * 100,
        championsPlayed: [...e.champs],
      }))
      .sort((a, b) => b.games - a.games || b.winRate - a.winRate);
  }

  /** Most played champions, highest game count first. */
  mostPlayed(matches: MatchCacheRow[], limit = 5): ChampionStatRow[] {
    return this.championStats(matches).slice(0, limit);
  }

  /** Longest current streak of the same result, from the newest match backwards. */
  currentStreak(matches: MatchCacheRow[]): { type: 'win' | 'loss' | 'none'; count: number } {
    const sorted = [...matches].sort((a, b) => b.timestamp - a.timestamp);
    const first = sorted.find((m) => m.win !== null);
    if (!first) return { type: 'none', count: 0 };

    const target = first.win;
    let count = 0;
    for (const m of sorted) {
      if (m.win === null) continue;
      if (m.win !== target) break;
      count++;
    }
    return { type: target === 1 ? 'win' : 'loss', count };
  }
}
