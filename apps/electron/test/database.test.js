'use strict';

/**
 * Main-process database tests. Run via `npm run test:db --workspace=apps/electron`.
 *
 * Focus is the v5 → v6 migration and the daily rank series, because both touch
 * data that cannot be re-fetched: Riot exposes no LP history, so a migration
 * that drops or double-counts rows destroys the only copy that exists.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const db = require('../database');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lolvault-test-'));
const dbPath = path.join(dir, 'lolvault.db');

let failures = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.log(`FAIL  ${label}`);
    console.log(`        got  ${JSON.stringify(actual)}`);
    console.log(`        want ${JSON.stringify(expected)}`);
  } else {
    console.log(`PASS  ${label}`);
  }
}

/** Local-time timestamp, matching how the series buckets days. */
const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime();

// ── Build a v5 database holding legacy snapshots ──────────────────────────────
// Simulates an existing install: lp_snapshots already has rows, rank_snapshots
// does not exist yet.
db.initDatabase(dir);
const raw = new Database(dbPath);
raw.exec('DROP TABLE IF EXISTS rank_snapshots');
raw.pragma('user_version = 5');

const seed = raw.prepare(
  `INSERT INTO lp_snapshots (account_id, timestamp, tier, division, lp, absolute_lp)
   VALUES (?, ?, ?, ?, ?, ?)`
);
seed.run('acc1', at(2026, 8, 1, 10), 'EMERALD', 'IV', 20, 2020);
seed.run('acc1', at(2026, 8, 1, 22), 'EMERALD', 'IV', 45, 2045); // same day, later
seed.run('acc1', at(2026, 8, 3, 20), 'EMERALD', 'III', 12, 2112);
seed.run('acc2', at(2026, 8, 2, 15), 'GOLD', 'II', 80, 1280);
raw.close();

// ── Migration ─────────────────────────────────────────────────────────────────
const handle = db.initDatabase(dir);
check('user_version advances to 6', handle.pragma('user_version', { simple: true }), 6);

const series = db.getRankSnapshots('acc1');
check('3 readings over 2 days collapse to 2 rows', series.length, 2);
check('a day keeps its LAST reading', series[0].league_points, 45);
check('score carried across', series[0].score, 2045);
check('first row difference is 0', series[0].difference, 0);
check('difference spans an inactive gap', series[1].difference, 2112 - 2045);
check('backfilled games stay 0', [series[0].games, series[1].games], [0, 0]);
check('accounts stay separate', db.getRankSnapshots('acc2').length, 1);
check('legacy rows are filed as solo queue', series[0].queue, 'RANKED_SOLO_5x5');

// ── recordRankSnapshot ────────────────────────────────────────────────────────
const day5 = at(2026, 8, 5, 9);
db.recordRankSnapshot('acc1', 'RANKED_SOLO_5x5',
  { tier: 'EMERALD', rank: 'III', leaguePoints: 50, wins: 100, losses: 90 }, day5);

let s = db.getRankSnapshots('acc1');
check('a new day appends', s.length, 3);
check('difference measured against previous day', s[2].difference, 2150 - 2112);
check('games needs a win/loss baseline on both ends', s[2].games, 0);

// Same day, later, after more games — must upsert, not append.
db.recordRankSnapshot('acc1', 'RANKED_SOLO_5x5',
  { tier: 'EMERALD', rank: 'III', leaguePoints: 88, wins: 102, losses: 91 }, day5 + 3_600_000);
s = db.getRankSnapshots('acc1');
check('same day upserts rather than appending', s.length, 3);
check('upsert keeps the latest reading', s[2].league_points, 88);
check('difference does not compound on re-write', s[2].difference, 2188 - 2112);

// Next day: a baseline now exists, so games becomes real.
db.recordRankSnapshot('acc1', 'RANKED_SOLO_5x5',
  { tier: 'EMERALD', rank: 'II', leaguePoints: 10, wins: 104, losses: 92 }, at(2026, 8, 6, 11));
s = db.getRankSnapshots('acc1');
check('games = delta of wins+losses', s[3].games, 104 + 92 - (102 + 91));
check('difference crosses a division boundary', s[3].difference, 2210 - 2188);

// ── Guards ────────────────────────────────────────────────────────────────────
check('unranked writes nothing',
  db.recordRankSnapshot('acc1', 'RANKED_SOLO_5x5', { tier: 'UNRANKED', leaguePoints: 0 }), null);
check('missing LP writes nothing',
  db.recordRankSnapshot('acc1', 'RANKED_SOLO_5x5', { tier: 'EMERALD', rank: 'II' }), null);
check('guarded calls leave the series alone', db.getRankSnapshots('acc1').length, 4);

// A season reset lowers wins+losses; games must not go negative.
db.recordRankSnapshot('acc1', 'RANKED_SOLO_5x5',
  { tier: 'SILVER', rank: 'I', leaguePoints: 0, wins: 1, losses: 0 }, at(2026, 8, 7, 11));
check('a reset does not emit negative games', db.getRankSnapshots('acc1')[4].games, 0);

// ── Queues are independent series ─────────────────────────────────────────────
db.recordRankSnapshot('acc1', 'RANKED_FLEX_SR',
  { tier: 'GOLD', rank: 'I', leaguePoints: 30, wins: 10, losses: 5 }, at(2026, 8, 6, 11));
check('flex is its own series', db.getRankSnapshots('acc1', 'RANKED_FLEX_SR').length, 1);
check('solo is unaffected by a flex write', db.getRankSnapshots('acc1').length, 5);
check('queues are discoverable', db.getRankSnapshotQueues('acc1'),
  ['RANKED_FLEX_SR', 'RANKED_SOLO_5x5']);

// ── Migrations are idempotent ─────────────────────────────────────────────────
db.initDatabase(dir);
check('re-initialising leaves the series intact', db.getRankSnapshots('acc1').length, 5);

// ── Teardown ──────────────────────────────────────────────────────────────────
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
try {
  db.getDb().close();
  fs.rmSync(dir, { recursive: true, force: true });
} catch {
  // Windows can hold the WAL open a moment longer; the temp dir is disposable.
}
process.exit(failures === 0 ? 0 : 1);
