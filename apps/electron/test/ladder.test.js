'use strict';

/**
 * Ladder sweep tests. Run via `npm run test:db --workspace=apps/electron`.
 *
 * This module produces a single number — "you are #4,321" — and a wrong one
 * looks exactly like a right one. Nothing in the app can catch that: the build
 * passes, the panel renders, and the figure is simply false. So the fake ladder
 * below is generated with a *known* population, which makes every assertion a
 * comparison against arithmetic done independently of the code under test.
 *
 * The requests are counted as well as the answers. The binary search exists
 * solely to keep the sweep affordable on a development key, and a regression
 * that quietly turns it into a linear scan would still return the right
 * position — just hours later.
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
// Deliberately uneven: every division a different size, several not a multiple
// of the page size, and one empty. Uniform sizes would hide off-by-ones in the
// last-page arithmetic, which is the only place this code can be wrong quietly.

const PAGE = 205;

/** players[`TIER/DIV`] = array of entries, highest LP first is NOT assumed. */
const population = new Map();

function seedBucket(tier, division, count, lpAt) {
  const entries = [];
  for (let i = 0; i < count; i++) {
    entries.push({
      puuid: `p-${tier}-${division}-${i}`,
      tier,
      rank: division,
      leaguePoints: lpAt(i),
      wins: 40 + (i % 7),
      losses: 30 + (i % 5),
      inactive: false,
    });
  }
  population.set(`${tier}/${division}`, entries);
}

// Sizes chosen so that: one bucket is empty, one is a single short page, one is
// exactly a whole number of pages, and the rest are neither.
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
  // The bucket under test. LP cycles 0..99 so the count above any given LP is
  // computable by hand rather than by re-running the code being tested.
  'EMERALD/II': 617,
  'EMERALD/I': 500,
  'DIAMOND/IV': 300,
  'DIAMOND/III': 200,
  'DIAMOND/II': 120,
  'DIAMOND/I': 80,
};

for (const [key, count] of Object.entries(SIZES)) {
  const [tier, division] = key.split('/');
  seedBucket(tier, division, count, (i) => i % 100);
}

const APEX = { MASTER: 60, GRANDMASTER: 25, CHALLENGER: 10 };
for (const [tier, count] of Object.entries(APEX)) {
  seedBucket(tier, 'I', count, (i) => 200 + i * 13);
}

const TOTAL_PLAYERS =
  Object.values(SIZES).reduce((a, b) => a + b, 0) +
  Object.values(APEX).reduce((a, b) => a + b, 0);

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
    return { tier, entries: population.get(`${tier}/I`) ?? [] };
  }

  const m = url.match(/entries\/[^/]+\/([A-Z]+)\/([IV]+)\?page=(\d+)/);
  if (!m) throw new Error(`unexpected url: ${url}`);

  const [, tier, division, page] = m;
  const all = population.get(`${tier}/${division}`) ?? [];
  const start = (Number(page) - 1) * PAGE;
  return all.slice(start, start + PAGE);
}

// ── The account under test ────────────────────────────────────────────────────
//
// Emerald II, 60 LP. Worked out by hand from the seed above:
//   · EMERALD/II holds 617 players with LP = i % 100, i in 0..616.
//   · LP values 0..16 appear 7 times (i, i+100, … i+600); 17..99 appear 6 times.
//   · Players above 60 LP: values 61..99 → 17..99 band only → 39 values × 6 = 234.
//   · The account itself is one of the 60-LP entries and is skipped, so 6 - 1 = 5
//     others tie with it.

const SELF = population.get('EMERALD/II').find((e) => e.leaguePoints === 60);

const ABOVE_IN_BUCKET = 234;
const TIERS_ABOVE =
  SIZES['EMERALD/I'] +
  SIZES['DIAMOND/IV'] +
  SIZES['DIAMOND/III'] +
  SIZES['DIAMOND/II'] +
  SIZES['DIAMOND/I'] +
  APEX.MASTER +
  APEX.GRANDMASTER +
  APEX.CHALLENGER;

