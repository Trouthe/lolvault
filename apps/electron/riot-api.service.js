'use strict';

/**
 * Riot API service — Electron main-process only.
 * Never import this file from Angular renderer code.
 *
 * Uses twisted for Account, Summoner, and MatchV5 APIs (rate-limit aware).
 * Uses native fetch for endpoints not yet in twisted (mastery, ranked-by-puuid).
 */

const { LolApi, RiotApi } = require('twisted');
const db = require('./database');
const limiter = require('./rate-limiter');
const {
  compactTimeline,
  computeDiffsAtMinute,
  findLaneOpponent,
} = require('./timeline-compact');

// ── Region routing ────────────────────────────────────────────────────────────

/** Riot platform slug → regional routing for Account/MatchV5 APIs */
const PLATFORM_TO_REGION = {
  euw1: 'EUROPE',
  eun1: 'EUROPE',
  tr1: 'EUROPE',
  ru: 'EUROPE',
  na1: 'AMERICAS',
  br1: 'AMERICAS',
  la1: 'AMERICAS',
  la2: 'AMERICAS',
  kr: 'ASIA',
  jp1: 'ASIA',
  oc1: 'SEA',
  ph2: 'SEA',
  sg2: 'SEA',
  tw2: 'SEA',
  vn2: 'SEA',
};

// ── API key ───────────────────────────────────────────────────────────────────

function getApiKey() {
  return db.getEncryptedSetting('riot_api_key');
}

function saveApiKey(key) {
  db.setEncryptedSetting('riot_api_key', key || null);
}

// ── Client factory ────────────────────────────────────────────────────────────

/**
 * Creates fresh API clients. Always fresh — key may have changed.
 * Returns { lol, riot } where:
 *   lol  = LolApi (Summoner, League, MatchV5, Champion…)
 *   riot = RiotApi (Account v1)
 */
function createClients(overrideKey) {
  const key = overrideKey || getApiKey();
  if (!key) {
    const err = new Error('No Riot API key configured');
    err.code = 'NO_KEY';
    throw err;
  }
  return { lol: new LolApi({ key }), riot: new RiotApi({ key }) };
}

// ── Rate-limited dispatch ─────────────────────────────────────────────────────

/**
 * Routes a Riot call through the global rate limiter, which paces requests
 * against Riot's per-key windows and handles 429 backoff centrally.
 * Pass `{ interactive: true }` for user-initiated work so it is served ahead of
 * background backfill.
 */
function withRetry(fn, opts) {
  return limiter.enqueue(fn, opts);
}

/** Fetch with API key, paced by the shared limiter. Returns parsed JSON or throws. */
async function riotFetch(url, overrideKey, opts) {
  const key = overrideKey || getApiKey();
  if (!key) throw Object.assign(new Error('No API key'), { code: 'NO_KEY' });

  const doFetch = async () => {
    const res = await fetch(url, {
      headers: { 'X-Riot-Token': key, Accept: 'application/json' },
    });
    if (!res.ok) {
      const err = new Error(String(res.status));
      err.status = res.status;
      // Surface Retry-After so the limiter can honour Riot's own backoff hint.
      const retryAfter = res.headers.get('retry-after');
      if (retryAfter) err.retryAfter = retryAfter;
      throw err;
    }
    return res.json();
  };

  return withRetry(doFetch, opts);
}

// ── Summoner by Riot ID ───────────────────────────────────────────────────────

/**
 * Returns { puuid, summonerId, accountId, profileIconId, summonerLevel, gameName, tagLine }
 * or { error: 'invalid_key' } / null on known errors.
 */
