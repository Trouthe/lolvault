'use strict';

/**
 * Ladder harvest — Electron main-process only.
 * Never import this file from Angular renderer code.
 *
 * This exists to make *other people's ranks* affordable.
 *
 * The obvious way to show the rank of the nine other players in a match is
 * `league-v4/entries/by-puuid`, once per player. That is 9 requests per match
 * card against a development key's ~0.83 req/s sustained budget — roughly 11
 * seconds of budget to fill in one row of a match history. A page of match
 * history costs more than a minute of pure waiting, every time, forever.
 *
 * The ladder endpoint inverts that:
 *
 *   GET /lol/league/v4/entries/{queue}/{tier}/{division}?page=N   → 205 per page
 *
 * **205 players per request instead of one.** Each entry carries `puuid`, `tier`,
 * `rank`, `leaguePoints`, `wins`, `losses` and `inactive` — everything a rank
 * badge needs, with no follow-up call. See docs/lp-history-how-dpm-lol-does-it.md
 * §3; the measurements there are what this file is built on.
 *
 * So we harvest divisions in bulk into a local cache and read ranks out of it.
 * Matchmaking only ever pairs you with players near your own rank, so harvesting
 * the divisions around yours covers almost everyone you will ever be shown —
 * and it covers *future* matches too, which per-player lookups never do.
 *
 * Two things fall out of the same data for free:
 *   · your own entry is in there, so your rank needs no separate request;
 *   · so are `wins`/`losses`, which is what the daily rank series records.
 */

const db = require('./database');
const limiter = require('./rate-limiter');

/** Divisioned tiers, low → high. Apex tiers are handled by their own endpoints. */
const LADDER_TIERS = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND'];

/** Divisions low → high, matching Riot's `rank` field. */
const LADDER_DIVISIONS = ['IV', 'III', 'II', 'I'];

/**
 * Master, Grandmaster and Challenger, low → high.
 *
 * No divisions, and their `/entries/…` pages are capped, so they come from the
 * dedicated league endpoints instead — each returns the entire league in a
 * single request. The whole apex population costs 3 requests.
 */
const APEX_TIERS = [
  { tier: 'MASTER', path: 'masterleagues' },
  { tier: 'GRANDMASTER', path: 'grandmasterleagues' },
  { tier: 'CHALLENGER', path: 'challengerleagues' },
];

/** Measured at 205 on every full page; page 1 is trusted over the constant. */
const DEFAULT_PAGE_SIZE = 205;

/** A census older than this is re-measured. Division sizes drift over weeks. */
const CENSUS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function isApexTier(tier) {
  return APEX_TIERS.some((t) => t.tier === String(tier || '').toUpperCase());
}

/** Every bucket on the ladder, low → high. */
function allBuckets() {
  const buckets = [];
  for (const tier of LADDER_TIERS) {
    for (const division of LADDER_DIVISIONS) buckets.push({ tier, division, apex: false });
  }
  for (const { tier, path } of APEX_TIERS) buckets.push({ tier, division: 'I', path, apex: true });
  return buckets;
}

function bucketIndex(tier, division) {
  const upper = String(tier || '').toUpperCase();
  return allBuckets().findIndex(
    (b) => b.tier === upper && (b.apex || b.division === String(division || '').toUpperCase())
  );
}

/**
 * The buckets worth harvesting for an account at a given rank.
 *
 * Riot matches you against players near your own rank, so the divisions either
 * side of yours contain nearly everyone you will be shown. `spread` is how many
 * divisions to reach in each direction; 0 harvests your division alone.
 *
 * This is the entire cost control. Harvesting the whole ladder is ~7,300
 * requests on a large region — hours on a development key. Three divisions is
 * a few hundred, and covers the same match cards.
 */
function bucketsAround(tier, division, spread = 1) {
  const index = bucketIndex(tier, division);
  if (index < 0) return [];

  const buckets = allBuckets();
  const from = Math.max(0, index - spread);
  const to = Math.min(buckets.length - 1, index + spread);
  return buckets.slice(from, to + 1);
}

// ── Requests ──────────────────────────────────────────────────────────────────

function fetchPage(ctx, tier, division, page) {
  const url =
    `https://${ctx.platform}.api.riotgames.com/lol/league/v4/entries/` +
    `${ctx.queue}/${tier}/${division}?page=${page}`;
  return ctx.request(url);
}

