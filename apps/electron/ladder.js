'use strict';

/**
 * Ladder sweep — Electron main-process only.
 * Never import this file from Angular renderer code.
 *
 * Riot exposes no "where am I on the ladder" endpoint. `league-v4/entries/by-puuid`
 * says "Emerald II, 39 LP" and stops there; nothing tells you that 39 LP in
 * Emerald II is 4,321st on the region. The only way to that number is to count
 * the players above you, and the only endpoint that lists players is the ladder
 * itself:
 *
 *   GET /lol/league/v4/entries/{queue}/{tier}/{division}?page=N   → 205 per page
 *
 * See docs/lp-history-how-dpm-lol-does-it.md §3 for the measurements this is
 * built on. Two facts shape everything below:
 *
 * 1. **Counting a bucket is cheap; reading one is not.** A page past the end of
 *    a division returns `[]`, so the size of any division can be found by
 *    binary-searching for its last page — ~10-20 requests instead of the ~250
 *    it would take to read it. Every division except your own only needs its
 *    *size*, so 27 of the 28 buckets are nearly free.
 * 2. **Your own division has to be read in full.** "How many players in Emerald
 *    II have more than 39 LP" cannot be answered by a count or a binary search,
 *    because the ladder endpoint does not order by LP. That scan is the whole
 *    cost of the sweep, and on a development key it is minutes.
 *
 * So this is an explicit, cancellable, user-triggered action with an honest ETA
 * — never a background heartbeat. The census is cached (`ladder_census`) because
 * a region's tier distribution moves in weeks, not minutes, which makes a repeat
 * sweep cost roughly one division scan instead of the whole ladder.
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
 * These have no divisions and their `/entries/…` pages are capped, so they are
 * read through the dedicated league endpoints instead — each returns the entire
 * league in a single request, which makes the apex third of the ladder cost 3
 * requests total rather than thousands.
 */
const APEX_TIERS = [
  { tier: 'MASTER', path: 'masterleagues' },
  { tier: 'GRANDMASTER', path: 'grandmasterleagues' },
  { tier: 'CHALLENGER', path: 'challengerleagues' },
];

/** Measured at 205 on every full page; page 1 is trusted over the constant. */
const DEFAULT_PAGE_SIZE = 205;

/** A census older than this is re-measured. Tier distributions drift slowly. */
const CENSUS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function isApexTier(tier) {
  return APEX_TIERS.some((t) => t.tier === String(tier || '').toUpperCase());
}

/**
 * Every bucket above a given rank, and every bucket at all, ordered low → high.
 *
 * Order is the ladder's own: Iron IV is index 0, Challenger is last. "Above me"
 * is then just "later in this list", which is the only comparison the position
 * arithmetic needs.
 */
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
  const list = allBuckets();
  return list.findIndex(
    (b) => b.tier === upper && (b.apex || b.division === String(division || '').toUpperCase())
  );
}

// ── Requests ──────────────────────────────────────────────────────────────────

/**
 * One ladder page. Kept as a thin wrapper so the sweep can count requests in one
 * place and so every call is paced by the shared limiter.
 *
 * Background priority deliberately: a sweep runs for minutes, and a user
 * expanding a match card while it runs must not queue behind hundreds of pages.
 */
function fetchPage(ctx, tier, division, page) {
  const url =
    `https://${ctx.platform}.api.riotgames.com/lol/league/v4/entries/` +
    `${ctx.queue}/${tier}/${division}?page=${page}`;
  return ctx.request(url);
}

function fetchApexLeague(ctx, path) {
  const url =
    `https://${ctx.platform}.api.riotgames.com/lol/league/v4/${path}/by-queue/${ctx.queue}`;
  return ctx.request(url);
}

// ── Bucket sizing ─────────────────────────────────────────────────────────────

/**
 * Number of players in one tier/division, by binary-searching for its last page.
 *
 * `hint` is the previous census's page count. Seeding the search with it is the
 * difference between ~20 requests and ~3 for a repeat sweep, because a division
 * that had 242 pages last week almost always still has 241-243 today.
 *
 * Returns `{ players, pages, pageSize, requests }`.
 */
async function measureBucket(ctx, tier, division, hint) {
  // Pages are memoised: the binary search re-visits its bounds, and the own-
  // bucket scan re-reads pages the search already paid for.
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

  // A short page is by definition the last one, so a small division costs a
  // single request.
  if (first.length < pageSize) {
    return { players: first.length, pages: 1, pageSize, seen };
  }

  let lo = 1; // known non-empty
  let hi = 0; // known empty; 0 means "not yet bracketed"

  if (hint && hint > 1) {
    const at = await probe(hint);
    if (at.length === 0) hi = hint;
    else if (at.length < pageSize) return { players: (hint - 1) * pageSize + at.length, pages: hint, pageSize, seen };
    else lo = hint;
  }

  // Double until an empty page brackets the end.
  let step = Math.max(2, lo * 2);
  while (!hi) {
    const at = await probe(step);
    if (at.length === 0) hi = step;
    else if (at.length < pageSize) {
      return { players: (step - 1) * pageSize + at.length, pages: step, pageSize, seen };
    } else {
      lo = step;
      step *= 2;
    }
    if (ctx.cancelled()) throw cancelledError();
  }

  while (hi - lo > 1) {
    if (ctx.cancelled()) throw cancelledError();
    const mid = (lo + hi) >> 1;
    const at = await probe(mid);
    if (at.length === 0) hi = mid;
    else if (at.length < pageSize) {
      return { players: (mid - 1) * pageSize + at.length, pages: mid, pageSize, seen };
    } else lo = mid;
  }

  const last = seen.get(lo) ?? (await probe(lo));
  return { players: (lo - 1) * pageSize + last.length, pages: lo, pageSize, seen };
}