async function getSummonerByRiotId(gameName, tagLine, platform) {
  try {
    const { lol, riot } = createClients();
    const region = PLATFORM_TO_REGION[platform] || 'EUROPE';

    const { response: account } = await withRetry(() =>
      riot.Account.getByRiotId(gameName, tagLine, region)
    );
    const { puuid, gameName: gn, tagLine: tl } = account;

    const { response: summoner } = await withRetry(() => lol.Summoner.getByPUUID(puuid, platform));
    const { id: summonerId, accountId, profileIconId, summonerLevel } = summoner;

    return {
      puuid,
      summonerId,
      accountId,
      profileIconId,
      summonerLevel,
      gameName: gn,
      tagLine: tl,
    };
  } catch (err) {
    if (err?.code === 'NO_KEY') return { error: 'no_key' };
    const status = err?.status || Number(err?.message);
    if (status === 403 || status === 401) return { error: 'invalid_key' };
    if (status === 404) return null;
    console.error('[RiotAPI] getSummonerByRiotId error:', err?.message);
    return null;
  }
}

// ── Summoner by PUUID ─────────────────────────────────────────────────────────

/** Returns { id, accountId, puuid, profileIconId, summonerLevel } or null. */
async function getSummonerByPuuid(puuid, platform) {
  try {
    const { lol } = createClients();
    const { response } = await withRetry(() => lol.Summoner.getByPUUID(puuid, platform));
    return response;
  } catch (err) {
    if (err?.code === 'NO_KEY') return { error: 'no_key' };
    const status = err?.status || Number(err?.message);
    if (status === 403 || status === 401) return { error: 'invalid_key' };
    if (status === 404) return null;
    console.error('[RiotAPI] getSummonerByPuuid error:', err?.message);
    return null;
  }
}

// ── Ranked stats by PUUID ─────────────────────────────────────────────────────

/** Returns array of queue entries (may be empty for unranked) or { error }. */
async function getRankedByPuuid(puuid, platform) {
  try {
    const url = `https://${platform}.api.riotgames.com/lol/league/v4/entries/by-puuid/${encodeURIComponent(puuid)}`;
    return await riotFetch(url);
  } catch (err) {
    if (err?.code === 'NO_KEY') return { error: 'no_key' };
    const status = err?.status || Number(err?.message);
    if (status === 403 || status === 401) return { error: 'invalid_key' };
    if (status === 404) return [];
    console.error('[RiotAPI] getRankedByPuuid error:', err?.message);
    return { error: err?.message || 'unknown' };
  }
}

// ── Champion mastery ──────────────────────────────────────────────────────────

/** Returns top mastery champion array or [] on error. */
async function getTopMasteryChampions(puuid, platform) {
  try {
    const url = `https://${platform}.api.riotgames.com/lol/champion-mastery/v4/champion-masteries/by-puuid/${encodeURIComponent(puuid)}/top`;
    return await riotFetch(url);
  } catch (err) {
    if (err?.code === 'NO_KEY') return { error: 'no_key' };
    const status = err?.status || Number(err?.message);
    if (status === 403 || status === 401) return { error: 'invalid_key' };
    console.error('[RiotAPI] getTopMasteryChampions error:', err?.message);
    return [];
  }
}

// ── Match history ─────────────────────────────────────────────────────────────

/**
 * Riot queue id → stable queue label.
 * Previously the queue type was hardcoded to RANKED_SOLO_5x5 for every row,
 * which silently mislabels every game once we fetch more than queue 420.
 * `queue_id` is the source of truth; this label exists for display/back-compat.
 */
const QUEUE_LABELS = {
  400: 'NORMAL_DRAFT',
  420: 'RANKED_SOLO_5x5',
  430: 'NORMAL_BLIND',
  440: 'RANKED_FLEX_SR',
  450: 'ARAM',
  700: 'CLASH',
  1700: 'ARENA',
};

/** Queues fetched by default — enough to back the Overview mode toggle. */
const DEFAULT_QUEUES = [420, 440, 400, 430];

function queueLabel(queueId) {
  return QUEUE_LABELS[queueId] || (queueId != null ? `QUEUE_${queueId}` : null);
}

