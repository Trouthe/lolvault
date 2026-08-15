import { Injectable } from '@angular/core';
import { MatchCacheRow, RankSnapshot } from '../../../../types/electron';
import {
  ActivityDay,
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
  /** Summoner icon id. Absent on rows cached before it was recorded. */
  profileIcon?: number;
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

/**
 * `match_cache.raw_json` — the account holder's own full participant record
 * spread at the root, plus the trimmed roster under `_allParticipants`.
 */
interface RawJsonShape {
  _allParticipants?: ParticipantSummary[];
  totalDamageTaken?: number;
  pentaKills?: number;
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
        pentaKills: number;
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
        pentaKills: 0,
      };

      const minutes = (m.duration_seconds ?? 0) / 60;
      const raw = m.raw_json as RawJsonShape;

      entry.games++;
      if (m.win === 1) entry.wins++;
      entry.kills += m.kills ?? 0;
      entry.deaths += m.deaths ?? 0;
      entry.assists += m.assists ?? 0;
      entry.csPerMinSum += m.cs_per_min ?? 0;
      if (minutes > 0) {
        entry.dmgPerMinSum += (m.damage_dealt ?? 0) / minutes;
        if (typeof raw?.totalDamageTaken === 'number') {
          entry.dmgTakenPerMinSum += raw.totalDamageTaken / minutes;
        }
      }
      // raw_json spreads the account holder's own participant record, so the
      // pentakill count is available without fetching match detail.
      if (typeof raw?.pentaKills === 'number') entry.pentaKills += raw.pentaKills;

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
        pentaKills: s.pentaKills,
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
      pentaKills: all.reduce((n, c) => n + c.pentaKills, 0),
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
        roleKey: role,
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
      {
        name: string;
        tagline: string;
        games: number;
        wins: number;
        champs: Set<string>;
        profileIcon: number;
      }
    >();

    // Newest first, so the first icon we see for a player is their latest.
    matches = [...matches].sort((a, b) => b.timestamp - a.timestamp);

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
          profileIcon: 0,
        };
        if (!e.profileIcon && p.profileIcon) e.profileIcon = p.profileIcon;
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
        profileIcon: e.profileIcon,
      }))
      .sort((a, b) => b.games - a.games || b.winRate - a.winRate);
  }

  /** Most played champions, highest game count first. */
  mostPlayed(matches: MatchCacheRow[], limit = 5): ChampionStatRow[] {
    return this.championStats(matches).slice(0, limit);
  }

  /**
   * Recent form over the last `size` games, newest first.
   *
   * `mvp` is derived from our own per-match rating (see MatchScoreService) —
   * Riot exposes no MVP flag, so it is computed from the participant summary
   * that every cached match carries.
   */
  recentRecord(
    matches: MatchCacheRow[],
    selfPuuid: string,
    scorer: (row: MatchCacheRow) => { isMvp: boolean } | null,
    size = 20
  ): {
    games: { matchId: string; win: boolean; mvp: boolean; timestamp: number }[];
    wins: number;
    losses: number;
    winRate: number;
    avgKda: number;
  } | null {
    const recent = [...matches]
      .sort((a, b) => b.timestamp - a.timestamp)
      .filter((m) => m.win !== null)
      .slice(0, size);

    if (!recent.length || !selfPuuid) return null;

    let kills = 0;
    let deaths = 0;
    let assists = 0;

    const games = recent.map((m) => {
      kills += m.kills ?? 0;
      deaths += m.deaths ?? 0;
      assists += m.assists ?? 0;
      return {
        matchId: m.match_id,
        win: m.win === 1,
        mvp: !!scorer(m)?.isMvp,
        timestamp: m.timestamp,
      };
    });

    const wins = games.filter((g) => g.win).length;

    return {
      games,
      wins,
      losses: games.length - wins,
      winRate: (wins / games.length) * 100,
      avgKda: deaths === 0 ? kills + assists : (kills + assists) / deaths,
    };
  }

  /** Headline averages shown beside the recent record. */
  averages(matches: MatchCacheRow[], selfPuuid: string): {
    csPerMin: number;
    killParticipation: number;
    visionPerMin: number;
    damagePerMin: number;
    kills: number;
    deaths: number;
    assists: number;
    games: number;
  } | null {
    const usable = matches.filter((m) => (m.duration_seconds ?? 0) > 0);
    if (!usable.length) return null;

    let csPerMin = 0;
    let visionPerMin = 0;
    let damagePerMin = 0;
    let kpSum = 0;
    let kpGames = 0;
    let kills = 0;
    let deaths = 0;
    let assists = 0;

    for (const m of usable) {
      kills += m.kills ?? 0;
      deaths += m.deaths ?? 0;
      assists += m.assists ?? 0;
      const minutes = (m.duration_seconds ?? 0) / 60;
      csPerMin += m.cs_per_min ?? (m.cs ?? 0) / minutes;
      visionPerMin += (m.vision_score ?? 0) / minutes;
      damagePerMin += (m.damage_dealt ?? 0) / minutes;

      const participants = this.participantsOf(m);
      const me = participants.find((p) => p.puuid === selfPuuid);
      if (me) {
        const teamKills = participants
          .filter((p) => p.teamId === me.teamId)
          .reduce((n, p) => n + p.kills, 0);
        if (teamKills > 0) {
          kpSum += (me.kills + me.assists) / teamKills;
          kpGames++;
        }
      }
    }

    const n = usable.length;
    return {
      csPerMin: csPerMin / n,
      killParticipation: kpGames ? (kpSum / kpGames) * 100 : 0,
      visionPerMin: visionPerMin / n,
      damagePerMin: damagePerMin / n,
      kills: kills / n,
      deaths: deaths / n,
      assists: assists / n,
      games: n,
    };
  }

  /** Calendar years with any cached game or recorded rank reading, newest first. */
  activityYears(matches: MatchCacheRow[], rankSeries: RankSnapshot[] = []): number[] {
    const years = new Set<number>();
    for (const m of matches) if (m.timestamp > 0) years.add(new Date(m.timestamp).getFullYear());
    // A year the recorder covered but the match cache does not still has a grid
    // worth showing — LP moved, even if no game from it was ever pulled.
    for (const row of rankSeries) {
      const year = Number(row.day.slice(0, 4));
      if (year) years.add(year);
    }
    // The current year is always offered, even before its first game.
    years.add(new Date().getFullYear());
    return [...years].sort((a, b) => b - a);
  }

  /**
   * Day-by-day activity heatmap for one calendar year.
   *
   * Two sources, merged per day (see `ActivityDay` for which knows what):
   * cached games give the win/loss record, and the recorded rank series gives
   * LP movement plus a games count for days no game was ever cached. A day the
   * rank series knows about is a real day played — Riot's own `wins + losses`
   * counters moved — so it is drawn rather than left blank, just without a
   * record it cannot know.
   *
   * The grid always spans Jan-Dec so the strip keeps its shape as the year fills
   * in. Three states are distinguished: days before we hold any data, days in
   * the future, and days that genuinely had no games.
   */
  activityGrid(
    matches: MatchCacheRow[],
    year: number = new Date().getFullYear(),
    rankSeries: RankSnapshot[] = []
  ): {
    weeks: ActivityDay[][];
    monthLabels: { index: number; label: string }[];
    startDate: Date;
    totalGames: number;
    totalWins: number;
    /**
     * Games whose result we actually know — the cached ones.
     *
     * Never divide `totalWins` by `totalGames`: the latter includes days known
     * only from the rank series, which contribute a count but no wins. Doing so
     * reports a win rate that falls as the grid gets *more* complete.
     */
    ratedGames: number;
    /** Busiest day in the year, used to scale the colour ramp. */
    busiestDay: number;
  } {
    const stamps = matches.map((m) => m.timestamp).filter((t) => t > 0);

    const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    const startOfDay = (t: number) => {
      const d = new Date(t);
      d.setHours(0, 0, 0, 0);
      return d;
    };

    const perDay = new Map<string, { wins: number; losses: number }>();

    for (const m of matches) {
      if (m.win === null) continue;
      const key = dayKey(new Date(m.timestamp));
      const entry = perDay.get(key) ?? { wins: 0, losses: 0 };
      if (m.win === 1) entry.wins++;
      else entry.losses++;
      perDay.set(key, entry);
    }

    // The rank series is keyed by local 'YYYY-MM-DD' strings; re-key it the same
    // way the match map is so a day is looked up once, by one kind of key.
    const rankByDay = new Map<string, RankSnapshot>();
    for (const row of rankSeries) {
      const [y, m, d] = row.day.split('-').map(Number);
      if (!y || !m || !d) continue;
      rankByDay.set(dayKey(new Date(y, m - 1, d)), row);
    }

    const today = startOfDay(Date.now());
    // With nothing cached, every past day is genuinely "no data" rather than
    // "played nothing" — and the grid still renders, so the control that fills
    // it in is reachable instead of being hidden behind an empty state.
    //
    // The rank series counts towards this too: a recorded day is a tracked day
    // even when no game from it was ever pulled, which is exactly the case on a
    // fresh install where the recorder has been running longer than the cache.
    const rankStamps = rankSeries
      .map((row) => {
        const [y, m, d] = row.day.split('-').map(Number);
        return y && m && d ? new Date(y, m - 1, d).getTime() : 0;
      })
      .filter((t) => t > 0);

    const allStamps = [...stamps, ...rankStamps];
    const earliest = allStamps.length ? startOfDay(Math.min(...allStamps)) : today;

    // Grid columns are calendar weeks starting Monday.
    const mondayOf = (d: Date) => {
      const copy = new Date(d);
      const dow = (copy.getDay() + 6) % 7;
      copy.setDate(copy.getDate() - dow);
      copy.setHours(0, 0, 0, 0);
      return copy;
    };

    const yearEnd = new Date(year, 11, 31);
    const cursor = mondayOf(new Date(year, 0, 1));

    const weeks: ActivityDay[][] = [];
    const monthLabels: { index: number; label: string }[] = [];
    let lastMonth = -1;
    let totalGames = 0;
    let totalWins = 0;
    let ratedGames = 0;
    let busiestDay = 0;
    let col = 0;

    while (cursor <= yearEnd) {
      const week: ActivityDay[] = [];

      for (let row = 0; row < 7; row++) {
        const date = new Date(cursor);
        date.setDate(cursor.getDate() + row);

        const key = dayKey(date);
        const entry = perDay.get(key);
        // Days from the neighbouring year that fall in an edge week are shown
        // as padding rather than being counted.
        const outsideYear = date.getFullYear() !== year;
        const reading = outsideYear ? undefined : rankByDay.get(key);

        const wins = outsideYear ? 0 : (entry?.wins ?? 0);
        const losses = outsideYear ? 0 : (entry?.losses ?? 0);
        const cachedGames = wins + losses;

        // A day with cached games is described by them. A day with none but a
        // rank reading that moved Riot's counters was still played, so its game
        // count comes from there — flagged, because there is no record to show.
        const recordedGames = reading?.games ?? 0;
        const estimated = cachedGames === 0 && recordedGames > 0;
        const games = cachedGames || recordedGames;

        totalGames += games;
        totalWins += wins;
        ratedGames += cachedGames;
        if (games > busiestDay) busiestDay = games;

        week.push({
          date,
          wins,
          losses,
          games,
          future: date > today,
          untracked: outsideYear || date < earliest,
          estimated,
        });
      }

      // Label a column with the month its first in-year day belongs to.
      const labelDay = week.find((d) => d.date.getFullYear() === year) ?? week[0];
      const month = labelDay.date.getMonth();
      if (month !== lastMonth) {
        monthLabels.push({
          index: col,
          label: labelDay.date.toLocaleDateString(undefined, { month: 'short' }),
        });
        lastMonth = month;
      }

      weeks.push(week);
      cursor.setDate(cursor.getDate() + 7);
      col++;
    }

    return {
      weeks,
      monthLabels,
      startDate: earliest,
      totalGames,
      totalWins,
      ratedGames,
      busiestDay,
    };
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
