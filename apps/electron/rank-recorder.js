'use strict';

/**
 * Periodic rank recorder — Electron main-process only.
 * Never import this file from Angular renderer code.
 *
 * Why this exists: every other recording path needs something to happen. The
 * LCU monitor needs the League client running; the account card needs the user
 * to press refresh. Play a weekend with LoL Vault closed and that weekend is
 * gone — and it is gone permanently, because Riot exposes no LP history at any
 * endpoint. A rank series can only ever contain what was written down at the
 * time.
 *
 * So this records on a heartbeat instead: once at launch, then every few hours
 * for as long as the app is open. It talks to the Riot API rather than the LCU,
 * so it works whether or not the client is running.
 *
 * The cost is trivial. One request per account per queue-bearing response,
 * four times a day — against a development key's ~0.83 req/s sustained budget,
 * a handful of accounts is a rounding error. Writes are idempotent because the
 * daily row is keyed by day and upserts, so recording more often than once a
 * day only makes the reading fresher.
 */

const fs = require('fs');
const path = require('path');

const db = require('./database');
const riotApi = require('./riot-api.service');

/** Queues worth keeping a rank history for. */
const TRACKED_QUEUES = new Set(['RANKED_SOLO_5x5', 'RANKED_FLEX_SR']);

/**
 * Six hours. Frequent enough that a session is recorded the same day it is
 * played, rare enough to be invisible against the rate limit. The day key makes
 * the exact interval unimportant — it changes freshness, never correctness.
 */
const INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Give the app room to finish starting before spending rate-limit budget. */
const STARTUP_DELAY_MS = 15_000;

let _timer = null;
let _startupTimer = null;
let _getDataPath = null;
let _running = false;

function log(...args) {
  console.log('[RankRecorder]', ...args);
}

function warn(...args) {
  console.warn('[RankRecorder]', ...args);
}

/**
 * Accounts as stored on disk.
 *
 * Read raw and unencrypted: this only needs `puuid`, `server` and the vault id,
 * none of which are encrypted fields. Not decrypting means the recorder never
 * holds credentials in memory.
 */
function loadAccounts() {
  try {
    const file = path.join(_getDataPath(), 'accounts.json');
    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    warn('could not read accounts:', e.message);
    return [];
  }
}

/** The id LP history is filed under, matching what the LCU monitor writes. */
const vaultIdOf = (account) => account.syncId || String(account.id);

/**
 * Records one account's current rank in every tracked queue.
 * @returns {number} rows written
 */
async function recordAccount(account) {
  const vaultId = vaultIdOf(account);
  if (!vaultId || !account.puuid) return 0;

  const platform = riotApi.serverToPlatform(account.server);
  const entries = await riotApi.getRankedByPuuid(account.puuid, platform);

  // getRankedByPuuid reports failure in-band rather than throwing.
  if (!Array.isArray(entries)) {
    if (entries && entries.error) throw Object.assign(new Error(entries.error), entries);
    return 0;
  }

  let written = 0;
  for (const entry of entries) {
    if (!TRACKED_QUEUES.has(entry.queueType)) continue;
    if (db.recordRankSnapshot(vaultId, entry.queueType, entry)) written++;
  }
  return written;
}

/**
 * One pass over every account that has a PUUID.
 *
 * Accounts without one are skipped rather than resolved: that would cost an
 * extra lookup per account, and the PUUID arrives on its own the first time the
 * LCU identifies the account or the user refreshes its card.
 */
async function recordAllAccounts(reason) {
  if (_running) {
    log('pass already in progress, skipping', reason);
    return;
  }
  _running = true;

  try {
    if (!riotApi.getApiKey()) {
      log(`no API key configured — skipping ${reason} pass`);
      return;
    }

    const accounts = loadAccounts().filter((a) => a.puuid);
    if (accounts.length === 0) {
      log(`no accounts with a known PUUID — skipping ${reason} pass`);
      return;
    }

    let written = 0;
    let failed = 0;

    for (const account of accounts) {
      try {
        written += await recordAccount(account);
      } catch (e) {
        // One bad account must not stop the rest. A revoked key or an offline
        // Riot API is a temporary condition; the next pass picks it up.
        failed++;
        warn(`${account.name || vaultIdOf(account)} failed:`, e.message);
      }
    }

    log(
      `${reason} pass: ${written} row(s) across ${accounts.length} account(s)` +
        (failed ? `, ${failed} failed` : '')
    );
  } finally {
    _running = false;
  }
}

/**
 * Starts the recorder: one pass shortly after launch, then every INTERVAL_MS.
 *
 * @param {() => string} getDataPath Same accessor main.js uses.
 */
function startRankRecorder(getDataPath) {
  _getDataPath = getDataPath;
  stopRankRecorder();

  _startupTimer = setTimeout(() => {
    recordAllAccounts('startup').catch((e) => warn('startup pass threw:', e.message));
  }, STARTUP_DELAY_MS);

  _timer = setInterval(() => {
    recordAllAccounts('heartbeat').catch((e) => warn('heartbeat pass threw:', e.message));
  }, INTERVAL_MS);

  log(`started — first pass in ${STARTUP_DELAY_MS / 1000}s, then every ${INTERVAL_MS / 3_600_000}h`);
}

function stopRankRecorder() {
  if (_startupTimer) clearTimeout(_startupTimer);
  if (_timer) clearInterval(_timer);
  _startupTimer = null;
  _timer = null;
}

module.exports = { startRankRecorder, stopRankRecorder, recordAllAccounts };
