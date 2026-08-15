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
const ladder = require('./ladder');
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

/**
 * Server label as stored on an account → Riot platform slug.
 *
 * The renderer keeps its own copy in services/riot-api.service.ts because it
 * cannot import from the main process. Keep the two in step; anything reached
 * from main.js (the rank recorder, for one) needs this one.
 */
const SERVER_TO_PLATFORM = {
  EUW: 'euw1',
  EUNE: 'eun1',
  NA: 'na1',
  KR: 'kr',
  BR: 'br1',
  JP: 'jp1',
  LAN: 'la1',
  LAS: 'la2',
  OCE: 'oc1',
  TR: 'tr1',
  RU: 'ru',
  PH: 'ph2',
  SG: 'sg2',
  TW: 'tw2',
  VN: 'vn2',
};

function serverToPlatform(server) {
  if (!server) return 'euw1';
  const upper = String(server).toUpperCase();
  // Already a platform slug (someone else's profile carries one, never a label).
  if (PLATFORM_TO_REGION[String(server).toLowerCase()]) return String(server).toLowerCase();
  return SERVER_TO_PLATFORM[upper] || 'euw1';
}

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

// ── Short-lived response cache ────────────────────────────────────────────────

/**
 * Rank and mastery are re-read on every profile open, and neither moves between
 * two visits a minute apart. Uncached, they were two unconditional Riot requests
 * per page load — for a user who opens three profiles a day, more traffic than
 * their actual games cost.
 *
 * Deliberately in-memory rather than in SQLite: this exists to collapse repeat
 * loads inside one session, and a restart is exactly when a fresh read is
 * cheapest to justify.
 */
const RANK_TTL_MS = 10 * 60 * 1000;

/** Icon and level move far more slowly than LP, so they are held far longer. */
const SUMMONER_TTL_MS = 6 * 60 * 60 * 1000;

const volatileCache = new Map();

