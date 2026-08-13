'use strict';

/**
 * Rank recorder tests. Run via `npm run test:db --workspace=apps/electron`.
 *
 * The recorder runs unattended on a timer, so its failure modes are the ones
 * nobody will be watching: a revoked key, an account Riot 404s, a pass that
 * overlaps the previous one. Each of those must degrade to "record less", never
 * to "throw" or "record wrong".
 *
 * riot-api.service is stubbed by overwriting its exports, which works because
 * rank-recorder calls them as properties off the required module.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const db = require('../database');
const riotApi = require('../riot-api.service');
const recorder = require('../rank-recorder');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lolvault-recorder-'));
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

function writeAccounts(accounts) {
  fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify(accounts), 'utf8');
}

const entry = (queueType, tier, rank, lp, wins = 10, losses = 5) => ({
  queueType,
  tier,
  rank,
  leaguePoints: lp,
  wins,
  losses,
});

// ── Stubs ─────────────────────────────────────────────────────────────────────
const realGetApiKey = riotApi.getApiKey;
const realGetRanked = riotApi.getRankedByPuuid;

let apiKey = 'RGAPI-test';
let rankedByPuuid = {};
let calls = [];

riotApi.getApiKey = () => apiKey;
riotApi.getRankedByPuuid = async (puuid) => {
  calls.push(puuid);
  const result = rankedByPuuid[puuid];
  if (result instanceof Error) throw result;
  return result ?? [];
};

// The recorder reads accounts.json out of the path this returns.
const getDataPath = () => dir;
const runPass = (reason = 'test') => {
  calls = [];
  return recorder.recordAllAccounts.call(null, reason);
};

// startRankRecorder is what injects getDataPath; call it and immediately stop
// the timers so only the explicit passes below run.
recorder.startRankRecorder(getDataPath);
recorder.stopRankRecorder();

(async () => {
  // ── No API key: nothing is attempted ───────────────────────────────────────
  writeAccounts([{ id: 1, syncId: 'v1', name: 'One', server: 'EUNE', puuid: 'p1' }]);
  rankedByPuuid = { p1: [entry('RANKED_SOLO_5x5', 'EMERALD', 'II', 40)] };
  apiKey = null;
  await runPass('no-key');
  check('no API key means no Riot calls', calls.length, 0);
  check('no API key means no rows', db.getRankSnapshots('v1').length, 0);
  apiKey = 'RGAPI-test';

  // ── Accounts without a PUUID are skipped, not resolved ─────────────────────
  writeAccounts([
    { id: 1, syncId: 'v1', name: 'One', server: 'EUNE', puuid: 'p1' },
    { id: 2, syncId: 'v2', name: 'NoPuuid', server: 'EUW' },
  ]);
  await runPass();
  check('only accounts with a PUUID are fetched', calls, ['p1']);
  check('solo row written', db.getRankSnapshots('v1').length, 1);
  check('score computed on the absolute scale', db.getRankSnapshots('v1')[0].score, 2240);
  check('account without a PUUID has no series', db.getRankSnapshots('v2').length, 0);

  // ── Repeat pass the same day upserts rather than duplicating ───────────────
  rankedByPuuid = { p1: [entry('RANKED_SOLO_5x5', 'EMERALD', 'II', 75)] };
  await runPass();
  check('same day stays one row', db.getRankSnapshots('v1').length, 1);
  check('row reflects the newer reading', db.getRankSnapshots('v1')[0].league_points, 75);

  // ── Flex is recorded, unranked queue types are ignored ─────────────────────
  rankedByPuuid = {
    p1: [
      entry('RANKED_SOLO_5x5', 'EMERALD', 'II', 75),
      entry('RANKED_FLEX_SR', 'GOLD', 'I', 20),
      entry('CHERRY', 'GOLD', 'I', 99),
    ],
  };
  await runPass();
  check('flex recorded', db.getRankSnapshots('v1', 'RANKED_FLEX_SR').length, 1);
  check('untracked queue ignored', db.getRankSnapshots('v1', 'CHERRY').length, 0);

  // ── One failing account must not stop the others ───────────────────────────
  writeAccounts([
    { id: 1, syncId: 'v1', name: 'One', server: 'EUNE', puuid: 'p1' },
    { id: 3, syncId: 'v3', name: 'Broken', server: 'EUW', puuid: 'bad' },
    { id: 4, syncId: 'v4', name: 'Three', server: 'NA', puuid: 'p4' },
  ]);
  rankedByPuuid = {
    p1: [entry('RANKED_SOLO_5x5', 'EMERALD', 'II', 75)],
    bad: new Error('403'),
    p4: [entry('RANKED_SOLO_5x5', 'SILVER', 'IV', 10)],
  };
  await runPass();
  check('a throwing account does not abort the pass', calls, ['p1', 'bad', 'p4']);
  check('accounts after the failure still recorded', db.getRankSnapshots('v4').length, 1);

  // ── In-band error objects are treated as failures, not as data ─────────────
  writeAccounts([{ id: 5, syncId: 'v5', name: 'KeyGone', server: 'EUW', puuid: 'p5' }]);
  rankedByPuuid = { p5: { error: 'invalid_key' } };
  await runPass();
  check('an { error } response writes nothing', db.getRankSnapshots('v5').length, 0);

  // ── Unranked accounts produce no point ─────────────────────────────────────
  writeAccounts([{ id: 6, syncId: 'v6', name: 'Unranked', server: 'EUW', puuid: 'p6' }]);
  rankedByPuuid = { p6: [] };
  await runPass();
  check('an unranked account has no series', db.getRankSnapshots('v6').length, 0);

  // ── Teardown ───────────────────────────────────────────────────────────────
  riotApi.getApiKey = realGetApiKey;
  riotApi.getRankedByPuuid = realGetRanked;

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  try {
    db.getDb().close();
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows can hold the WAL open a moment longer; the temp dir is disposable.
  }
  process.exit(failures === 0 ? 0 : 1);
})();