function fetchApexLeague(ctx, path) {
  return ctx.request(
    `https://${ctx.platform}.api.riotgames.com/lol/league/v4/${path}/by-queue/${ctx.queue}`
  );
}

function cancelledError() {
  return Object.assign(new Error('cancelled'), { cancelled: true });
}

// ── Bucket sizing ─────────────────────────────────────────────────────────────

/**
 * How many players and pages a division holds, by binary-searching for its last
 * page. A page past the end returns `[]`, which is what makes the search
 * possible at all.
 *
 * This is not needed to harvest — paging until a short page appears would do —
 * but knowing the page count up front is what lets the UI quote an honest ETA
 * before the user commits to minutes of waiting. `hint` is the previous
 * census's page count, which usually lands within a page or two and cuts the
 * search to a couple of requests.
 */
async function measureBucket(ctx, tier, division, hint) {
  // Memoised: the search re-visits its bounds, and the harvest re-reads pages
  // the search already paid for.
  const seen = new Map();
  const probe = async (page) => {
    if (seen.has(page)) return seen.get(page);
    const entries = await fetchPage(ctx, tier, division, page);
    const list = Array.isArray(entries) ? entries : [];
    seen.set(page, list);
    ctx.tick();
    return list;
  };

  const first = await probe(1);
  if (first.length === 0) return { players: 0, pages: 0, pageSize: DEFAULT_PAGE_SIZE, seen };

  const pageSize = first.length >= DEFAULT_PAGE_SIZE ? first.length : DEFAULT_PAGE_SIZE;
  if (first.length < pageSize) {
    return { players: first.length, pages: 1, pageSize, seen };
  }

  const short = (page, length) => ({
    players: (page - 1) * pageSize + length,
    pages: page,
    pageSize,
    seen,
  });

  let lo = 1; // known non-empty
  let hi = 0; // known empty; 0 means "not yet bracketed"

  if (hint && hint > 1) {
    const at = await probe(hint);
    if (at.length === 0) hi = hint;
    else if (at.length < pageSize) return short(hint, at.length);
    else lo = hint;
  }

  let step = Math.max(2, lo * 2);
  while (!hi) {
    if (ctx.cancelled()) throw cancelledError();
    const at = await probe(step);
    if (at.length === 0) hi = step;
    else if (at.length < pageSize) return short(step, at.length);
    else {
      lo = step;
      step *= 2;
    }
  }

  while (hi - lo > 1) {
    if (ctx.cancelled()) throw cancelledError();
    const mid = (lo + hi) >> 1;
    const at = await probe(mid);
    if (at.length === 0) hi = mid;
    else if (at.length < pageSize) return short(mid, at.length);
    else lo = mid;
  }

  const last = seen.get(lo) ?? (await probe(lo));
  return { players: (lo - 1) * pageSize + last.length, pages: lo, pageSize, seen };
}

// ── The harvest ───────────────────────────────────────────────────────────────

/**
 * Reads whole divisions and hands every entry to `onEntries` in page batches.
 *
 * @param {object}   opts
 * @param {string}   opts.platform
 * @param {string}   opts.queue
 * @param {object[]} opts.buckets       From `bucketsAround`.
 * @param {function} opts.request       `(url) => Promise<json>`
 * @param {function} opts.onEntries     `(entries) => void` — bulk-cache these.
 * @param {function} [opts.onProgress]
 * @param {function} [opts.shouldCancel]
 *
 * @returns {Promise<{ players, pages, requests, cancelled }>}
 */
