'use strict';

/**
 * Match timeline compaction — Electron main-process only.
 *
 * Raw MatchV5 timelines are 1-2 MB per game. The bulk of that is data no
 * feature in the app consumes:
 *   - `participantFrames[].championStats` — ~25 keys (armor, attackDamage,
 *     movementSpeed…) x 10 participants x ~30 frames.
 *   - `CHAMPION_KILL.victimDamageDealt` / `victimDamageReceived` — an object
 *     per spell instance, which for a teamfight kill can be dozens of entries.
 *
 * Dropping those and storing positional arrays instead of keyed objects gets a
 * typical game to ~40-55 KB (a 20-40x reduction), which keeps a 500-match cache
 * around 25 MB rather than 0.5-1 GB.
 *
 * `SCHEMA_VERSION` is stored per row so that if a future feature needs a field
 * dropped here, we can re-fetch only stale rows instead of guessing.
 */

const SCHEMA_VERSION = 1;

/** Summoner's Rift spans 0..14870 on both axes (Riot's origin is bottom-left). */
const MAP_MIN = 0;
const MAP_MAX = 14870;

/**
 * Per-participant frame layout. Stored as a positional array — key names would
 * otherwise dominate the payload. Index constants are exported so the renderer
 * decodes by name rather than magic numbers.
 */
const F = {
  X: 0,
  Y: 1,
  TOTAL_GOLD: 2,
  XP: 3,
  LEVEL: 4,
  MINIONS: 5,
  JUNGLE_MINIONS: 6,
  CURRENT_GOLD: 7,
  DMG_DONE_TOTAL: 8,
  DMG_DONE_MAGIC: 9,
  DMG_DONE_PHYSICAL: 10,
  DMG_DONE_TRUE: 11,
  DMG_TAKEN_TOTAL: 12,
  TIME_CC: 13,
};
const FRAME_FIELD_COUNT = 14;

/** Event types the UI actually consumes. Everything else is discarded. */
const KEPT_EVENT_TYPES = new Set([
  'CHAMPION_KILL',
  'BUILDING_KILL',
  'ELITE_MONSTER_KILL',
  'TURRET_PLATE_DESTROYED',
  'ITEM_PURCHASED',
  'ITEM_SOLD',
  'ITEM_UNDO',
  'ITEM_DESTROYED',
  'SKILL_LEVEL_UP',
  'LEVEL_UP',
  'WARD_PLACED',
  'WARD_KILL',
]);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** True when a position looks like a real in-bounds map coordinate. */
function isValidPosition(pos) {
  return (
    pos &&
    typeof pos.x === 'number' &&
    typeof pos.y === 'number' &&
    pos.x >= MAP_MIN &&
    pos.x <= MAP_MAX &&
    pos.y >= MAP_MIN &&
    pos.y <= MAP_MAX
  );
}

/**
 * Reduces one participant frame to a flat numeric array.
 * `damageStats` is an open map in the DTO; the live payload carries the
 * champion-damage keys below, which back the Damage tab's dealt/taken and
 * physical/magic/true toggles.
 */
function compactParticipantFrame(pf) {
  const pos = pf?.position || {};
  const ds = pf?.damageStats || {};
  const out = new Array(FRAME_FIELD_COUNT);

  out[F.X] = num(pos.x);
  out[F.Y] = num(pos.y);
  out[F.TOTAL_GOLD] = num(pf?.totalGold);
  out[F.XP] = num(pf?.xp);
  out[F.LEVEL] = num(pf?.level);
  out[F.MINIONS] = num(pf?.minionsKilled);
  out[F.JUNGLE_MINIONS] = num(pf?.jungleMinionsKilled);
  out[F.CURRENT_GOLD] = num(pf?.currentGold);
  out[F.DMG_DONE_TOTAL] = num(ds.totalDamageDoneToChampions);
  out[F.DMG_DONE_MAGIC] = num(ds.magicDamageDoneToChampions);
  out[F.DMG_DONE_PHYSICAL] = num(ds.physicalDamageDoneToChampions);
  out[F.DMG_DONE_TRUE] = num(ds.trueDamageDoneToChampions);
  out[F.DMG_TAKEN_TOTAL] = num(ds.totalDamageTaken);
  out[F.TIME_CC] = num(pf?.timeEnemySpentControlled);

  return out;
}