/** Trimmed per-participant summary kept inline on match_cache.raw_json. */
function summariseParticipant(p) {
  return {
    puuid: p.puuid,
    riotIdGameName: p.riotIdGameName || p.summonerName || '',
    riotIdTagline: p.riotIdTagline || '',
    championName: p.championName || '',
    championId: p.championId ?? 0,
    teamId: p.teamId,
    kills: p.kills ?? 0,
    deaths: p.deaths ?? 0,
    assists: p.assists ?? 0,
    cs: (p.totalMinionsKilled || 0) + (p.neutralMinionsKilled || 0),
    totalDamageDealtToChampions: p.totalDamageDealtToChampions ?? 0,
    goldEarned: p.goldEarned ?? 0,
    items: [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5, p.item6],
    win: p.win,
    teamPosition: p.teamPosition || '',
    visionScore: p.visionScore ?? 0,
  };
}

/**
 * Full per-participant record for the match detail tabs — damage breakdown,
 * runes, spells and ping counts that the trimmed summary drops.
 */
function detailParticipant(p) {
  return {
    ...summariseParticipant(p),
    participantId: p.participantId,
    champLevel: p.champLevel ?? 0,
    summoner1Id: p.summoner1Id ?? 0,
    summoner2Id: p.summoner2Id ?? 0,
    physicalDamageDealtToChampions: p.physicalDamageDealtToChampions ?? 0,
    magicDamageDealtToChampions: p.magicDamageDealtToChampions ?? 0,
    trueDamageDealtToChampions: p.trueDamageDealtToChampions ?? 0,
    totalDamageTaken: p.totalDamageTaken ?? 0,
    physicalDamageTaken: p.physicalDamageTaken ?? 0,
    magicDamageTaken: p.magicDamageTaken ?? 0,
    trueDamageTaken: p.trueDamageTaken ?? 0,
    damageSelfMitigated: p.damageSelfMitigated ?? 0,
    totalHeal: p.totalHeal ?? 0,
    totalHealsOnTeammates: p.totalHealsOnTeammates ?? 0,
    totalDamageShieldedOnTeammates: p.totalDamageShieldedOnTeammates ?? 0,
    damageDealtToTurrets: p.damageDealtToTurrets ?? 0,
    damageDealtToObjectives: p.damageDealtToObjectives ?? 0,
    totalMinionsKilled: p.totalMinionsKilled ?? 0,
    neutralMinionsKilled: p.neutralMinionsKilled ?? 0,
    wardsPlaced: p.wardsPlaced ?? 0,
    wardsKilled: p.wardsKilled ?? 0,
    visionWardsBoughtInGame: p.visionWardsBoughtInGame ?? 0,
    firstBloodKill: !!p.firstBloodKill,
    doubleKills: p.doubleKills ?? 0,
    tripleKills: p.tripleKills ?? 0,
    quadraKills: p.quadraKills ?? 0,
    pentaKills: p.pentaKills ?? 0,
    timeCCingOthers: p.timeCCingOthers ?? 0,
    totalTimeSpentDead: p.totalTimeSpentDead ?? 0,
    goldSpent: p.goldSpent ?? 0,
    perks: p.perks ?? null,
    gameEndedInSurrender: !!p.gameEndedInSurrender,
    gameEndedInEarlySurrender: !!p.gameEndedInEarlySurrender,
  };
}

/** Persists bans, objectives and full participant records for a match. */
function persistMatchDetail(matchId, match) {
  db.saveMatchDetail(matchId, {
    queueId: match.info.queueId ?? null,
    gameVersion: match.info.gameVersion ?? null,
    gameMode: match.info.gameMode ?? null,
    gameDuration: match.info.gameDuration ?? null,
    teams: (match.info.teams || []).map((t) => ({
      teamId: t.teamId,
      win: t.win,
      bans: (t.bans || []).map((b) => ({ championId: b.championId, pickTurn: b.pickTurn })),
      objectives: t.objectives || {},
    })),
    participants: (match.info.participants || []).map(detailParticipant),
  });
}

