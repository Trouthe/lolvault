'use strict';

const Database = require('better-sqlite3');
const path = require('path');

let db = null;

// Tier base LP values (Iron IV = 0, each tier = 400 LP)
const TIER_LP = {
  IRON: 0,
  BRONZE: 400,
  SILVER: 800,
  GOLD: 1200,
  PLATINUM: 1600,
  EMERALD: 2000,
  DIAMOND: 2400,
  MASTER: 2800,
  GRANDMASTER: 2800,
  CHALLENGER: 2800,
};

// Division offsets within a tier (IV=0, III=100, II=200, I=300)
const DIVISION_LP = { IV: 0, III: 100, II: 200, I: 300 };

function computeAbsoluteLp(tier, division, lp) {
  const tierBase = TIER_LP[(tier || '').toUpperCase()] ?? 0;
  const divBase = DIVISION_LP[(division || '').toUpperCase()] ?? 0;
  return tierBase + divBase + (lp || 0);
}

function initDatabase(dataPath) {
  const dbPath = path.join(dataPath, 'lolvault.db');
  db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS lp_snapshots (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id  TEXT    NOT NULL,
      timestamp   INTEGER NOT NULL,
      tier        TEXT    NOT NULL,
      division    TEXT    NOT NULL,
      lp          INTEGER NOT NULL,
      absolute_lp INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_lp_snapshots_account
      ON lp_snapshots (account_id, timestamp);

    CREATE TABLE IF NOT EXISTS match_cache (
      match_id      TEXT    NOT NULL,
      account_id    TEXT    NOT NULL,
      timestamp     INTEGER NOT NULL,
      cs_per_min    REAL,
      damage_share  REAL,
      lp_delta      REAL,
      raw_json      TEXT    NOT NULL,
      -- One row per player per game: see the v3 → v4 migration.
      PRIMARY KEY (match_id, account_id)
    );

    CREATE INDEX IF NOT EXISTS idx_match_cache_account
      ON match_cache (account_id, timestamp);

    CREATE TABLE IF NOT EXISTS app_settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  runMigrations();

  return db;
}

/**
 * Adds any columns that were introduced after the initial schema.
 * SQLite only supports ADD COLUMN, so each migration is idempotent.
 *
 * This runs before the versioned ladder below and covers databases created
 * before `user_version` tracking existed.
 */
function addMissingMatchCacheColumns() {
  const existingCols = db.pragma('table_info(match_cache)').map((r) => r.name);
  const columnsToAdd = [
    ['puuid', 'TEXT'],
    ['champion', 'TEXT'],
    ['position', 'TEXT'],
    ['win', 'INTEGER'],
    ['kills', 'INTEGER'],
    ['deaths', 'INTEGER'],
    ['assists', 'INTEGER'],
    ['cs', 'INTEGER'],
    ['damage_dealt', 'INTEGER'],
    ['gold', 'INTEGER'],
    ['vision_score', 'INTEGER'],
    ['duration_seconds', 'INTEGER'],
    ['items', 'TEXT'],
    ['lp_before', 'REAL'],
    ['lp_after', 'REAL'],
    ['queue_type', 'TEXT'],
    // Analytics rebuild — richer match metadata
    ['queue_id', 'INTEGER'],
    ['participant_id', 'INTEGER'],
    ['team_id', 'INTEGER'],
    ['champion_id', 'INTEGER'],
    ['game_version', 'TEXT'],
    ['has_detail', 'INTEGER DEFAULT 0'],
    ['has_timeline', 'INTEGER DEFAULT 0'],
    ['gold_diff_15', 'INTEGER'],
    ['cs_diff_15', 'INTEGER'],
    ['xp_diff_15', 'INTEGER'],
  ];
  for (const [col, type] of columnsToAdd) {
    if (!existingCols.includes(col)) {
      db.exec(`ALTER TABLE match_cache ADD COLUMN ${col} ${type}`);
    }
  }
}

/**
 * Versioned schema migrations.
 *
 * Each entry migrates from version `index` to `index + 1` and runs exactly once,
 * tracked via SQLite's built-in `PRAGMA user_version` (a free integer in the DB
 * header — no bookkeeping table required). Append new steps to the end; never
 * reorder or edit an existing one, since it may already have been applied.
 */
const MIGRATIONS = [
  // v0 → v1: full match detail (bans, objectives, untrimmed participants).
  // Kept out of match_cache because getMatchCache() SELECT *'s and JSON.parses
  // every row — inlining blobs would parse megabytes on each list render.
  (d) => {
    d.exec(`
      CREATE TABLE IF NOT EXISTS match_detail (
        match_id          TEXT PRIMARY KEY,
        queue_id          INTEGER,
        game_version      TEXT,
        game_mode         TEXT,
        game_duration     INTEGER,
        teams_json        TEXT NOT NULL,
        participants_json TEXT NOT NULL,
        schema_version    INTEGER NOT NULL DEFAULT 1,
        fetched_at        INTEGER NOT NULL
      );
    `);
  },

  // v1 → v2: compacted match timelines (positions, gold/xp curves, events).
  (d) => {
    d.exec(`
      CREATE TABLE IF NOT EXISTS match_timeline (
        match_id       TEXT PRIMARY KEY,
        frame_interval INTEGER NOT NULL,
        frame_count    INTEGER NOT NULL,
        participants   TEXT NOT NULL,
        frames_json    TEXT NOT NULL,
        events_json    TEXT NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 1,
        fetched_at     INTEGER NOT NULL
      );
    `);
  },

  // v2 → v3: index supporting the Champions screen champion/matchup pools.
  (d) => {
    d.exec(`
      CREATE INDEX IF NOT EXISTS idx_match_cache_champ
        ON match_cache (account_id, champion, timestamp);
    `);
  },

  // v3 → v4: key match_cache by (match_id, account_id) instead of match_id.
  //
  // A row holds one player's view of a game — their champion, their KDA,
  // whether they won. With match_id alone as the key, caching a game a second
  // time for a different player REPLACEd the first player's row, silently
  // rewriting their history to somebody else's. Harmless while only vault
  // accounts were ever cached (two tracked accounts in one game is rare);
  // guaranteed the moment you can open an opponent's profile from a match you
  // played. SQLite cannot alter a primary key, so the table is rebuilt.
  (d) => {
    d.exec(`
      CREATE TABLE match_cache_v4 (
        match_id         TEXT    NOT NULL,
        account_id       TEXT    NOT NULL,
        timestamp        INTEGER NOT NULL,
        cs_per_min       REAL,
        damage_share     REAL,
        lp_delta         REAL,
        raw_json         TEXT    NOT NULL,
        puuid            TEXT,
        champion         TEXT,
        position         TEXT,
        win              INTEGER,
        kills            INTEGER,
        deaths           INTEGER,
        assists          INTEGER,
        cs               INTEGER,
        damage_dealt     INTEGER,
        gold             INTEGER,
        vision_score     INTEGER,
        duration_seconds INTEGER,
        items            TEXT,
        lp_before        REAL,
        lp_after         REAL,
        queue_type       TEXT,
        queue_id         INTEGER,
        participant_id   INTEGER,
        team_id          INTEGER,
        champion_id      INTEGER,
        game_version     TEXT,
        has_detail       INTEGER DEFAULT 0,
        has_timeline     INTEGER DEFAULT 0,
        gold_diff_15     INTEGER,
        cs_diff_15       INTEGER,
        xp_diff_15       INTEGER,
        PRIMARY KEY (match_id, account_id)
      );

      INSERT INTO match_cache_v4 (
        match_id, account_id, timestamp, cs_per_min, damage_share, lp_delta, raw_json,
        puuid, champion, position, win, kills, deaths, assists, cs, damage_dealt,
        gold, vision_score, duration_seconds, items, lp_before, lp_after, queue_type,
        queue_id, participant_id, team_id, champion_id, game_version,
        has_detail, has_timeline, gold_diff_15, cs_diff_15, xp_diff_15
      )
      SELECT
        match_id, account_id, timestamp, cs_per_min, damage_share, lp_delta, raw_json,
        puuid, champion, position, win, kills, deaths, assists, cs, damage_dealt,
        gold, vision_score, duration_seconds, items, lp_before, lp_after, queue_type,
        queue_id, participant_id, team_id, champion_id, game_version,
        has_detail, has_timeline, gold_diff_15, cs_diff_15, xp_diff_15
      FROM match_cache;

      DROP TABLE match_cache;
      ALTER TABLE match_cache_v4 RENAME TO match_cache;

      CREATE INDEX IF NOT EXISTS idx_match_cache_account
        ON match_cache (account_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_match_cache_champ
        ON match_cache (account_id, champion, timestamp);
    `);
  },

  // v4 → v5: drop the non-vault profile caches.
  //
  // These were written while match_cache was still keyed by match_id alone, so
  // every game they shared with a tracked account overwrote that account's own
  // row — the vault account lost the game and the row was re-filed under the
  // other player. Deleting them removes the misfiled copies; the affected
  // accounts then re-fetch their own rows on the next refresh, now that a
  // shared game can be held by both. Nothing is lost that Riot cannot re-serve.
  (d) => {
    d.exec(`DELETE FROM match_cache WHERE account_id LIKE 'player:%';`);
  },
];

function runMigrations() {
  addMissingMatchCacheColumns();

  const current = db.pragma('user_version', { simple: true }) ?? 0;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => MIGRATIONS[v](db))();
    // user_version can't be parameterised — v is a loop integer, never user input.
    db.pragma(`user_version = ${v + 1}`);
    console.log(`[DB] Applied migration ${v} → ${v + 1}`);
  }
}