function cancelledError() {
  return Object.assign(new Error('cancelled'), { cancelled: true });
}

// ── The sweep ─────────────────────────────────────────────────────────────────

/**
 * Where an account sits on its region's ranked ladder.
 *
 * @param {object}   self               `{ puuid, tier, division, leaguePoints }`
 * @param {object}   opts
 * @param {string}   opts.platform      e.g. `eun1`
 * @param {string}   opts.queue         e.g. `RANKED_SOLO_5x5`
 * @param {function} opts.request       `(url) => Promise<json>`
 * @param {function} [opts.onProgress]
 * @param {function} [opts.shouldCancel]
 * @param {boolean}  [opts.freshCensus] Ignore the cached census and re-measure.
 *
 * @returns {Promise<object>} `{ position, total, bucketPosition, bucketTotal,
 *                               percentile, tier, division, leaguePoints,
 *                               entry, requests, cancelled }`
 */
async function sweepLadderPosition(self, opts) {
  const {
    platform,
    queue,
    request,
    onProgress = () => {},
    shouldCancel = () => false,
    freshCensus = false,
  } = opts;

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

  const tier = String(self.tier || '').toUpperCase();
  const division = String(self.division || self.rank || 'I').toUpperCase();
  const leaguePoints = Number(self.leaguePoints ?? 0);

  const myIndex = bucketIndex(tier, division);
  if (myIndex < 0) {
    throw Object.assign(new Error(`Unrecognised rank: ${tier} ${division}`), { code: 'BAD_RANK' });
  }

  const buckets = allBuckets();

  // Rough up-front estimate so the UI can quote a wait before anything runs.
  // Refined the moment the census knows how many pages the own bucket has.
  const report = (extra) =>
    onProgress({
      phase: 'census',
      requests,
      plannedRequests: 0,
      etaSeconds: 0,
      bucketsDone: 0,
      bucketsTotal: buckets.length,
      pagesDone: 0,
      pagesTotal: 0,
      done: false,
      ...extra,
    });

  // ── Phase 1: census ────────────────────────────────────────────────────────
  //
  // Every bucket's size. All of them, not just the ones above: the percentile
  // needs the size of the whole ladder, and a bucket below costs the same ~10
  // requests as one above.
  const cached = freshCensus ? [] : db.getLadderCensus(platform, queue, CENSUS_MAX_AGE_MS);
  const cachedBy = new Map(cached.map((row) => [`${row.tier}/${row.division}`, row]));
  const stale = db.getLadderCensus(platform, queue, Infinity);
  const hintBy = new Map(stale.map((row) => [`${row.tier}/${row.division}`, row.pages]));

  const sizes = new Map();
  /** Pages already fetched for the account's own bucket, reused by phase 2. */
  let ownSeen = null;
  let ownPages = 0;
  let ownPageSize = DEFAULT_PAGE_SIZE;

  let bucketsDone = 0;
  const estimatePerBucket = 12;
  report({
    plannedRequests: buckets.length * estimatePerBucket,
    etaSeconds: limiter.estimateSeconds(buckets.length * estimatePerBucket),
  });

  for (const bucket of buckets) {
    if (shouldCancel()) return { cancelled: true, requests };

    const key = `${bucket.tier}/${bucket.division}`;

    if (bucket.apex) {
      // One request returns the whole league, so there is nothing to cache and
      // nothing to binary-search.
      const league = await fetchApexLeague(ctx, bucket.path);
      ctx.tick();
      const entries = Array.isArray(league?.entries) ? league.entries : [];
      sizes.set(key, entries.length);
      if (bucket.tier === tier) {
        ownSeen = new Map([[1, entries]]);
        ownPages = 1;
        ownPageSize = entries.length;
      }
    } else {
      const hit = cachedBy.get(key);
      const isOwn = bucket.tier === tier && bucket.division === division;

      // A cached size answers every bucket except the account's own — that one
      // has to be read page by page regardless, so measuring it is free.
      if (hit && !isOwn) {
        sizes.set(key, hit.players);
      } else {
        const measured = await measureBucket(ctx, bucket.tier, bucket.division, hintBy.get(key));
        sizes.set(key, measured.players);
        db.saveLadderCensus(platform, queue, bucket.tier, bucket.division, measured.players, measured.pages);
        if (isOwn) {
          ownSeen = measured.seen;
          ownPages = measured.pages;
          ownPageSize = measured.pageSize;
        }
      }
    }

    bucketsDone++;
    report({
      bucketsDone,
      plannedRequests: requests + (buckets.length - bucketsDone) * estimatePerBucket + ownPages,
      etaSeconds: limiter.estimateSeconds(
        (buckets.length - bucketsDone) * estimatePerBucket + Math.max(0, ownPages - 1)
      ),
    });
  }

  if (shouldCancel()) return { cancelled: true, requests };

  // ── Phase 2: read the account's own bucket ─────────────────────────────────
  //
  // The one thing a count cannot answer. The ladder endpoint does not order by
  // LP, so the only way to know how many players in this division are above the
  // account is to look at all of them.
  let above = 0;
  let bucketTotal = sizes.get(`${tier}/${division}`) ?? 0;
  let ownEntry = null;
  let ties = 0;

  const pagesTotal = Math.max(1, ownPages);
  let pagesDone = 0;

  const scanEntries = (entries) => {
    for (const entry of entries) {
      if (entry.puuid && entry.puuid === self.puuid) {
        ownEntry = entry;
        continue;
      }
      const lp = Number(entry.leaguePoints ?? 0);
      if (lp > leaguePoints) above++;
      else if (lp === leaguePoints) ties++;
    }
  };

  report({
    phase: 'scanning',
    pagesTotal,
    pagesDone: 0,
    etaSeconds: limiter.estimateSeconds(pagesTotal - (ownSeen?.size ?? 0)),
  });

  for (let page = 1; page <= pagesTotal; page++) {
    if (shouldCancel()) return { cancelled: true, requests };

    let entries = ownSeen?.get(page);
    if (!entries) {
      entries = isApexTier(tier)
        ? []
        : await fetchPage(ctx, tier, division, page);
      if (!Array.isArray(entries)) entries = [];
      ctx.tick();
    }

    scanEntries(entries);
    pagesDone++;
    report({
      phase: 'scanning',
      pagesTotal,
      pagesDone,
      etaSeconds: limiter.estimateSeconds(pagesTotal - pagesDone),
    });
  }

  // ── Position arithmetic ────────────────────────────────────────────────────
  //
  // Everyone in a higher bucket is above, plus everyone in this bucket with more
  // LP. Ties all take the best available place, which is the convention every
  // ladder uses and the only one that does not need a tie-break Riot never
  // exposes.
  let playersAbove = 0;
  for (let i = myIndex + 1; i < buckets.length; i++) {
    playersAbove += sizes.get(`${buckets[i].tier}/${buckets[i].division}`) ?? 0;
  }

  const total = [...sizes.values()].reduce((sum, n) => sum + n, 0);
  const position = playersAbove + above + 1;
  if (!bucketTotal) bucketTotal = above + ties + 1;

  return {
    cancelled: false,
    requests,
    platform,
    queue,
    tier,
    division,
    leaguePoints,
    position,
    total,
    bucketPosition: above + 1,
    bucketTotal,
    /** Share of the region's ranked population at or below this account. */
    percentile: total > 0 ? (position / total) * 100 : 0,
    ties,
    /** The account's own ladder entry, when the sweep found it — carries
     *  `wins`, `losses` and `inactive`, which the rank recorder wants anyway. */
    entry: ownEntry,
    censusReused: cachedBy.size,
  };
}

