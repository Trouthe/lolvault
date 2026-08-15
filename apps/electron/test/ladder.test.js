'use strict';

/**
 * Ladder harvest tests. Run via `npm run test:db --workspace=apps/electron`.
 *
 * The harvest exists for exactly one reason — to spend fewer Riot requests than
 * looking players up one at a time — so the request count is asserted as
 * carefully as the data. A regression that returns every correct rank while
 * quietly paging twice as much has broken the only thing this module is for,
 * and nothing else in the app would notice.
 *
 * The fake ladder below has a known population, so every expectation is
 * arithmetic done independently of the code under test.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const db = require('../database');
const ladder = require('../ladder');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lolvault-ladder-'));
db.initDatabase(dir);

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

function checkAtMost(label, actual, ceiling) {
  if (actual <= ceiling) {
    console.log(`PASS  ${label} (${actual} <= ${ceiling})`);
  } else {
    failures++;
    console.log(`FAIL  ${label}: ${actual} exceeded ${ceiling}`);
  }
}

// ── A fake region ─────────────────────────────────────────────────────────────
//
// Sizes are deliberately uneven: one division empty, one a single short page,
// one an exact multiple of the page size, the rest neither. Uniform sizes would
// hide off-by-ones in the last-page arithmetic, which is where this code can be
// wrong without anything looking wrong.

const PAGE = 205;
const population = new Map();

function seedBucket(tier, division, count) {
  const entries = [];
  for (let i = 0; i < count; i++) {
    entries.push({
      puuid: `p-${tier}-${division}-${i}`,
      tier,
      rank: division,
      leaguePoints: i % 100,
      wins: 40 + (i % 7),
      losses: 30 + (i % 5),
      inactive: false,
    });
  }
  population.set(`${tier}/${division}`, entries);
}

const SIZES = {
  'IRON/IV': 0,
  'IRON/III': 7,
  'IRON/II': PAGE,
  'IRON/I': PAGE * 2,
  'BRONZE/IV': 411,
  'BRONZE/III': 205,
  'BRONZE/II': 1000,
  'BRONZE/I': 640,
  'SILVER/IV': 2050,
  'SILVER/III': 1234,
  'SILVER/II': 900,
  'SILVER/I': 777,
  'GOLD/IV': 3000,
  'GOLD/III': 2600,
  'GOLD/II': 2100,
  'GOLD/I': 1800,
  'PLATINUM/IV': 1500,
  'PLATINUM/III': 1300,
  'PLATINUM/II': 1100,
  'PLATINUM/I': 950,
  'EMERALD/IV': 820,
  'EMERALD/III': 700,
  'EMERALD/II': 617,
  'EMERALD/I': 500,
  'DIAMOND/IV': 300,
  'DIAMOND/III': 200,
  'DIAMOND/II': 120,
  'DIAMOND/I': 80,
};

for (const [key, count] of Object.entries(SIZES)) {
  const [tier, division] = key.split('/');
  seedBucket(tier, division, count);
}

const APEX = { MASTER: 60, GRANDMASTER: 25, CHALLENGER: 10 };
for (const [tier, count] of Object.entries(APEX)) seedBucket(tier, 'I', count);

// ── Fake Riot ─────────────────────────────────────────────────────────────────

let requestCount = 0;

const APEX_PATHS = {
  masterleagues: 'MASTER',
  grandmasterleagues: 'GRANDMASTER',
  challengerleagues: 'CHALLENGER',
};

async function request(url) {
  requestCount++;

  const apex = url.match(/league\/v4\/(\w+)\/by-queue\//);
  if (apex) {
    const tier = APEX_PATHS[apex[1]];
    // Apex payloads carry the tier on the league, not on each entry — the
    // harvest has to put it back, and that is worth testing.
    const entries = (population.get(`${tier}/I`) ?? []).map(({ tier: _t, rank: _r, ...rest }) => rest);
    return { tier, entries };
  }

  const m = url.match(/entries\/[^/]+\/([A-Z]+)\/([IV]+)\?page=(\d+)/);
  if (!m) throw new Error(`unexpected url: ${url}`);

  const [, tier, division, page] = m;
  const all = population.get(`${tier}/${division}`) ?? [];
  const start = (Number(page) - 1) * PAGE;
  return all.slice(start, start + PAGE);
}

const PLATFORM = 'test1';
const QUEUE = 'RANKED_SOLO_5x5';

function harvest(buckets, extra = {}) {
  const cached = [];
  return ladder
    .harvestLadder({
      platform: PLATFORM,
      queue: QUEUE,
      buckets,
      request,
      onEntries: (entries) => {
        cached.push(...entries);
        db.savePlayerRanks(entries, PLATFORM, QUEUE, 'ladder');
      },
      ...extra,
    })
    .then((result) => ({ ...result, cached }));
}

async function main() {
  // ── Which divisions get harvested ──────────────────────────────────────────
  //
  // The cost control: matchmaking stays near your rank, so the harvest does too.
  check(
    'spread 1 reaches one division either side',
    ladder.bucketsAround('EMERALD', 'II', 1).map((b) => `${b.tier}/${b.division}`),
    ['EMERALD/III', 'EMERALD/II', 'EMERALD/I']
  );
  check(
    'spread 0 is the division alone',
    ladder.bucketsAround('EMERALD', 'II', 0).map((b) => `${b.tier}/${b.division}`),
    ['EMERALD/II']
  );
  check(
    'the range crosses tier boundaries',
    ladder.bucketsAround('EMERALD', 'I', 1).map((b) => `${b.tier}/${b.division}`),
    ['EMERALD/II', 'EMERALD/I', 'DIAMOND/IV']
  );
  // Challenger is the last bucket, so reaching two beyond it must clamp rather
  // than slice past the end of the ladder.
  check(
    'the top of the ladder does not run off the end',
    ladder.bucketsAround('CHALLENGER', 'I', 2).map((b) => b.tier),
    ['MASTER', 'GRANDMASTER', 'CHALLENGER']
  );
  check(
    'nor does the bottom',
    ladder.bucketsAround('IRON', 'IV', 2).map((b) => `${b.tier}/${b.division}`),
    ['IRON/IV', 'IRON/III', 'IRON/II']
  );
  check('an unknown tier harvests nothing', ladder.bucketsAround('WOOD', 'V', 1), []);

  // ── A cold harvest ─────────────────────────────────────────────────────────
  const buckets = ladder.bucketsAround('EMERALD', 'II', 1);
  const expectedPlayers = SIZES['EMERALD/III'] + SIZES['EMERALD/II'] + SIZES['EMERALD/I'];
  const expectedPages =
    Math.ceil(SIZES['EMERALD/III'] / PAGE) +
    Math.ceil(SIZES['EMERALD/II'] / PAGE) +
    Math.ceil(SIZES['EMERALD/I'] / PAGE);

  requestCount = 0;
  const cold = await harvest(buckets);

  check('every player in range is cached', cold.players, expectedPlayers);
  check('every page is read exactly once', cold.pages, expectedPages);
  check('the harvest is not reported as cancelled', cold.cancelled, false);

  // The whole point. Looking these players up one at a time is one request each;
  // sizing the divisions adds a handful of probes on top of the pages.
  checkAtMost('bulk is cheaper than per-player by two orders of magnitude', requestCount, 40);
  check(
    'a per-player lookup would have cost this instead',
    expectedPlayers > requestCount * 100,
    true
  );

  // ── The cache is what the app reads ────────────────────────────────────────
  const sample = population.get('EMERALD/II')[42];
  const ranks = db.getPlayerRanks([sample.puuid, 'nobody'], PLATFORM, QUEUE);

  check('a harvested player is in the cache', ranks[sample.puuid]?.tier, 'EMERALD');
  check('division survives the round trip', ranks[sample.puuid]?.division, 'II');
  check('LP survives the round trip', ranks[sample.puuid]?.league_points, sample.leaguePoints);
  check('win/loss counts come along for free', ranks[sample.puuid]?.wins, sample.wins);
  check('the source is recorded', ranks[sample.puuid]?.source, 'ladder');
  // A miss must be absent rather than a zero row — the difference between "we
  // have not seen them" and "they are Iron IV 0 LP".
  check('a player never seen is absent, not zeroed', ranks['nobody'], undefined);

  // Absolute LP is what makes lobby averages possible at all.
  check(
    'absolute LP is on the same scale the app averages with',
    ranks[sample.puuid]?.score,
    db.computeAbsoluteLp('EMERALD', 'II', sample.leaguePoints)
  );

  const stats = db.getPlayerRankStats(PLATFORM, QUEUE);
  check('cache stats count the harvest', stats.players, expectedPlayers);
  check('and attribute it to the ladder', stats.fromLadder, expectedPlayers);

  // ── A warm harvest ─────────────────────────────────────────────────────────
  //
  // The census remembers the page counts, so the sizing probes mostly vanish.
  requestCount = 0;
  const warm = await harvest(buckets);
  check('a warm harvest reads the same players', warm.players, expectedPlayers);
  checkAtMost('and spends fewer requests doing it', requestCount, expectedPages + 6);

  const plan = ladder.estimateHarvest(PLATFORM, QUEUE, buckets);
  check('the estimate knows every page count', plan.exact, true);
  check('so it quotes the real page total', plan.requests, expectedPages);

  // ── Apex ───────────────────────────────────────────────────────────────────
  //
  // Master and above come from their own endpoints, one request per league, and
  // arrive without a tier on each entry.
  requestCount = 0;
  const apex = await harvest(ladder.bucketsAround('CHALLENGER', 'I', 1));

  check('the whole apex range is 2 requests', requestCount, 2);
  check('and yields both leagues', apex.players, APEX.GRANDMASTER + APEX.CHALLENGER);

  const challenger = population.get('CHALLENGER/I')[0];
  const apexRank = db.getPlayerRanks([challenger.puuid], PLATFORM, QUEUE)[challenger.puuid];
  check('apex entries get their tier put back', apexRank?.tier, 'CHALLENGER');

  // ── An empty division ──────────────────────────────────────────────────────
  requestCount = 0;
  const empty = await harvest(ladder.bucketsAround('IRON', 'IV', 0));
  check('an empty division yields nobody', empty.players, 0);
  checkAtMost('and costs one request to find that out', requestCount, 1);

  // ── Cancellation ───────────────────────────────────────────────────────────
  //
  // A harvest runs for minutes, so cancelling has to stop it rather than run to
  // completion and throw the result away.
  requestCount = 0;
  const cancelled = await harvest(ladder.bucketsAround('GOLD', 'II', 1), {
    shouldCancel: () => requestCount >= 3,
  });
  check('cancelling reports itself', cancelled.cancelled, true);
  checkAtMost('cancelling stops promptly', requestCount, 12);

  // ── Lookups fill what a harvest missed ─────────────────────────────────────
  db.savePlayerRanks(
    [{ puuid: 'smurf-1', tier: 'SILVER', rank: 'I', leaguePoints: 12, wins: 3, losses: 1 }],
    PLATFORM,
    QUEUE,
    'lookup'
  );
  const smurf = db.getPlayerRanks(['smurf-1'], PLATFORM, QUEUE)['smurf-1'];
  check('a single lookup caches too', smurf?.tier, 'SILVER');
  check('and is marked as having cost a request', smurf?.source, 'lookup');

  // ── Platforms and queues do not bleed into each other ──────────────────────
  check(
    'another platform sees nothing',
    Object.keys(db.getPlayerRanks([sample.puuid], 'other1', QUEUE)).length,
    0
  );
  check(
    'another queue sees nothing',
    Object.keys(db.getPlayerRanks([sample.puuid], PLATFORM, 'RANKED_FLEX_SR')).length,
    0
  );

  // ── A lobby-sized read ─────────────────────────────────────────────────────
  //
  // What the match card actually does: one query for ten players.
  const lobby = population.get('EMERALD/II').slice(0, 10).map((e) => e.puuid);
  const lobbyRanks = db.getPlayerRanks(lobby, PLATFORM, QUEUE);
  check('a whole lobby resolves in one read', Object.keys(lobbyRanks).length, 10);

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed.`);
    process.exit(1);
  }
  console.log('\nALL PASS');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