/** Stores one MatchV5 response into match_cache + match_detail. */
function persistMatch(matchId, accountId, puuid, match) {
  const participant = match.info.participants.find((p) => p.puuid === puuid);
  if (!participant) return false;

  const cs = (participant.totalMinionsKilled || 0) + (participant.neutralMinionsKilled || 0);
  const gameDurationMin = (match.info.gameDuration || 0) / 60;
  const csPerMin = gameDurationMin > 0 ? cs / gameDurationMin : 0;

  const damageOf = (p) =>
    (p.physicalDamageDealtToChampions || 0) +
    (p.magicDamageDealtToChampions || 0) +
    (p.trueDamageDealtToChampions || 0);

  const teamDamage = match.info.participants
    .filter((p) => p.teamId === participant.teamId)
    .reduce((sum, p) => sum + damageOf(p), 0);
  const damageShare = teamDamage > 0 ? damageOf(participant) / teamDamage : 0;

  const items = [
    participant.item0,
    participant.item1,
    participant.item2,
    participant.item3,
    participant.item4,
    participant.item5,
    participant.item6,
  ];

  const rawData = {
    ...participant,
    _allParticipants: match.info.participants.map(summariseParticipant),
  };

  const queueId = match.info.queueId ?? null;

  db.saveMatchCache(
    matchId,
    accountId,
    {
      puuid,
      champion: participant.championName || null,
      championId: participant.championId ?? null,
      participantId: participant.participantId ?? null,
      teamId: participant.teamId ?? null,
      position: participant.teamPosition || null,
      win: participant.win,
      kills: participant.kills ?? null,
      deaths: participant.deaths ?? null,
      assists: participant.assists ?? null,
      cs,
      csPerMin: Math.round(csPerMin * 10) / 10,
      damageDealt: participant.totalDamageDealtToChampions ?? null,
      damageShare: Math.round(damageShare * 1000) / 1000,
      gold: participant.goldEarned ?? null,
      visionScore: participant.visionScore ?? null,
      durationSeconds: match.info.gameDuration ?? null,
      items,
      lpBefore: null,
      lpAfter: null,
      lpDelta: null,
      queueId,
      queueType: queueLabel(queueId),
      gameVersion: match.info.gameVersion ?? null,
      timestamp: match.info.gameStartTimestamp || Date.now(),
    },
    rawData
  );

  // Free: the full payload is already in memory, so detail costs no extra call.
  persistMatchDetail(matchId, match);
  return true;
}

/**
 * Fetches new matches across the requested queues, inserts them into SQLite,
 * then returns cached rows for the account sorted by timestamp DESC.
 */
async function fetchAndCacheMatchHistory(accountId, puuid, platform, count = 20, queues) {
  try {
    const { lol } = createClients();
    const region = PLATFORM_TO_REGION[platform] || 'EUROPE';
    const queueList = Array.isArray(queues) && queues.length ? queues : DEFAULT_QUEUES;

    // MatchV5.list accepts a single queue per call, so fan out across queues.
    const idSets = await Promise.all(
      queueList.map(async (queue) => {
        try {
          const { response } = await withRetry(() =>
            lol.MatchV5.list(puuid, region, { queue, count })
          );
          return Array.isArray(response) ? response : [];
        } catch (err) {
          console.warn(`[RiotAPI] Match list failed for queue ${queue}:`, err?.message);
          return [];
        }
      })
    );

    const matchIds = [...new Set(idSets.flat())];
    if (matchIds.length === 0) return db.getMatchCache(accountId, count);

    // Re-fetch rows that exist but predate the detail table, so older cached
    // matches gain bans/objectives/damage breakdown rather than staying partial.
    const newMatchIds = matchIds.filter(
      (id) => !db.hasMatchInCache(id) || !db.hasMatchDetail(id)
    );

    for (const matchId of newMatchIds) {
      try {
        const { response: match } = await withRetry(() => lol.MatchV5.get(matchId, region));
        persistMatch(matchId, accountId, puuid, match);
      } catch (matchErr) {
        console.warn('[RiotAPI] Failed to fetch match', matchId, matchErr?.message);
      }
    }

    return db.getMatchCache(accountId, count);
  } catch (err) {
    if (err?.code === 'NO_KEY') return { error: 'no_key' };
    const status = err?.status || Number(err?.message);
    if (status === 403 || status === 401) return { error: 'invalid_key' };
    console.error('[RiotAPI] fetchAndCacheMatchHistory error:', err?.message);
    return { error: err?.message || 'unknown' };
  }
}