function getDb() {
  if (!db) throw new Error('Database not initialised — call initDatabase() first');
  return db;
}

// ── LP Snapshots ──────────────────────────────────────────────────────────────

function saveLpSnapshot(accountId, tier, division, lp) {
  const absoluteLp = computeAbsoluteLp(tier, division, lp);
  return getDb()
    .prepare(
      `INSERT INTO lp_snapshots (account_id, timestamp, tier, division, lp, absolute_lp)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(accountId, Date.now(), tier, division, lp, absoluteLp);
}

function getLpSnapshots(accountId) {
  return getDb()
    .prepare('SELECT * FROM lp_snapshots WHERE account_id = ? ORDER BY timestamp ASC')
    .all(accountId);
}

function getLatestLpSnapshot(accountId) {
  return getDb()
    .prepare('SELECT * FROM lp_snapshots WHERE account_id = ? ORDER BY timestamp DESC LIMIT 1')
    .get(accountId);
}

// ── Match Cache ───────────────────────────────────────────────────────────────

function saveMatchCache(matchId, accountId, computed = {}, rawJson) {
  const {
    puuid = null,
    champion = null,
    position = null,
    win = null,
    kills = null,
    deaths = null,
    assists = null,
    cs = null,
    csPerMin = null,
    damageDealt = null,
    damageShare = null,
    gold = null,
    visionScore = null,
    durationSeconds = null,
    items = null,
    lpBefore = null,
    lpAfter = null,
    lpDelta = null,
    queueType = null,
    queueId = null,
    championId = null,
    participantId = null,
    teamId = null,
    gameVersion = null,
    timestamp = null,
  } = computed;

  return getDb()
    .prepare(
      `INSERT OR REPLACE INTO match_cache
         (match_id, account_id, timestamp, puuid, champion, position, win,
          kills, deaths, assists, cs, cs_per_min, damage_dealt, damage_share,
          gold, vision_score, duration_seconds, items,
          lp_before, lp_after, lp_delta, queue_type, raw_json,
          queue_id, champion_id, participant_id, team_id, game_version,
          has_detail, has_timeline, gold_diff_15, cs_diff_15, xp_diff_15)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
               ?, ?, ?, ?, ?,
               COALESCE((SELECT has_detail   FROM match_cache WHERE match_id = ? LIMIT 1), 0),
               COALESCE((SELECT has_timeline FROM match_cache WHERE match_id = ? LIMIT 1), 0),
               COALESCE((SELECT gold_diff_15 FROM match_cache WHERE match_id = ? LIMIT 1), NULL),
               COALESCE((SELECT cs_diff_15   FROM match_cache WHERE match_id = ? LIMIT 1), NULL),
               COALESCE((SELECT xp_diff_15   FROM match_cache WHERE match_id = ? LIMIT 1), NULL))`
    )
    .run(
      matchId,
      accountId,
      timestamp || Date.now(),
      puuid,
      champion,
      position,
      win !== null && win !== undefined ? (win ? 1 : 0) : null,
      kills,
      deaths,
      assists,
      cs,
      csPerMin ?? null,
      damageDealt ?? null,
      damageShare ?? null,
      gold,
      visionScore,
      durationSeconds,
      Array.isArray(items) ? JSON.stringify(items) : items,
      lpBefore ?? null,
      lpAfter ?? null,
      lpDelta ?? null,
      queueType,
      typeof rawJson === 'string' ? rawJson : JSON.stringify(rawJson),
      queueId,
      championId,
      participantId,
      teamId,
      gameVersion,
      // INSERT OR REPLACE deletes the old row, so previously-derived flags and
      // diffs must be carried forward explicitly or a re-fetch would clear them.
      matchId,
      matchId,
      matchId,
      matchId,
      matchId
    );
}

/** Single cached match row (raw columns, no JSON parsing). */
function getMatchCacheRow(matchId) {
  return getDb().prepare('SELECT * FROM match_cache WHERE match_id = ?').get(matchId) ?? null;
}

function getMatchCache(accountId, limit = 20) {
  const rows = getDb()
    .prepare('SELECT * FROM match_cache WHERE account_id = ? ORDER BY timestamp DESC LIMIT ?')
    .all(accountId, limit);

  return rows.map((row) => ({
    ...row,
    raw_json: (() => {
      try {
        return JSON.parse(row.raw_json);
      } catch {
        return row.raw_json;
      }
    })(),
  }));
}

/**
 * Cached rows for a specific set of match ids, same shape as `getMatchCache`.
 *
 * Used to stream newly-fetched games to the renderer during a long sweep: the
 * page merges these few rows instead of re-reading and re-rendering the whole
 * history every time one more game lands.
 */
function getMatchCacheByIds(accountId, matchIds) {
  if (!Array.isArray(matchIds) || matchIds.length === 0) return [];

  const placeholders = matchIds.map(() => '?').join(',');
  const rows = getDb()
    .prepare(
      `SELECT * FROM match_cache
        WHERE account_id = ? AND match_id IN (${placeholders})
        ORDER BY timestamp DESC`
    )
    .all(accountId, ...matchIds);

  return rows.map((row) => ({
    ...row,
    raw_json: safeParse(row.raw_json, row.raw_json),
  }));
}

function hasMatchInCache(matchId) {
  return !!getDb().prepare('SELECT 1 FROM match_cache WHERE match_id = ?').get(matchId);
}

/**
 * Whether this account already has its own row for a match. Distinct from
 * `hasMatchInCache`, which only says the game is cached for *somebody* — the
 * two differ whenever two tracked players shared a game.
 */
function hasMatchForAccount(matchId, accountId) {
  return !!getDb()
    .prepare('SELECT 1 FROM match_cache WHERE match_id = ? AND account_id = ?')
    .get(matchId, accountId);
}

/**
 * Removes rows filed under an account that record somebody else's game.
 *
 * A row is one player's view of a match, so `account_id` and `puuid` must agree.
 * They could disagree while match_cache was keyed by match_id alone: caching a
 * shared game for a second player rewrote the first player's row in place. The
 * key is fixed, but caches written before it was are still out there, and a
 * single wrong row means someone else's champion and KDA showing up in your
 * history. Cheap to check on every load, and the rows come back correctly on
 * the next refresh.
 */
function purgeForeignMatchRows(accountId, puuid) {
  if (!accountId || !puuid) return 0;
  const result = getDb()
    .prepare('DELETE FROM match_cache WHERE account_id = ? AND puuid IS NOT NULL AND puuid <> ?')
    .run(accountId, puuid);
  return result.changes;
}

/** Every cached perspective on one match, one row per account holding it. */
function getMatchCacheRows(matchId) {
  return getDb().prepare('SELECT * FROM match_cache WHERE match_id = ?').all(matchId);
}

// ── Match Detail (bans, objectives, full participants) ────────────────────────

function saveMatchDetail(matchId, detail = {}) {
  const {
    queueId = null,
    gameVersion = null,
    gameMode = null,
    gameDuration = null,
    teams = [],
    participants = [],
  } = detail;

  getDb()
    .prepare(
      `INSERT OR REPLACE INTO match_detail
         (match_id, queue_id, game_version, game_mode, game_duration,
          teams_json, participants_json, schema_version, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`
    )
    .run(
      matchId,
      queueId,
      gameVersion,
      gameMode,
      gameDuration,
      JSON.stringify(teams),
      JSON.stringify(participants),
      Date.now()
    );

  getDb().prepare('UPDATE match_cache SET has_detail = 1 WHERE match_id = ?').run(matchId);
}

function getMatchDetail(matchId) {
  const row = getDb().prepare('SELECT * FROM match_detail WHERE match_id = ?').get(matchId);
  if (!row) return null;
  return {
    matchId: row.match_id,
    queueId: row.queue_id,
    gameVersion: row.game_version,
    gameMode: row.game_mode,
    gameDuration: row.game_duration,
    teams: safeParse(row.teams_json, []),
    participants: safeParse(row.participants_json, []),
    schemaVersion: row.schema_version,
    fetchedAt: row.fetched_at,
  };
}

// ── Match Timeline ────────────────────────────────────────────────────────────

function saveMatchTimeline(matchId, compact) {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO match_timeline
         (match_id, frame_interval, frame_count, participants,
          frames_json, events_json, schema_version, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      matchId,
      compact.frameInterval,
      compact.frameCount,
      JSON.stringify(compact.participants),
      JSON.stringify(compact.frames),
      JSON.stringify(compact.events),
      compact.schemaVersion ?? 1,
      Date.now()
    );

  getDb().prepare('UPDATE match_cache SET has_timeline = 1 WHERE match_id = ?').run(matchId);
}

function getMatchTimeline(matchId) {
  const row = getDb().prepare('SELECT * FROM match_timeline WHERE match_id = ?').get(matchId);
  if (!row) return null;
  return {
    matchId: row.match_id,
    frameInterval: row.frame_interval,
    frameCount: row.frame_count,
    participants: safeParse(row.participants, []),
    frames: safeParse(row.frames_json, []),
    events: safeParse(row.events_json, []),
    schemaVersion: row.schema_version,
    fetchedAt: row.fetched_at,
  };
}

function hasMatchTimeline(matchId) {
  return !!getDb().prepare('SELECT 1 FROM match_timeline WHERE match_id = ?').get(matchId);
}

function hasMatchDetail(matchId) {
  return !!getDb().prepare('SELECT 1 FROM match_detail WHERE match_id = ?').get(matchId);
}

/** Match ids for an account still missing detail and/or timeline, newest first. */
function getMatchesNeedingBackfill(accountId, limit = 500) {
  return getDb()
    .prepare(
      `SELECT m.match_id, m.puuid, m.participant_id,
              (d.match_id IS NOT NULL) AS has_detail,
              (t.match_id IS NOT NULL) AS has_timeline
         FROM match_cache m
         LEFT JOIN match_detail   d ON d.match_id = m.match_id
         LEFT JOIN match_timeline t ON t.match_id = m.match_id
        WHERE m.account_id = ?
          AND (d.match_id IS NULL OR t.match_id IS NULL)
        ORDER BY m.timestamp DESC
        LIMIT ?`
    )
    .all(accountId, limit);
}

/**
 * Persists denormalised @15 differentials so the Champions table stays a single
 * query. Scoped to one account: a lane differential is measured from a specific
 * player's side, so it cannot be shared across the other rows for that match.
 */
function updateMatchDiffs(matchId, accountId, { goldDiff = null, csDiff = null, xpDiff = null } = {}) {
  getDb()
    .prepare(
      `UPDATE match_cache SET gold_diff_15 = ?, cs_diff_15 = ?, xp_diff_15 = ?
        WHERE match_id = ? AND account_id = ?`
    )
    .run(goldDiff, csDiff, xpDiff, matchId, accountId);
}

function safeParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

// ── App Settings ──────────────────────────────────────────────────────────────

function getSetting(key) {
  const row = getDb().prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  getDb()
    .prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)')
    .run(key, value ?? null);
}

// Encrypted variants — encryption is injected by main.js to keep safeStorage
// in the main process without creating a circular dependency here.
let _encryptFn = (v) => v;
let _decryptFn = (v) => v;

function setEncryptionHelpers(encryptFn, decryptFn) {
  _encryptFn = encryptFn;
  _decryptFn = decryptFn;
}

function getEncryptedSetting(key) {
  const raw = getSetting(key);
  if (!raw) return null;
  return _decryptFn(raw);
}

function setEncryptedSetting(key, value) {
  if (!value) {
    setSetting(key, null);
    return;
  }
  setSetting(key, _encryptFn(value));
}

module.exports = {
  initDatabase,
  getDb,
  computeAbsoluteLp,
  // LP snapshots
  saveLpSnapshot,
  getLpSnapshots,
  getLatestLpSnapshot,
  // Match cache
  saveMatchCache,
  getMatchCache,
  getMatchCacheByIds,
  getMatchCacheRow,
  getMatchCacheRows,
  purgeForeignMatchRows,
  hasMatchInCache,
  hasMatchForAccount,
  updateMatchDiffs,
  // Match detail
  saveMatchDetail,
  getMatchDetail,
  hasMatchDetail,
  // Match timeline
  saveMatchTimeline,
  getMatchTimeline,
  hasMatchTimeline,
  getMatchesNeedingBackfill,
  // App settings
  getSetting,
  setSetting,
  setEncryptionHelpers,
  getEncryptedSetting,
  setEncryptedSetting,
};