async function harvestLadder({
  platform,
  queue,
  buckets,
  request,
  onEntries,
  onProgress = () => {},
  shouldCancel = () => false,
}) {
  let requests = 0;
  const ctx = {
    platform,
    queue,
    request,
    tick: () => {
      requests++;
    },
    cancelled: shouldCancel,
  };

  const hints = new Map(
    db
      .getLadderCensus(platform, queue, Infinity)
      .map((row) => [`${row.tier}/${row.division}`, row.pages])
  );

  // Phase 1: size everything first, so the progress bar has a denominator and
  // the ETA is a measurement rather than a guess. It costs ~10 requests per
  // division against the hundreds the harvest itself will spend.
  const plan = [];
  let pagesTotal = 0;

  for (const bucket of buckets) {
    if (shouldCancel()) return { players: 0, pages: 0, requests, cancelled: true };

    if (bucket.apex) {
      plan.push({ ...bucket, pages: 1, seen: null });
      pagesTotal += 1;
      continue;
    }

    const key = `${bucket.tier}/${bucket.division}`;

    let measured;
    try {
      measured = await measureBucket(ctx, bucket.tier, bucket.division, hints.get(key));
    } catch (err) {
      // The binary search checks for cancellation between probes and signals it
      // by throwing, because it has no partial result to return. Cancelling is
      // not a failure, so it must not reach the caller as one.
      if (err?.cancelled) return { players: 0, pages: 0, requests, cancelled: true };
      throw err;
    }

    db.saveLadderCensus(platform, queue, bucket.tier, bucket.division, measured.players, measured.pages);
    plan.push({ ...bucket, pages: measured.pages, seen: measured.seen });
    pagesTotal += measured.pages;

    onProgress({
      phase: 'sizing',
      requests,
      pagesDone: 0,
      pagesTotal,
      playersCached: 0,
      etaSeconds: limiter.estimateSeconds(pagesTotal),
      bucket: key,
    });
  }

  // Phase 2: read them. Pages already fetched by the sizing pass are reused
  // rather than re-requested — on a small division that is the entire harvest.
  let pagesDone = 0;
  let players = 0;

  for (const bucket of plan) {
    const key = `${bucket.tier}/${bucket.division}`;

    if (bucket.apex) {
      if (shouldCancel()) return { players, pages: pagesDone, requests, cancelled: true };
      const league = await fetchApexLeague(ctx, bucket.path);
      ctx.tick();
      // Apex entries omit the tier: the league itself is the tier.
      const entries = (Array.isArray(league?.entries) ? league.entries : []).map((e) => ({
        ...e,
        tier: bucket.tier,
        rank: 'I',
      }));
      onEntries(entries);
      players += entries.length;
      pagesDone++;
      onProgress({
        phase: 'harvesting',
        requests,
        pagesDone,
        pagesTotal,
        playersCached: players,
        etaSeconds: limiter.estimateSeconds(pagesTotal - pagesDone),
        bucket: key,
      });
      continue;
    }

    for (let page = 1; page <= bucket.pages; page++) {
      if (shouldCancel()) return { players, pages: pagesDone, requests, cancelled: true };

      let entries = bucket.seen?.get(page);
      if (!entries) {
        entries = await fetchPage(ctx, bucket.tier, bucket.division, page);
        if (!Array.isArray(entries)) entries = [];
        ctx.tick();
      }

      onEntries(entries);
      players += entries.length;
      pagesDone++;

      onProgress({
        phase: 'harvesting',
        requests,
        pagesDone,
        pagesTotal,
        playersCached: players,
        etaSeconds: limiter.estimateSeconds(pagesTotal - pagesDone),
        bucket: key,
      });
    }
  }

  return { players, pages: pagesDone, requests, cancelled: false };
}

/**
 * Pre-flight cost of a harvest, so the UI can quote a wait before starting one.
 *
 * Exact once the census is warm — the page counts *are* the request counts.
 * Cold, the per-division figure is a placeholder wide enough not to flatter.
 */
function estimateHarvest(platform, queue, buckets) {
  const census = new Map(
    db
      .getLadderCensus(platform, queue, CENSUS_MAX_AGE_MS)
      .map((row) => [`${row.tier}/${row.division}`, row])
  );

  const UNKNOWN_DIVISION_PAGES = 250;
  let requests = 0;
  let known = 0;

  for (const bucket of buckets) {
    if (bucket.apex) {
      requests += 1;
      known++;
      continue;
    }
    const hit = census.get(`${bucket.tier}/${bucket.division}`);
    if (hit) {
      requests += hit.pages;
      known++;
    } else {
      requests += UNKNOWN_DIVISION_PAGES;
    }
  }

  return {
    requests,
    etaSeconds: limiter.estimateSeconds(requests),
    divisions: buckets.length,
    known,
    exact: known === buckets.length,
  };
}

module.exports = {
  harvestLadder,
  estimateHarvest,
  bucketsAround,
  allBuckets,
  bucketIndex,
  isApexTier,
  measureBucket,
  LADDER_TIERS,
  LADDER_DIVISIONS,
  APEX_TIERS,
  CENSUS_MAX_AGE_MS,
};
