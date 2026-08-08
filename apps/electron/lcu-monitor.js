'use strict';

/**
 * LCU Monitor — Electron main-process only.
 * Never import this file from Angular renderer code.
 *
 * Polls for a running LeagueClient.exe, identifies which vault account is
 * active by PUUID, subscribes to gameflow phase changes, snapshots LP before
 * and after each game, and emits IPC events to the renderer window.
 */

const lc = require('league-connect');
const path = require('path');
const fs = require('fs');
const { computeAbsoluteLp, saveLpSnapshot } = require('./database');

// ── Injected dependencies (set by startLcuMonitor) ───────────────────────────
let _mainWindow = null;
let _getDataPath = null;
let _decryptAccount = null; // (rawAccount) => decryptedAccount

// ── Per-process state ─────────────────────────────────────────────────────────
let _stopped = false;
let _credentials = null;
let _ws = null;

// Per-session (reset each time the client connects)
let _activeVaultId = null;
let _activePuuid = null;
let _lpBefore = null; // { tier, division, lp, absoluteLP } | null
let _currentPhase = 'None';
let _displayName = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function emit(channel, data) {
  try {
    if (_mainWindow && !_mainWindow.isDestroyed()) {
      _mainWindow.webContents.send(channel, data || {});
    }
  } catch (e) {
    // Window might have been destroyed — ignore
  }
}

function log(...args) {
  console.log('[LCU]', ...args);
}

function warn(...args) {
  console.warn('[LCU]', ...args);
}

// ── Account loading ───────────────────────────────────────────────────────────

function loadAccounts() {
  try {
    const p = path.join(_getDataPath(), 'accounts.json');
    if (!fs.existsSync(p)) return [];
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(raw) ? raw.map(_decryptAccount) : [];
  } catch (e) {
    warn('loadAccounts error:', e.message);
    return [];
  }
}

/**
 * Persist a discovered PUUID back into the raw (encrypted) accounts file so
 * that future sessions can match by PUUID directly instead of by name.
 * The PUUID is not sensitive — it is stored plaintext alongside the encrypted
 * username/password fields.
 */
function persistPuuid(accountId, puuid) {
  try {
    const p = path.join(_getDataPath(), 'accounts.json');
    if (!fs.existsSync(p)) return;
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const idx = raw.findIndex((a) => String(a.id) === String(accountId));
    if (idx !== -1 && !raw[idx].puuid) {
      raw[idx].puuid = puuid;
      fs.writeFileSync(p, JSON.stringify(raw, null, 2), 'utf8');
      log('Persisted PUUID for account id', accountId);
    }
  } catch (e) {
    warn('persistPuuid error:', e.message);
  }
}

// ── LCU HTTP helper ───────────────────────────────────────────────────────────

async function lcuGet(url) {
  const res = await lc.createHttp1Request({ method: 'GET', url }, _credentials);
  // league-connect wraps the response — `.json()` parses the body
  return res.json();
}

// ── Summoner identification ───────────────────────────────────────────────────

async function identifySummoner() {
  const summoner = await lcuGet('/lol-summoner/v1/current-summoner');
  const { puuid, displayName, gameName, tagLine } = summoner;
  _activePuuid = puuid;
  _displayName = displayName || gameName || null;

  const accounts = loadAccounts();

  // 1. Fast path: PUUID stored from a previous session
  let match = accounts.find((a) => a.puuid === puuid);

  if (!match) {
    // 2. Full Riot-ID match: account.name is stored as "GameName#Tag"
    const riotId = `${gameName || displayName}#${tagLine || ''}`.toLowerCase();
    match = accounts.find((a) => (a.name || '').toLowerCase() === riotId);
  }

  if (!match) {
    // 3. Name-only fallback (no tagline stored in account name, or LCU missing tagLine)
    const lcuName = (gameName || displayName || '').toLowerCase();
    match = accounts.find((a) => (a.name || '').split('#')[0].toLowerCase() === lcuName);
  }

  if (match) {
    // vaultId = syncId when available, fall back to string id
    _activeVaultId = match.syncId || String(match.id);

    // Save PUUID for next time (fire-and-forget; errors are caught inside)
    if (!match.puuid) persistPuuid(match.id, puuid);

    log('Identified account:', match.name, '→ vaultId:', _activeVaultId);
    emit('lcu:account-identified', { vaultId: _activeVaultId, puuid, displayName });
  } else {
    _activeVaultId = null;
    log('Unrecognized account in client:', displayName);
    emit('lcu:account-unrecognized', { displayName });
  }
}