/** Reduces one event, keeping only fields the UI renders. */
function compactEvent(ev) {
  const out = { t: num(ev.timestamp), type: ev.type };

  if (isValidPosition(ev.position)) {
    out.x = ev.position.x;
    out.y = ev.position.y;
  }

  switch (ev.type) {
    case 'CHAMPION_KILL':
      out.killerId = ev.killerId ?? 0;
      out.victimId = ev.victimId ?? 0;
      if (ev.assistingParticipantIds?.length) out.assists = ev.assistingParticipantIds;
      if (ev.killType) out.killType = ev.killType;
      if (ev.multiKillLength) out.multiKill = ev.multiKillLength;
      if (ev.bounty) out.bounty = ev.bounty;
      break;

    case 'BUILDING_KILL':
      out.teamId = ev.teamId ?? 0; // team that OWNED the destroyed building
      if (ev.killerId) out.killerId = ev.killerId;
      if (ev.buildingType) out.buildingType = ev.buildingType;
      if (ev.towerType) out.towerType = ev.towerType;
      if (ev.laneType) out.laneType = ev.laneType;
      break;

    case 'ELITE_MONSTER_KILL':
      if (ev.killerId) out.killerId = ev.killerId;
      if (ev.killerTeamId) out.killerTeamId = ev.killerTeamId;
      if (ev.monsterType) out.monsterType = ev.monsterType;
      if (ev.monsterSubType) out.monsterSubType = ev.monsterSubType;
      break;

    case 'TURRET_PLATE_DESTROYED':
      if (ev.teamId) out.teamId = ev.teamId;
      if (ev.laneType) out.laneType = ev.laneType;
      break;

    case 'ITEM_PURCHASED':
    case 'ITEM_SOLD':
    case 'ITEM_DESTROYED':
      out.participantId = ev.participantId ?? 0;
      out.itemId = ev.itemId ?? 0;
      break;

    case 'ITEM_UNDO':
      out.participantId = ev.participantId ?? 0;
      if (ev.beforeId) out.beforeId = ev.beforeId;
      if (ev.afterId) out.afterId = ev.afterId;
      break;

    case 'SKILL_LEVEL_UP':
      out.participantId = ev.participantId ?? 0;
      out.skillSlot = ev.skillSlot ?? 0;
      if (ev.levelUpType) out.levelUpType = ev.levelUpType;
      break;

    case 'LEVEL_UP':
      out.participantId = ev.participantId ?? 0;
      out.level = ev.level ?? 0;
      break;

    case 'WARD_PLACED':
      out.creatorId = ev.creatorId ?? 0;
      if (ev.wardType) out.wardType = ev.wardType;
      break;

    case 'WARD_KILL':
      out.killerId = ev.killerId ?? 0;
      if (ev.wardType) out.wardType = ev.wardType;
      break;

    default:
      break;
  }

  return out;
}

/**
 * Compacts a raw MatchV5 timeline DTO into the form persisted in SQLite.
 *
 * @param {object} dto  `response` from `lol.MatchV5.timeline()`.
 * @returns {{frameInterval:number, frameCount:number, participants:Array,
 *            frames:Array, events:Array, schemaVersion:number}}
 */
function compactTimeline(dto) {
  const info = dto?.info ?? dto ?? {};
  const rawFrames = Array.isArray(info.frames) ? info.frames : [];

  // participantId (1..10) → puuid. This is the join key between the timeline
  // and match_cache rows; participantFrames is keyed by the same integers.
  const participants = (info.participants || []).map((p) => ({
    participantId: p.participantId,
    puuid: p.puuid,
  }));

  const frames = [];
  const events = [];

  for (const frame of rawFrames) {
    const pf = frame?.participantFrames || {};
    // Always emit 10 slots in participantId order so the renderer can index
    // directly by (participantId - 1) without a lookup.
    const frameRow = [];
    for (let pid = 1; pid <= 10; pid++) {
      const entry = pf[String(pid)];
      frameRow.push(entry ? compactParticipantFrame(entry) : new Array(FRAME_FIELD_COUNT).fill(0));
    }
    frames.push(frameRow);

    for (const ev of frame?.events || []) {
      if (KEPT_EVENT_TYPES.has(ev?.type)) events.push(compactEvent(ev));
    }
  }

  return {
    frameInterval: num(info.frameInterval) || 60000,
    frameCount: frames.length,
    participants,
    frames,
    events,
    schemaVersion: SCHEMA_VERSION,
  };
}

/**
 * Computes gold/CS/XP differentials at a given minute between two participants.
 * Returns null when the game ended before that minute — callers must render an
 * empty state rather than a misleading zero (remakes, early surrenders).
 *
 * @param {object} compact   Result of `compactTimeline`.
 * @param {number} pid       Participant id (1..10) to measure.
 * @param {number} opponentPid Opposing participant id (1..10).
 * @param {number} minute    Minute mark, default 15 (community standard).
 */
function computeDiffsAtMinute(compact, pid, opponentPid, minute = 15) {
  if (!compact?.frames || !pid || !opponentPid) return null;
  const frame = compact.frames[minute];
  if (!frame) return null;

  const me = frame[pid - 1];
  const them = frame[opponentPid - 1];
  if (!me || !them) return null;

  const cs = (r) => r[F.MINIONS] + r[F.JUNGLE_MINIONS];

  return {
    goldDiff: me[F.TOTAL_GOLD] - them[F.TOTAL_GOLD],
    csDiff: cs(me) - cs(them),
    xpDiff: me[F.XP] - them[F.XP],
  };
}

/** Finds the opposing laner (same teamPosition, other team) from match participants. */
function findLaneOpponent(participants, puuid) {
  const me = participants.find((p) => p.puuid === puuid);
  if (!me || !me.teamPosition) return null;
  return (
    participants.find(
      (p) => p.teamId !== me.teamId && p.teamPosition === me.teamPosition
    ) || null
  );
}

module.exports = {
  compactTimeline,
  computeDiffsAtMinute,
  findLaneOpponent,
  SCHEMA_VERSION,
  FRAME_FIELDS: F,
  FRAME_FIELD_COUNT,
  MAP_MAX,
};
