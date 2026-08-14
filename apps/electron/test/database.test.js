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

// Asserted against the schema rather than a literal version, so adding a
// migration does not fail a test that has nothing to do with it.
const schemaCols = handle.pragma('table_info(rank_snapshots)').map((c) => c.name);
const requiredCols = [
  'account_id', 'queue', 'day', 'tier', 'division', 'league_points', 'score',
  'wins', 'losses', 'games', 'difference', 'series_start', 'inactive', 'observed_at',
];
check('every rank_snapshots column exists',
  requiredCols.filter((c) => !schemaCols.includes(c)), []);
check('migrations ran past the daily-series version',
  handle.pragma('user_version', { simple: true }) >= 6, true);

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

// ── Season / split resets ─────────────────────────────────────────────────────
// Counters running backwards is the only unambiguous reset signal: an LP drop
// on its own is indistinguishable from a losing streak.
db.recordRankSnapshot('acc1', 'RANKED_SOLO_5x5',
  { tier: 'SILVER', rank: 'I', leaguePoints: 0, wins: 1, losses: 0 }, at(2026, 8, 7, 11));
const afterReset = db.getRankSnapshots('acc1')[4];
check('a reset does not emit negative games', afterReset.games, 0);
check('a reset is flagged as a series start', afterReset.series_start, 1);
check('difference is not measured across a reset', afterReset.difference, 0);

// The day after a reset is an ordinary day again, measured from the new floor.
db.recordRankSnapshot('acc1', 'RANKED_SOLO_5x5',
  { tier: 'SILVER', rank: 'I', leaguePoints: 40, wins: 4, losses: 1 }, at(2026, 8, 8, 11));
const postReset = db.getRankSnapshots('acc1')[5];
check('normal service resumes after a reset', postReset.series_start, 0);
check('difference measured from the new floor', postReset.difference, 40);
check('games measured from the new floor', postReset.games, 4 + 1 - (1 + 0));

// ── Decay flag ────────────────────────────────────────────────────────────────
db.recordRankSnapshot('acc1', 'RANKED_SOLO_5x5',
  { tier: 'SILVER', rank: 'I', leaguePoints: 20, wins: 4, losses: 1, inactive: true },
  at(2026, 8, 9, 11));
check('decay flag persisted', db.getRankSnapshots('acc1')[6].inactive, 1);
db.recordRankSnapshot('acc1', 'RANKED_SOLO_5x5',
  { tier: 'SILVER', rank: 'I', leaguePoints: 25, wins: 5, losses: 1, inactive: false },
  at(2026, 8, 10, 11));
check('decay flag cleared when Riot clears it', db.getRankSnapshots('acc1')[7].inactive, 0);
// The LCU does not report decay; unknown must stay unknown rather than false.
db.recordRankSnapshot('acc1', 'RANKED_SOLO_5x5',
  { tier: 'SILVER', rank: 'I', leaguePoints: 30 }, at(2026, 8, 11, 11));
check('decay unknown stays null', db.getRankSnapshots('acc1')[8].inactive, null);

// ── Queues are independent series ─────────────────────────────────────────────
db.recordRankSnapshot('acc1', 'RANKED_FLEX_SR',
  { tier: 'GOLD', rank: 'I', leaguePoints: 30, wins: 10, losses: 5 }, at(2026, 8, 6, 11));
check('flex is its own series', db.getRankSnapshots('acc1', 'RANKED_FLEX_SR').length, 1);
check('solo is unaffected by a flex write', db.getRankSnapshots('acc1').length, 9);
check('queues are discoverable', db.getRankSnapshotQueues('acc1'),
  ['RANKED_FLEX_SR', 'RANKED_SOLO_5x5']);

// ── Migrations are idempotent ─────────────────────────────────────────────────
db.initDatabase(dir);
check('re-initialising leaves the series intact', db.getRankSnapshots('acc1').length, 9);

// ── Teardown ──────────────────────────────────────────────────────────────────
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
try {
  db.getDb().close();
  fs.rmSync(dir, { recursive: true, force: true });
} catch {
  // Windows can hold the WAL open a moment longer; the temp dir is disposable.
}
process.exit(failures === 0 ? 0 : 1);