// ── Match timeline ────────────────────────────────────────────────────────────

/**
 * Returns the compacted timeline for a match, fetching and caching it on first
 * request. Interactive by default so a user expanding a card is served ahead of
 * any background backfill.
 */
async function getMatchTimeline(matchId, platform, { interactive = true } = {}) {
  const cached = db.getMatchTimeline(matchId);
  if (cached) return cached;

  try {
    const { lol } = createClients();
    const region = PLATFORM_TO_REGION[platform] || 'EUROPE';

    const { response } = await withRetry(
      () => lol.MatchV5.timeline(matchId, region),
      { interactive }
    );

    const compact = compactTimeline(response);
    db.saveMatchTimeline(matchId, compact);

    // Denormalise @15 diffs so the Champions table stays a single indexed query.
    const detail = db.getMatchDetail(matchId);
    const row = db.getMatchCacheRow(matchId);
    if (detail?.participants?.length && row?.participant_id) {
      const opponent = findLaneOpponent(detail.participants, row.puuid);
      if (opponent?.participantId) {
        const diffs = computeDiffsAtMinute(compact, row.participant_id, opponent.participantId, 15);
        if (diffs) {
          db.updateMatchDiffs(matchId, {
            goldDiff: diffs.goldDiff,
            csDiff: diffs.csDiff,
            xpDiff: diffs.xpDiff,
          });
        }
      }
    }

    return db.getMatchTimeline(matchId);
  } catch (err) {
    if (err?.code === 'NO_KEY') return { error: 'no_key' };
    const status = err?.status || Number(err?.message);
    if (status === 403 || status === 401) return { error: 'invalid_key' };
    if (status === 404) return { error: 'not_found' };
    console.error('[RiotAPI] getMatchTimeline error:', err?.message);
    return { error: err?.message || 'unknown' };
  }
}

/**
 * Fetches match detail on demand for a cached match that predates the detail
 * table (or whose earlier fetch failed).
 */
async function getMatchDetailCached(matchId, accountId, puuid, platform) {
  const cached = db.getMatchDetail(matchId);
  if (cached) return cached;

  try {
    const { lol } = createClients();
    const region = PLATFORM_TO_REGION[platform] || 'EUROPE';
    const { response: match } = await withRetry(() => lol.MatchV5.get(matchId, region), {
      interactive: true,
    });
    persistMatch(matchId, accountId, puuid, match);
    return db.getMatchDetail(matchId);
  } catch (err) {
    if (err?.code === 'NO_KEY') return { error: 'no_key' };
    const status = err?.status || Number(err?.message);
    if (status === 403 || status === 401) return { error: 'invalid_key' };
    console.error('[RiotAPI] getMatchDetailCached error:', err?.message);
    return { error: err?.message || 'unknown' };
  }
}

/**
 * Backfills detail and/or timeline for cached matches missing them.
 *
 * Runs at background priority so interactive work stays responsive, reports
 * progress through `onProgress`, and stops early when `shouldCancel()` returns
 * true so the UI can offer a real cancel rather than a stuck spinner.
 */
