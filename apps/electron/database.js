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
      match_id      TEXT    PRIMARY KEY,
      account_id    TEXT    NOT NULL,
      timestamp     INTEGER NOT NULL,
      cs_per_min    REAL,
      damage_share  REAL,
      lp_delta      REAL,
      raw_json      TEXT    NOT NULL
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
 */
function runMigrations() {
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
  ];
  for (const [col, type] of columnsToAdd) {
    if (!existingCols.includes(col)) {
      db.exec(`ALTER TABLE match_cache ADD COLUMN ${col} ${type}`);
    }
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
    timestamp = null,
  } = computed;

  return getDb()
    .prepare(
      `INSERT OR REPLACE INTO match_cache
         (match_id, account_id, timestamp, puuid, champion, position, win,
          kills, deaths, assists, cs, cs_per_min, damage_dealt, damage_share,
          gold, vision_score, duration_seconds, items,
          lp_before, lp_after, lp_delta, queue_type, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      typeof rawJson === 'string' ? rawJson : JSON.stringify(rawJson)
    );
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

function hasMatchInCache(matchId) {
  return !!getDb().prepare('SELECT 1 FROM match_cache WHERE match_id = ?').get(matchId);
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
  hasMatchInCache,
  // App settings
  getSetting,
  setSetting,
  setEncryptionHelpers,
  getEncryptedSetting,
  setEncryptedSetting,
};
