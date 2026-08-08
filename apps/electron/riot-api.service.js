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
 * Fetches new ranked solo matches for the account, inserts them into SQLite,
 * then returns all cached rows for the account sorted by timestamp DESC.
 */
async function fetchAndCacheMatchHistory(accountId, puuid, platform, count = 20) {
  try {
    const { lol } = createClients();
    const region = PLATFORM_TO_REGION[platform] || 'EUROPE';

    // Fetch match ID list
    const { response: matchIds } = await withRetry(() =>
      lol.MatchV5.list(puuid, region, { queue: 420, count })
    );

    if (!Array.isArray(matchIds) || matchIds.length === 0) {
      return db.getMatchCache(accountId, count);
    }

    // Filter to only uncached matches
    const newMatchIds = matchIds.filter((id) => !db.hasMatchInCache(id));

    // Process sequentially to respect rate limits
    for (const matchId of newMatchIds) {
      try {
        const { response: match } = await withRetry(() => lol.MatchV5.get(matchId, region));
        const participant = match.info.participants.find((p) => p.puuid === puuid);
        if (!participant) continue;

        const cs = (participant.totalMinionsKilled || 0) + (participant.neutralMinionsKilled || 0);
        const gameDurationMin = (match.info.gameDuration || 0) / 60;
        const csPerMin = gameDurationMin > 0 ? cs / gameDurationMin : 0;

        const myDamage =
          (participant.physicalDamageDealtToChampions || 0) +
          (participant.magicDamageDealtToChampions || 0) +
          (participant.trueDamageDealtToChampions || 0);
        const teamDamage = match.info.participants
          .filter((p) => p.teamId === participant.teamId)
          .reduce(
            (sum, p) =>
              sum +
              (p.physicalDamageDealtToChampions || 0) +
              (p.magicDamageDealtToChampions || 0) +
              (p.trueDamageDealtToChampions || 0),
            0
          );
        const damageShare = teamDamage > 0 ? myDamage / teamDamage : 0;

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
          _allParticipants: match.info.participants.map((p) => ({
            puuid: p.puuid,
            riotIdGameName: p.riotIdGameName || p.summonerName || '',
            championName: p.championName || '',
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
          })),
        };

        db.saveMatchCache(
          matchId,
          accountId,
          {
            puuid,
            champion: participant.championName || null,
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
            queueType: 'RANKED_SOLO_5x5',
            timestamp: match.info.gameStartTimestamp || Date.now(),
          },
          rawData
        );
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
  validateApiKey,
  getDDragonVersion,
};