// ── LP snapshotting ───────────────────────────────────────────────────────────

/**
 * Fetches /lol-ranked/v1/current-ranked-stats, extracts RANKED_SOLO_5x5 data,
 * saves a row to SQLite, and returns { tier, division, lp, absoluteLP } or null
 * if the account is unranked or the endpoint is unavailable.
 */
async function snapshotLp(label) {
  try {
    const stats = await lcuGet('/lol-ranked/v1/current-ranked-stats');

    // The LCU can return data under either `queues[]` or `queueMap`
    let solo = null;
    if (stats.queueMap && stats.queueMap['RANKED_SOLO_5x5']) {
      solo = stats.queueMap['RANKED_SOLO_5x5'];
    } else if (Array.isArray(stats.queues)) {
      solo = stats.queues.find((q) => q.queueType === 'RANKED_SOLO_5x5') || null;
    }

    if (!solo || !solo.tier || solo.tier === 'UNRANKED' || solo.tier === 'NONE') {
      log(`LP snapshot (${label}): account is unranked, skipping`);
      return null;
    }

    const { tier, division, leaguePoints: lp } = solo;
    const absoluteLP = computeAbsoluteLp(tier, division, lp);

    if (_activeVaultId) {
      saveLpSnapshot(_activeVaultId, tier, division, lp);
    }

    log(`LP snapshot (${label}): ${tier} ${division} ${lp}LP → abs ${absoluteLP}`);
    return { tier, division, lp, absoluteLP };
  } catch (e) {
    warn(`snapshotLp (${label}) error:`, e.message);
    return null;
  }
}

// ── Win/loss detection ────────────────────────────────────────────────────────

/**
 * Attempts to determine win/loss from the end-of-game stats block.
 * Falls back to LP delta (positive = win) if the endpoint is unavailable.
 */
async function detectWin(lpDelta) {
  // Primary: end-of-game stats block (available right after EndOfGame phase)
  try {
    const eog = await lcuGet('/lol-end-of-game/v1/eog-stats-block');
    if (eog && eog.localPlayer) {
      const winStat = eog.localPlayer.stats?.WIN;
      if (winStat !== undefined) return Number(winStat) === 1;
    }
    // Some versions nest differently
    if (eog && Array.isArray(eog.teams)) {
      const myTeam = eog.teams.find((t) => (t.players || []).some((p) => p.puuid === _activePuuid));
      if (myTeam) return myTeam.isWinningTeam === true;
    }
  } catch {
    // Endpoint not available — fall through to LP proxy
  }

  // Fallback: positive LP delta = win
  if (lpDelta !== null) return lpDelta > 0;
  return null;
}

// ── Gameflow phase handler ────────────────────────────────────────────────────

async function handlePhase(phase) {
  _currentPhase = phase;
  log('Phase →', phase);
  emit('lcu:phase-change', { vaultId: _activeVaultId, phase });

  // ── ChampSelect: snapshot pre-game LP ──────────────────────────────────────
  if (phase === 'ChampSelect') {
    _lpBefore = await snapshotLp('pre-game');
    return;
  }

  // ── EndOfGame: snapshot post-game LP, compute delta, detect win ───────────
  if (phase === 'EndOfGame') {
    await sleep(4000); // Riot updates LP server-side with a short delay

    const lpAfter = await snapshotLp('post-game');

    if (!lpAfter || !_activeVaultId) return;

    const lpDelta = _lpBefore !== null ? lpAfter.absoluteLP - _lpBefore.absoluteLP : null;

    const win = await detectWin(lpDelta);

    emit('lcu:game-ended', {
      vaultId: _activeVaultId,
      win,
      lpDelta,
      newTier: lpAfter.tier,
      newDivision: lpAfter.division,
      newLP: lpAfter.lp,
      newAbsoluteLP: lpAfter.absoluteLP,
    });

    log(
      'Game ended — win:',
      win,
      '| lpDelta:',
      lpDelta,
      '| rank:',
      `${lpAfter.tier} ${lpAfter.division} ${lpAfter.lp}LP`
    );

    _lpBefore = null;
    return;
  }

  // ── None: client returned to idle (dodge, post-lobby, etc.) ───────────────
  if (phase === 'None') {
    _lpBefore = null;
  }
}