function cacheGet(key) {
  const hit = volatileCache.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expires) {
    volatileCache.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet(key, value, ttl = RANK_TTL_MS) {
  volatileCache.set(key, { value, expires: Date.now() + ttl });
  return value;
}

/** Drops cached rank/mastery for a puuid so a manual refresh really refreshes. */
function invalidatePlayerCache(puuid) {
  if (!puuid) return;
  for (const key of volatileCache.keys()) {
    if (key.endsWith(`:${puuid}`)) volatileCache.delete(key);
  }
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
  // Doubles as the icon-resolution path for co-players, so the same handful of
  // people you queue with are not looked up once per profile you visit.
  const key = `summoner:${platform}:${puuid}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  try {
    const { lol } = createClients();
    const { response } = await withRetry(() => lol.Summoner.getByPUUID(puuid, platform));
    return cacheSet(key, response, SUMMONER_TTL_MS);
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
  const key = `ranked:${platform}:${puuid}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  try {
    const url = `https://${platform}.api.riotgames.com/lol/league/v4/entries/by-puuid/${encodeURIComponent(puuid)}`;
    return cacheSet(key, await riotFetch(url));
  } catch (err) {
    if (err?.code === 'NO_KEY') return { error: 'no_key' };
    const status = err?.status || Number(err?.message);
    if (status === 403 || status === 401) return { error: 'invalid_key' };
    if (status === 404) return cacheSet(key, []);
    console.error('[RiotAPI] getRankedByPuuid error:', err?.message);
    return { error: err?.message || 'unknown' };
  }
}

// ── Champion mastery ──────────────────────────────────────────────────────────

/** Returns top mastery champion array or [] on error. */
async function getTopMasteryChampions(puuid, platform) {
  const key = `mastery:${platform}:${puuid}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  try {
    const url = `https://${platform}.api.riotgames.com/lol/champion-mastery/v4/champion-masteries/by-puuid/${encodeURIComponent(puuid)}/top`;
    return cacheSet(key, await riotFetch(url));
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

/**
 * Ceiling on one year's sweep. Well above what any human plays in a year, and
 * a hard stop on paging if Riot ever returns something unexpected.
 */
const MAX_YEAR_MATCHES = 2000;

/**
 * Ceiling on how many pre-detail-table rows one routine refresh will upgrade.
 * The work is worth doing but it is not why the user opened the page, so it is
 * spread across visits instead of turning a page open into a bulk fetch.
 */
const DETAIL_UPGRADES_PER_REFRESH = 5;

/** Ranked Solo/Duo. The queue the activity heatmap reports on. */
const RANKED_SOLO_QUEUE = 420;

function queueLabel(queueId) {
  return QUEUE_LABELS[queueId] || (queueId != null ? `QUEUE_${queueId}` : null);
}

/** Trimmed per-participant summary kept inline on match_cache.raw_json. */
function summariseParticipant(p) {
  return {
    puuid: p.puuid,
    riotIdGameName: p.riotIdGameName || p.summonerName || '',
    riotIdTagline: p.riotIdTagline || '',
    // Their summoner icon at the time of the game — lets "recently played"
    // show people by their account picture without a per-player API call.
    profileIcon: p.profileIcon ?? 0,
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

/** Keys `summariseParticipant` produces, for projecting a stored detail row. */
const SUMMARY_KEYS = Object.keys(summariseParticipant({ items: [] }));

/**
 * Narrows an already-stored `match_detail` participant back to the summary
 * shape.
 *
 * Not `summariseParticipant` — that reads Riot's wire format (`item0`…`item6`,
 * `totalMinionsKilled`), which the stored record has already folded into
 * `items` and `cs`. Re-running it on a stored row would quietly produce an
 * array of seven undefined items.
 */
function toSummary(participant) {
  const out = {};
  for (const key of SUMMARY_KEYS) out[key] = participant[key];
  return out;
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
 * Pages Riot's match-id endpoint.
 *
 * `count` caps at 100 per request, so anything larger is paged. `startTime` and
 * `endTime` are epoch *seconds* and optional; Riot's matchlist only carries
 * timestamps from 16 June 2021, so windows earlier than that return nothing.
 *
 * `queue` narrows the listing to a single queue id server-side. This is the
 * cheapest filter available anywhere in the pipeline: an id excluded here is an
 * id we never spend a request fetching. Omit it to get every mode.
 */
async function listMatchIds(
  lol,
  puuid,
  region,
  { count = 20, startTime, endTime, queue, maxPages = 20 } = {}
) {
  const PAGE = 100;
  const ids = [];
  const wanted = Math.max(1, count);

  for (let page = 0; page < maxPages && ids.length < wanted; page++) {
    const query = { start: page * PAGE, count: Math.min(PAGE, wanted - ids.length) };
    if (startTime !== undefined) query.startTime = startTime;
    if (endTime !== undefined) query.endTime = endTime;
    if (queue !== undefined && queue !== null) query.queue = queue;

    let batch = [];
    try {
      const { response } = await withRetry(() => lol.MatchV5.list(puuid, region, query), {
        interactive: false,
      });
      batch = Array.isArray(response) ? response : [];
    } catch (err) {
      console.warn('[RiotAPI] Match list page failed:', err?.message);
      break;
    }

    ids.push(...batch);
    if (batch.length < query.count) break;
  }

  return [...new Set(ids)];
}

/**
 * Fetches the newest matches, inserts them into SQLite, then returns cached
 * rows for the account sorted by timestamp DESC.
 *
 * The listing is deliberately *not* filtered by queue. It used to fan out over
 * a hardcoded list of five, which cost five requests instead of one and — far
 * worse — silently dropped every game played in any other mode: Arena, Clash,
 * Swiftplay, URF, rotating modes, bot games. Those missing games are exactly
 * the holes that showed up as empty weeks on the activity heatmap for someone
 * who plays every day. Omitting `queue` returns all of them, newest first.
 */
async function fetchAndCacheMatchHistory(accountId, puuid, platform, count = 20) {
  try {
    const { lol } = createClients();
    const region = PLATFORM_TO_REGION[platform] || 'EUROPE';

    const matchIds = await listMatchIds(lol, puuid, region, { count });
    if (matchIds.length === 0) return db.getMatchCache(accountId, count);

    const outstanding = [];
    // Rows that exist but predate the detail table are worth upgrading, so they
    // gain bans/objectives/damage breakdown rather than staying partial. Capped,
    // though: on a cache written before that table existed the unbounded version
    // silently re-fetched swathes of history on an ordinary page open.
    let upgrades = 0;

    for (const id of matchIds) {
      const mine = db.hasMatchForAccount(id, accountId);

      if (!mine) {
        // Already held under another account — rebuild ours from disk, free.
        if (hydrateFromLocal(id, accountId, puuid)) continue;
        outstanding.push(id);
        continue;
      }

      if (!db.hasMatchDetail(id) && upgrades < DETAIL_UPGRADES_PER_REFRESH) {
        upgrades++;
        outstanding.push(id);
      }
    }

    for (const matchId of outstanding) {
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

/**
 * Writes this account's `match_cache` row for a game we already hold in full,
 * without going to Riot.
 *
 * A match reaches the database once per *account* but its detail row is shared.
 * So when two tracked accounts played the same game — or when you open the
 * profile of someone you queued with — every stat the row needs is already on
 * disk. `match_detail.participants` carries the per-player numbers and a
 * sibling `match_cache` row carries the kickoff timestamp, which detail does
 * not store.
 *
 * Returns true when the row was written. This is the only free path in the
 * whole pipeline: it turns a Riot request into a local read.
 */
function hydrateFromLocal(matchId, accountId, puuid) {
  try {
    return writeRowFromLocal(matchId, accountId, puuid);
  } catch (err) {
    // A row we could not rebuild locally is not a failure — it just falls
    // through to being fetched like any other. Never abort the sweep for it.
    console.warn('[RiotAPI] Local hydrate failed for', matchId, err?.message);
    return false;
  }
}

function writeRowFromLocal(matchId, accountId, puuid) {
  const detail = db.getMatchDetail(matchId);
  if (!detail?.participants?.length) return false;

  const mine = detail.participants.find((p) => p.puuid === puuid);
  if (!mine) return false;

  // Detail has no game start time; any sibling row for the same match does.
  const sibling = db.getMatchCacheRows(matchId).find((r) => r.timestamp > 0);
  if (!sibling) return false;

  const duration = detail.gameDuration ?? sibling.duration_seconds ?? 0;
  const minutes = duration / 60;
  const cs = mine.cs ?? 0;

  const damageOf = (p) => p.totalDamageDealtToChampions ?? 0;
  const teamDamage = detail.participants
    .filter((p) => p.teamId === mine.teamId)
    .reduce((sum, p) => sum + damageOf(p), 0);

  db.saveMatchCache(
    matchId,
    accountId,
    {
      puuid,
      champion: mine.championName || null,
      championId: mine.championId ?? null,
      participantId: mine.participantId ?? null,
      teamId: mine.teamId ?? null,
      position: mine.teamPosition || null,
      win: mine.win,
      kills: mine.kills ?? null,
      deaths: mine.deaths ?? null,
      assists: mine.assists ?? null,
      cs,
      csPerMin: minutes > 0 ? Math.round((cs / minutes) * 10) / 10 : 0,
      damageDealt: damageOf(mine),
      damageShare: teamDamage > 0 ? Math.round((damageOf(mine) / teamDamage) * 1000) / 1000 : 0,
      gold: mine.goldEarned ?? null,
      visionScore: mine.visionScore ?? null,
      durationSeconds: duration || null,
      items: mine.items ?? null,
      lpBefore: null,
      lpAfter: null,
      lpDelta: null,
      queueId: detail.queueId ?? sibling.queue_id ?? null,
      queueType: queueLabel(detail.queueId ?? sibling.queue_id),
      gameVersion: detail.gameVersion ?? sibling.game_version ?? null,
      timestamp: sibling.timestamp,
    },
    { ...mine, _allParticipants: detail.participants.map(toSummary) }
  );

  return true;
}

/**
 * Batches freshly-cached rows towards the renderer.
 *
 * The screen used to stand still for the whole sweep and then replace every row
 * at once, which read as the page rebuilding itself. Emitting as we go lets the
 * heatmap fill in live — but one IPC message per match would be ~11 KB of
 * `raw_json` a thousand times over, so writes are grouped by count or by time,
 * whichever comes first.
 */
function createRowStream(accountId, emit) {
  const FLUSH_ROWS = 20;
  const FLUSH_MS = 900;

  let batch = [];
  let lastFlush = Date.now();

  const flush = () => {
    if (!batch.length) return;
    const ids = batch;
    batch = [];
    lastFlush = Date.now();
    emit(db.getMatchCacheByIds(accountId, ids));
  };

  return {
    add(matchId) {
      batch.push(matchId);
      if (batch.length >= FLUSH_ROWS || Date.now() - lastFlush >= FLUSH_MS) flush();
    },
    flush,
  };
}

/**
 * Pulls one calendar year of match history and caches anything not already held.
 *
 * The routine history fetch asks for the newest handful of games, which leaves
 * the activity heatmap with a few recent weeks and eleven empty months. This
 * walks the year properly: page the id endpoint between the year's bounds, then
 * fetch the detail for whatever is missing.
 *
 * Three things keep the cost down, in descending order of value:
 *
 * 1. `queue` narrows the *listing* server-side. The heatmap reads ranked
 *    solo/duo, so a player who also plays ARAM and normals never spends a
 *    request on games the grid would not count. On a mixed account this is
 *    routinely a 3–5× cut, and it costs nothing to apply.
 * 2. Anything already held for another account is rebuilt from disk for free —
 *    see `hydrateFromLocal`.
 * 3. Only what survives both is fetched, at one request per game against a
 *    ~0.83 req/s budget. Hence the ETA, the cancel check, and the row stream
 *    that lets the page fill in while it runs.
 */
async function fetchYearHistory(
  accountId,
  puuid,
  platform,
  { year, queue, onProgress = () => {}, onRows = () => {}, shouldCancel = () => false } = {}
) {
  const { lol } = createClients();
  const region = PLATFORM_TO_REGION[platform] || 'EUROPE';

  // Riot's filters are epoch *seconds*, and its matchlist only stores
  // timestamps from 16 June 2021 — earlier years cannot be windowed at all.
  const startTime = Math.floor(new Date(year, 0, 1).getTime() / 1000);
  const endTime = Math.floor(new Date(year + 1, 0, 1).getTime() / 1000);

  const report = (extra) =>
    onProgress({
      phase: 'fetching',
      processed: 0,
      total: 0,
      failed: 0,
      reused: 0,
      scanned: 0,
      etaSeconds: 0,
      done: false,
      ...extra,
    });

  report({ phase: 'scanning' });

  const ids = await listMatchIds(lol, puuid, region, {
    count: MAX_YEAR_MATCHES,
    startTime,
    endTime,
    queue,
    maxPages: MAX_YEAR_MATCHES / 100,
  });

  if (shouldCancel()) {
    return { scanned: ids.length, added: 0, reused: 0, failed: 0, cancelled: true };
  }

  const stream = createRowStream(accountId, onRows);

  // Free pass: anything already on disk under another account becomes this
  // account's row without a request. Done before the ETA is quoted so the
  // number the user sees is what they will actually wait for.
  let reused = 0;
  const outstanding = [];
  for (const id of ids) {
    if (db.hasMatchForAccount(id, accountId)) continue;
    if (hydrateFromLocal(id, accountId, puuid)) {
      reused++;
      stream.add(id);
      continue;
    }
    outstanding.push(id);
  }
  stream.flush();

  const total = outstanding.length;
  report({ processed: 0, total, reused, scanned: ids.length, etaSeconds: limiter.estimateSeconds(total), done: total === 0 });
  if (total === 0) {
    return { scanned: ids.length, added: 0, reused, failed: 0, cancelled: false };
  }

  let added = 0;
  let failed = 0;

  for (const matchId of outstanding) {
    if (shouldCancel()) {
      stream.flush();
      return { scanned: ids.length, added, reused, failed, cancelled: true };
    }

    try {
      const { response: match } = await withRetry(() => lol.MatchV5.get(matchId, region), {
        interactive: false,
      });
      persistMatch(matchId, accountId, puuid, match);
      added++;
      stream.add(matchId);
    } catch (err) {
      failed++;
      console.warn('[RiotAPI] Year fetch failed for', matchId, err?.message);
    }

    const processed = added + failed;
    report({
      processed,
      total,
      failed,
      reused,
      scanned: ids.length,
      etaSeconds: limiter.estimateSeconds(total - processed),
      done: processed >= total,
    });
  }

  stream.flush();
  return { scanned: ids.length, added, reused, failed, cancelled: false };
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
    // Once per cached perspective: two people who played this game see opposite
    // sides of the same lane differential.
    const detail = db.getMatchDetail(matchId);
    if (detail?.participants?.length) {
      for (const row of db.getMatchCacheRows(matchId)) {
        if (!row.participant_id) continue;
        const opponent = findLaneOpponent(detail.participants, row.puuid);
        if (!opponent?.participantId) continue;

        const diffs = computeDiffsAtMinute(compact, row.participant_id, opponent.participantId, 15);
        if (diffs) {
          db.updateMatchDiffs(matchId, row.account_id, {
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

// ── Ladder position ───────────────────────────────────────────────────────────

/**
 * Measures where an account sits on its region's ranked ladder and records it.
 *
 * The counting lives in `ladder.js`; this is the part that needs Riot — it
 * resolves the account's current rank, hands the sweep a paced request function,
 * and persists both results it produces.
 *
 * Two rows come out of one sweep, which is the reason it is worth the requests:
 * the ladder position itself, and a `rank_snapshots` row built from the
 * account's own ladder entry. That entry carries `wins`, `losses` and
 * `inactive` — the same fields the rank recorder reads — so the daily series
 * gets a reading out of a sweep that was already paid for.
 */
async function sweepLadderPosition(
  accountId,
  puuid,
  platform,
  { queue = 'RANKED_SOLO_5x5', onProgress = () => {}, shouldCancel = () => false, freshCensus = false } = {}
) {
  const entries = await getRankedByPuuid(puuid, platform);
  if (!Array.isArray(entries)) {
    return { error: entries?.error || 'Could not read rank from Riot' };
  }

  const current = entries.find((e) => e.queueType === queue);
  if (!current || !current.tier) {
    return { error: 'unranked', queue };
  }

  // 404s are expected while paging: they mean "no such page", not a failure.
  const request = async (url) => {
    try {
      return await riotFetch(url, undefined, { interactive: false });
    } catch (err) {
      const status = err?.status || Number(err?.message);
      if (status === 404) return [];
      throw err;
    }
  };

  const result = await ladder.sweepLadderPosition(
    {
      puuid,
      tier: current.tier,
      division: current.rank,
      leaguePoints: current.leaguePoints,
    },
    { platform, queue, request, onProgress, shouldCancel, freshCensus }
  );

  if (result.cancelled) return { cancelled: true, requests: result.requests };

  db.recordLadderPosition(accountId, queue, result);

  // The sweep saw the account's own ladder entry, which carries win/loss counts
  // the by-puuid response also has — but written here it lands on the same day
  // key, so the daily series gains a reading for free.
  db.recordRankSnapshot(accountId, queue, result.entry ?? current);

  return result;
}

/** Pre-flight cost of a sweep, so the UI can quote a wait before starting one. */
function estimateLadderSweep(platform, queue, tier, division) {
  return ladder.estimateSweep(platform, queue, tier, division);
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
  serverToPlatform,
  getSummonerByRiotId,
  getSummonerByPuuid,
  getRankedByPuuid,
  getTopMasteryChampions,
  fetchYearHistory,
  fetchAndCacheMatchHistory,
  getMatchTimeline,
  getMatchDetailCached,
  backfillMatchData,
  sweepLadderPosition,
  estimateLadderSweep,
  validateApiKey,
  getDDragonVersion,
  invalidatePlayerCache,
  hydrateFromLocal,
  queueLabel,
  MAX_YEAR_MATCHES,
  RANKED_SOLO_QUEUE,
};