async function main() {
  // ── Cold sweep ─────────────────────────────────────────────────────────────
  requestCount = 0;
  const cold = await ladder.sweepLadderPosition(
    { puuid: SELF.puuid, tier: 'EMERALD', division: 'II', leaguePoints: 60 },
    { platform: 'test1', queue: 'RANKED_SOLO_5x5', request }
  );

  check('position counts every player above', cold.position, TIERS_ABOVE + ABOVE_IN_BUCKET + 1);
  check('total is the whole region', cold.total, TOTAL_PLAYERS);
  check('place within the division', cold.bucketPosition, ABOVE_IN_BUCKET + 1);
  check('division size', cold.bucketTotal, SIZES['EMERALD/II']);
  check('ties are reported, not hidden', cold.ties, 5);
  check(
    'percentile is position over total',
    Math.round(cold.percentile * 1000) / 1000,
    Math.round(((TIERS_ABOVE + ABOVE_IN_BUCKET + 1) / TOTAL_PLAYERS) * 100 * 1000) / 1000
  );
  check('the account finds its own entry', cold.entry?.puuid, SELF.puuid);
  check('the entry carries win/loss counts', cold.entry?.wins, SELF.wins);

  // 28 divisions binary-searched + 3 apex leagues + a full read of a 4-page
  // division. A linear scan of the ladder would be ~130 requests here; the real
  // ladder makes that difference three orders of magnitude wider.
  checkAtMost('cold sweep stays cheap', requestCount, 260);

  // ── Census reuse ───────────────────────────────────────────────────────────
  //
  // The point of caching the census: a second sweep should pay for the account's
  // own division and essentially nothing else.
  const ownPages = Math.ceil(SIZES['EMERALD/II'] / PAGE);
  requestCount = 0;
  const warm = await ladder.sweepLadderPosition(
    { puuid: SELF.puuid, tier: 'EMERALD', division: 'II', leaguePoints: 60 },
    { platform: 'test1', queue: 'RANKED_SOLO_5x5', request }
  );

  check('a cached census gives the same answer', warm.position, cold.position);
  check('census rows were reused', warm.censusReused > 0, true);
  // Own division (4 pages, plus the binary search's bracketing probes) and the
  // 3 apex leagues, which are one request each and never cached.
  checkAtMost('warm sweep only re-reads what it must', requestCount, ownPages + 3 + 4);

  // ── Estimate agrees with reality ───────────────────────────────────────────
  const estimate = ladder.estimateSweep('test1', 'RANKED_SOLO_5x5', 'EMERALD', 'II');
  check('estimate knows the census is cached', estimate.exact, true);
  check('estimate knows the division length', estimate.ownPages, ownPages);

  // ── Apex ───────────────────────────────────────────────────────────────────
  //
  // Master/GM/Challenger have no divisions and come from their own endpoints;
  // the position arithmetic has to keep working across that seam.
  const gm = population.get('GRANDMASTER/I')[10];
  const gmAbove = population
    .get('GRANDMASTER/I')
    .filter((e) => e.leaguePoints > gm.leaguePoints).length;

  const apexResult = await ladder.sweepLadderPosition(
    { puuid: gm.puuid, tier: 'GRANDMASTER', division: 'I', leaguePoints: gm.leaguePoints },
    { platform: 'test1', queue: 'RANKED_SOLO_5x5', request }
  );

  check('apex counts only Challenger above the tier', apexResult.position, APEX.CHALLENGER + gmAbove + 1);
  check('apex division size is the league size', apexResult.bucketTotal, APEX.GRANDMASTER);

  // ── Cancellation ───────────────────────────────────────────────────────────
  //
  // A sweep is minutes long, so cancelling has to actually stop it rather than
  // run to completion and discard the result.
  requestCount = 0;
  const cancelled = await ladder.sweepLadderPosition(
    { puuid: SELF.puuid, tier: 'EMERALD', division: 'II', leaguePoints: 60 },
    {
      platform: 'test1',
      queue: 'RANKED_SOLO_5x5',
      request,
      shouldCancel: () => requestCount >= 3,
    }
  );
  check('cancelling reports itself', cancelled.cancelled, true);
  checkAtMost('cancelling stops promptly', requestCount, 12);

  // ── Persistence ────────────────────────────────────────────────────────────
  db.recordLadderPosition('acct-1', 'RANKED_SOLO_5x5', cold);
  db.recordLadderPosition('acct-1', 'RANKED_SOLO_5x5', { ...cold, position: cold.position - 10 });

  const rows = db.getLadderPositions('acct-1', 'RANKED_SOLO_5x5');
  check('two sweeps in a day stay one row', rows.length, 1);
  check('the later sweep wins', rows[0].position, cold.position - 10);
  check('percentile survives the round trip', Math.round(rows[0].percentile), Math.round(cold.percentile));

  // ── An unrecognised rank is refused, not guessed ───────────────────────────
  let threw = null;
  try {
    await ladder.sweepLadderPosition(
      { puuid: 'x', tier: 'WOOD', division: 'V', leaguePoints: 0 },
      { platform: 'test1', queue: 'RANKED_SOLO_5x5', request }
    );
  } catch (err) {
    threw = err.code;
  }
  check('an unknown tier throws rather than placing you somewhere', threw, 'BAD_RANK');

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