async function backfillMatchData(
  accountId,
  puuid,
  platform,
  { limit = 200, onProgress = () => {}, shouldCancel = () => false } = {}
) {
  const pending = db.getMatchesNeedingBackfill(accountId, limit);
  const requestCount = pending.reduce(
    (n, m) => n + (m.has_detail ? 0 : 1) + (m.has_timeline ? 0 : 1),
    0
  );

  const total = pending.length;
  let processed = 0;
  let failed = 0;

  onProgress({
    processed,
    total,
    failed,
    etaSeconds: limiter.estimateSeconds(requestCount),
    done: total === 0,
  });
  if (total === 0) return { processed: 0, total: 0, failed: 0, cancelled: false };

  const { lol } = createClients();
  const region = PLATFORM_TO_REGION[platform] || 'EUROPE';

  for (const row of pending) {
    if (shouldCancel()) {
      return { processed, total, failed, cancelled: true };
    }

    try {
      if (!row.has_detail) {
        const { response: match } = await withRetry(() => lol.MatchV5.get(row.match_id, region), {
          interactive: false,
        });
        persistMatch(row.match_id, accountId, row.puuid || puuid, match);
      }
      if (!row.has_timeline) {
        await getMatchTimeline(row.match_id, platform, { interactive: false });
      }
    } catch (err) {
      failed++;
      console.warn('[RiotAPI] Backfill failed for', row.match_id, err?.message);
    }

    processed++;
    const remaining = db
      .getMatchesNeedingBackfill(accountId, limit)
      .reduce((n, m) => n + (m.has_detail ? 0 : 1) + (m.has_timeline ? 0 : 1), 0);
    onProgress({
      processed,
      total,
      failed,
      etaSeconds: limiter.estimateSeconds(remaining),
      done: processed >= total,
    });
  }

  return { processed, total, failed, cancelled: false };
}

// ── API key validation ────────────────────────────────────────────────────────

/**
 * Validates a key by calling the EUW master league endpoint.
 * Returns { valid: true }, { valid: false, reason }, or { error }.
 */
async function validateApiKey(keyToTest) {
  try {
    const { lol } = createClients(keyToTest);
    await withRetry(() => lol.League.getMasterLeagueByQueue('RANKED_SOLO_5x5', 'euw1'));
    return { valid: true };
  } catch (err) {
    const status = err?.status || Number(err?.message);
    if (status === 429) return { valid: true, reason: 'Valid but rate limited' };
    if (status === 403 || status === 401) return { valid: false, reason: 'Invalid key' };
    console.error('[RiotAPI] validateApiKey error:', err?.message);
    return { error: err?.message || 'unknown' };
  }
}

// ── Data Dragon version ───────────────────────────────────────────────────────

let _cachedDDragonVersion = null;

/** Returns the latest DDragon version string, cached in SQLite after first fetch. */
async function getDDragonVersion() {
  if (_cachedDDragonVersion) return _cachedDDragonVersion;

  const cached = db.getSetting('ddragon_version');
  if (cached) {
    _cachedDDragonVersion = cached;
    return cached;
  }

  try {
    const res = await fetch('https://ddragon.leagueoflegends.com/api/versions.json');
    const versions = await res.json();
    const latest = versions[0];
    db.setSetting('ddragon_version', latest);
    _cachedDDragonVersion = latest;
    return latest;
  } catch (err) {
    console.warn('[RiotAPI] getDDragonVersion fetch failed:', err?.message);
    return '15.21.1'; // safe fallback
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

module.exports = {
  getApiKey,
  saveApiKey,
  getSummonerByRiotId,
  getSummonerByPuuid,
  getRankedByPuuid,
  getTopMasteryChampions,
  fetchAndCacheMatchHistory,
  getMatchTimeline,
  getMatchDetailCached,
  backfillMatchData,
  validateApiKey,
  getDDragonVersion,
  queueLabel,
  DEFAULT_QUEUES,
};