/**
 * Pre-flight cost of a sweep, for the confirmation the UI shows before starting.
 *
 * Only honest to within the census: with nothing cached the bucket-sizing cost
 * is a guess, and with a cached census the own-bucket page count is known and
 * the estimate is close to exact.
 */
function estimateSweep(platform, queue, tier, division) {
  const buckets = allBuckets();
  const cached = db.getLadderCensus(platform, queue, CENSUS_MAX_AGE_MS);
  const cachedBy = new Map(cached.map((row) => [`${row.tier}/${row.division}`, row]));

  const upperTier = String(tier || '').toUpperCase();
  const upperDivision = String(division || '').toUpperCase();
  const ownKey = `${upperTier}/${upperDivision}`;

  // Apex leagues are never cached — they are one request each and always
  // re-read — so only the divisioned buckets count towards census coverage.
  const censusTotal = buckets.filter((b) => !b.apex).length;

  let requests = 0;
  for (const bucket of buckets) {
    const key = `${bucket.tier}/${bucket.division}`;
    if (bucket.apex) requests += 1;
    else if (cachedBy.has(key) && key !== ownKey) requests += 0;
    else requests += 12;
  }

  const ownPages = cachedBy.get(ownKey)?.pages ?? 0;
  requests += ownPages;

  return {
    requests,
    etaSeconds: limiter.estimateSeconds(requests),
    censusCached: cachedBy.size,
    censusTotal,
    ownPages,
    // With every division measured the only unknown left is the own-bucket page
    // count, which the census also holds — so the quote is close to exact.
    exact: cachedBy.size >= censusTotal,
  };
}

module.exports = {
  sweepLadderPosition,
  estimateSweep,
  allBuckets,
  bucketIndex,
  isApexTier,
  LADDER_TIERS,
  LADDER_DIVISIONS,
  APEX_TIERS,
  CENSUS_MAX_AGE_MS,
};
