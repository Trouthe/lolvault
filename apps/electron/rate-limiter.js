'use strict';

/**
 * Global Riot API rate limiter — Electron main-process only.
 *
 * Why this exists: `twisted` is not proactively rate limited. It sets
 * `rateLimitRetryAttempts = 1` (see twisted/dist/base/base.const.js) and only
 * reacts *after* a 429 with a single retry. It will happily fire a burst of
 * requests, eat a 429, retry once, and then throw. Once we fetch timelines
 * (a second call per match) that behaviour breaks quickly.
 *
 * Riot rate limits are enforced per API key, not per endpoint, so a single
 * global serialized queue is the correct model — every Riot call in the app
 * must funnel through `enqueue()`.
 *
 * Development keys allow 20 req/s and 100 req/2 min. The 2-minute window is the
 * binding constraint (~0.83 req/s sustained), so the burst allowance rarely
 * matters for bulk work.
 */

const PER_SECOND_LIMIT = 20;
const PER_SECOND_WINDOW_MS = 1000;

/** Riot allows 100 per 2 min; we target slightly under to leave headroom for
 *  opportunistic calls made by the LCU monitor. */
const PER_TWO_MIN_LIMIT = 95;
const PER_TWO_MIN_WINDOW_MS = 120_000;

/** Interactive work (a user expanding a match card) jumps ahead of background
 *  work (bulk backfill). Higher number = served first. */
const PRIORITY = { BACKGROUND: 0, INTERACTIVE: 1 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Timestamps (ms) of dispatched requests, pruned as windows slide. */
let recent = [];

/** Pending tasks, drained by the single runner loop. */
const queue = [];
let running = false;

/** Set when a 429 tells us to back off; the whole queue stalls until then. */
let stalledUntil = 0;

function pruneOlderThan(cutoff) {
  recent = recent.filter((t) => t >= cutoff);
}

/**
 * Milliseconds to wait before another request may be dispatched without
 * exceeding either window. Returns 0 when a slot is free right now.
 */
function waitTimeMs(now = Date.now()) {
  if (now < stalledUntil) return stalledUntil - now;

  pruneOlderThan(now - PER_TWO_MIN_WINDOW_MS);

  const inLastSecond = recent.filter((t) => t > now - PER_SECOND_WINDOW_MS);
  if (inLastSecond.length >= PER_SECOND_LIMIT) {
    return inLastSecond[0] + PER_SECOND_WINDOW_MS - now;
  }

  if (recent.length >= PER_TWO_MIN_LIMIT) {
    return recent[0] + PER_TWO_MIN_WINDOW_MS - now;
  }

  return 0;
}

/**
 * Extracts a Retry-After duration (ms) from a Riot/twisted error, if present.
 * twisted surfaces limits on `err.rateLimits`; native fetch paths attach the
 * raw response headers instead. Falls back to a conservative default.
 */
function retryAfterMs(err) {
  const headerVal =
    err?.rateLimits?.RetryAfter ??
    err?.retryAfter ??
    err?.response?.headers?.['retry-after'] ??
    err?.headers?.['retry-after'];

  const seconds = Number(headerVal);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;

  return 2000; // Riot omitted the header — back off conservatively.
}

function isRateLimitError(err) {
  const status = err?.status ?? Number(err?.message);
  return status === 429;
}

async function runNext() {
  if (running) return;
  running = true;

  try {
    while (queue.length > 0) {
      // Highest priority first; FIFO within a priority (stable by seq).
      queue.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
      const task = queue.shift();

      let wait = waitTimeMs();
      while (wait > 0) {
        await sleep(wait);
        wait = waitTimeMs();
      }

      recent.push(Date.now());

      try {
        task.resolve(await task.fn());
      } catch (err) {
        if (isRateLimitError(err) && task.attempts < 2) {
          // Stall the entire queue — a 429 means the key is over budget, so
          // letting other tasks through would only deepen the violation.
          const backoff = retryAfterMs(err);
          stalledUntil = Date.now() + backoff;
          console.warn(
            `[RateLimiter] 429 received — stalling all requests for ${backoff}ms`
          );
          task.attempts += 1;
          queue.push(task); // Re-queue; priority ordering re-applies.
        } else {
          task.reject(err);
        }
      }
    }
  } finally {
    running = false;
  }
}

/**
 * Queues a Riot API call, dispatching it once rate-limit budget allows.
 *
 * @param {() => Promise<any>} fn        Thunk performing the request.
 * @param {object}  [opts]
 * @param {boolean} [opts.interactive]   True for user-initiated work, which is
 *                                       served ahead of background backfill.
 * @returns {Promise<any>} Resolves/rejects with the underlying call's result.
 */
function enqueue(fn, { interactive = false } = {}) {
  return new Promise((resolve, reject) => {
    queue.push({
      fn,
      resolve,
      reject,
      priority: interactive ? PRIORITY.INTERACTIVE : PRIORITY.BACKGROUND,
      seq: enqueue._seq++,
      attempts: 0,
    });
    runNext();
  });
}
enqueue._seq = 0;

/** Snapshot of limiter state, for progress reporting and debugging. */
function getStats() {
  const now = Date.now();
  pruneOlderThan(now - PER_TWO_MIN_WINDOW_MS);
  return {
    queued: queue.length,
    usedInWindow: recent.length,
    windowLimit: PER_TWO_MIN_LIMIT,
    stalledForMs: Math.max(0, stalledUntil - now),
  };
}

/**
 * Estimated seconds to complete `count` requests from an idle start — used to
 * show honest ETAs on bulk backfill rather than an open-ended spinner.
 */
function estimateSeconds(count) {
  if (count <= 0) return 0;
  const perWindow = PER_TWO_MIN_LIMIT;
  const fullWindows = Math.floor(count / perWindow);
  const remainder = count % perWindow;
  return Math.round(
    fullWindows * (PER_TWO_MIN_WINDOW_MS / 1000) +
      (remainder / perWindow) * (PER_TWO_MIN_WINDOW_MS / 1000)
  );
}

/** Test-only: clears all windows and pending state. */
function _reset() {
  recent = [];
  queue.length = 0;
  stalledUntil = 0;
}

module.exports = {
  enqueue,
  getStats,
  estimateSeconds,
  isRateLimitError,
  retryAfterMs,
  PER_TWO_MIN_LIMIT,
  _reset,
};