// ── WebSocket subscription ────────────────────────────────────────────────────

/**
 * Opens the LCU WebSocket, subscribes to gameflow phase events, and resolves
 * when the connection closes (client quit or crash).
 */
async function subscribeGameflow() {
  _ws = await lc.createWebSocketConnection({}, _credentials);

  // Check and handle the current phase immediately on connect
  // (the player might already be in-game when we attach)
  try {
    const phase = await lcuGet('/lol-gameflow/v1/gameflow-phase');
    if (phase && typeof phase === 'string' && phase !== 'None') {
      await handlePhase(phase).catch((e) => warn('initial phase handler error:', e.message));
    }
  } catch {
    // Not available yet — fine, we'll pick up changes via events
  }

  // Subscribe to all future phase changes
  _ws.subscribe('/lol-gameflow/v1/gameflow-phase', (data) => {
    if (typeof data === 'string') {
      handlePhase(data).catch((e) => warn('phase handler error:', e.message));
    }
  });

  // Resolve when the WebSocket closes
  return new Promise((resolve) => {
    _ws.on('close', resolve);
    _ws.on('error', (e) => {
      warn('WebSocket error:', e.message);
      resolve();
    });
  });
}

// ── Connect / disconnect cycle ────────────────────────────────────────────────

/**
 * Attempts one connect+monitor cycle.
 * Returns true if we successfully connected (even if briefly), false if the
 * client wasn't running at all.
 */
async function connectAndMonitor() {
  try {
    _credentials = await lc.authenticate({ awaitConnection: false });
  } catch {
    // Client not running — caller will retry after sleep
    return false;
  }

  log('League Client detected — connecting');

  // Identify which account is logged in
  try {
    await identifySummoner();
  } catch (e) {
    warn('identifySummoner error:', e.message);
    // Carry on — we can still track phases even if identification failed
  }

  // Subscribe to gameflow and block until the client closes
  try {
    await subscribeGameflow();
  } catch (e) {
    warn('subscribeGameflow error:', e.message);
  }

  log('League Client closed — resuming poll');
  return true;
}

function resetSession() {
  _credentials = null;
  if (_ws) {
    try {
      _ws.terminate();
    } catch {}
    _ws = null;
  }
  _activeVaultId = null;
  _activePuuid = null;
  _lpBefore = null;
  _currentPhase = 'None';
  _displayName = null;
  emit('lcu:disconnected', {});
}

// ── Main monitor loop ─────────────────────────────────────────────────────────

async function runLoop() {
  log('Monitor started — polling for League Client every 3 s');

  while (!_stopped) {
    let connected = false;
    try {
      connected = await connectAndMonitor();
    } catch (e) {
      warn('connectAndMonitor threw:', e.message);
    }

    resetSession();

    if (_stopped) break;

    // If the client wasn't found, wait 3 s before retrying.
    // If it was found (we just got disconnected), retry immediately so we
    // reconnect quickly when the user relaunches.
    if (!connected) await sleep(3000);
  }

  log('Monitor stopped');
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * @param {Electron.BrowserWindow} mainWindow
 * @param {() => string}           getDataPath    – same function used in main.js
 * @param {(raw: object) => object} decryptAccount – same function used in main.js
 */
function startLcuMonitor(mainWindow, getDataPath, decryptAccount) {
  _mainWindow = mainWindow;
  _getDataPath = getDataPath;
  _decryptAccount = decryptAccount;
  _stopped = false;

  runLoop().catch((e) => warn('Fatal loop error:', e.message));
}

function stopLcuMonitor() {
  _stopped = true;
  if (_ws) {
    try {
      _ws.terminate();
    } catch {}
  }
}

function getLcuState() {
  return {
    activeVaultId: _activeVaultId,
    puuid: _activePuuid,
    phase: _currentPhase,
    displayName: _displayName,
  };
}

module.exports = { startLcuMonitor, stopLcuMonitor, getLcuState };
