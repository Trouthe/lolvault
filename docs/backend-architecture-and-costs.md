# LoL Vault — Backend, Storage & Cost Analysis

**Date:** 2026-08-10
**Status:** Advisory / decision document
**Scope:** Should LoL Vault have a backend? What should it be built on? Where do users live? What does every fetch actually cost, measured against our own database? What breaks when real people use it simultaneously?

---

## Contents

1. [TL;DR](#1-tldr)
2. [🚨 The urgent problem](#2--the-urgent-problem)
3. [How the big trackers actually do it](#3-how-the-big-trackers-actually-do-it)
4. [Complete fetch inventory — every Riot call LoL Vault makes](#4-complete-fetch-inventory--every-riot-call-lol-vault-makes)
5. [Measured cost per user (from our real database)](#5-measured-cost-per-user-from-our-real-database)
6. [Concurrency — what breaks with real people at the same time](#6-concurrency--what-breaks-with-real-people-at-the-same-time)
7. [Your proposals, graded](#7-your-proposals-graded)
8. [Recommended architecture](#8-recommended-architecture)
9. [Stack recommendation](#9-stack-recommendation)
10. [Where to store the users](#10-where-to-store-the-users)
11. [Riot rate limits — the real ceiling](#11-riot-rate-limits--the-real-ceiling)
12. [Storage projections](#12-storage-projections)
13. [Cost breakdown by scale](#13-cost-breakdown-by-scale)
14. [Migration path](#14-migration-path)
15. [Risks](#15-risks)
16. [Open decisions](#16-open-decisions)

---

## 1. TL;DR

| Question | Verdict |
| --- | --- |
| Should we build a backend? | **Yes — but not for speed.** Local SQLite already beats any network hop. It's for key security, rate-limit pooling, shared caching, and features impossible client-side. |
| What's the single most urgent thing? | The shared dev key in `environment.ts`. It caps you at **~55 concurrent users**, and one year-backfill freezes the entire userbase for 35 minutes. See §2 and §6. |
| How do op.gg / u.gg do it? | Ladder-crawl ingestion (not user-pull) on **partner-tier rate limits earned over a decade**. You cannot replicate this. Don't try — see §3. |
| What does a page load cost? | Now **1 call** for a warm profile and **0** on a reopen inside 10 minutes, down from 3. A cold external player is **≤13**, less every game you shared with them. The old "up to 114 with icon lookups" figure was wrong — the real ceiling was 5, now capped at 20 per session. §4.6, §4.8, §4.9. |
| What does one user cost? | Measured from our DB: a heavy player is **1,680 calls and 49 MB/year** locally; **5.5 MB/year** server-side after normalising and compressing. §5. |
| Where do users live? | Keep Firebase Auth — and note only *premium* users need accounts, so auth stays free at basically any scale. §10. |
| Infra cost? | **~$11/mo at 100 users, ~$370/mo at 100k.** Under half a cent per user per month everywhere. §13. |
| The actual constraint? | **Riot rate limits, not money.** Production key gets you to ~250–350k MAU. §11. |
| Best stack? | **Node + PostgreSQL + Cloudflare R2** on Hetzner (cheapest) or Neon+Workers (least ops). Firebase stays for auth + Paddle only. §9. |

> **Revision note.** §4.6 corrects a factual error in the first version of this document: the summoner-icon fan-out was described as up to 100 calls per cold profile. The real ceiling was 5. §4.4b adds a defect that was not an API cost at all but was responsible for the analytics screen appearing to reload constantly — the dev database sat inside the Angular-watched source tree. §4.8, §4.9 and §4.10 record what has since been implemented.

Two measured findings that change the plan on their own:

- **Timelines are 108 KB each** — 6.3× the size of a full match record (17 KB). Bulk-fetching them, which `backfillMatchData` currently does, doubles your Riot request count and multiplies storage by ~4.7×. Make them lazy. This is the highest-value single change in the document.
- **35% of `match_cache.raw_json` is a duplicated participant blob**, and the rest largely restates `match_detail`. Normalising server-side takes a heavy user from 49 MB/year to 5.5 MB/year — a **9× reduction**.

---

## 2. 🚨 The urgent problem

[apps/electron/src/environments/environment.ts:2](../apps/electron/src/environments/environment.ts#L2) contains:

```ts
riotApiKey: 'RGAPI-eab67407-e4c0-4516-a7e8-850957aedabe',
```

and [app.component.ts:25-28](../apps/electron/src/app/app.component.ts#L25-L28) pushes it into main-process settings on every launch.

Three problems, worst first:

**1. It's a shared key with a 100-request/2-minute budget — across your entire userbase.**
The limiter in [rate-limiter.js](../apps/electron/rate-limiter.js) is per-install, so every user believes they own 95 requests per two minutes. They all spend from the same bucket. §6 works this out precisely: **you can serve roughly 55 concurrent users, and exactly one year-backfill starves everyone for 35 minutes.**

**2. It's a development key. It expires every 24 hours.** Every user's app breaks daily until you ship a new build.

**3. It's extractable in ~30 seconds.** `npx asar extract app.asar out/`, grep for `RGAPI`. Riot attributes any abuse to you.

**Actions:** rotate today (it's in git history — assume compromised); delete `riotApiKey` from `environment.ts`; ship a bring-your-own-key settings screen using the existing `validateApiKey()`; apply for a production key now, because approval takes weeks and gates everything else.

---

## 3. How the big trackers actually do it

### 3.1 First, an honest caveat

**None of op.gg, u.gg, DeepLoL or Mobalytics publish their architecture.** No engineering blog, no conference talks, no public post-mortems. Anything you read claiming to describe "op.gg's stack" in detail is inference. What follows is built from what *is* verifiable — public statements, observable product behaviour, Riot's own published policies, and arithmetic — and I've marked which is which.

### 3.2 The scale they operate at

| Site | Scale | Source |
| --- | --- | --- |
| OP.GG | **30M monthly active users**; ~68.7M monthly visits | Company statement via [Dot Esports](https://dotesports.com/league-of-legends/news/opgg-overwolf-lol-25121); [Similarweb](https://www.similarweb.com/website/op.gg/) |
| U.GG | ~74M monthly visits | [Semrush](https://www.semrush.com/website/u.gg/competitors/) |
| Mobalytics | Top-20 in category, ~4.1M visits (Jun 2025) | [Similarweb](https://www.similarweb.com/website/mobalytics.gg/) |

### 3.3 The arithmetic that explains everything

Run op.gg's 30M MAU through the per-user model measured in §5 (60 games/month, 1 request each):

```
30,000,000 MAU × 60 games/month  = 1.8B requests/month
                                 = 685 requests/second, sustained
```

A standard production key is **~50 req/s**. op.gg needs **at least 14× that** just to keep up with its users' own games — before any ladder crawling, before any profile lookups, before champion statistics.

**Conclusion: they run on heavily elevated, negotiated rate limits.** Riot's developer portal confirms this tier exists — limits are raised for developers "in good standing" who have "demonstrated strong community benefit" and have "steadily outgrown the standard production limit" ([Riot Developer Portal](https://developer.riotgames.com/docs/portal)). op.gg has been earning that standing since 2012.

**This is the most important strategic fact in this document.** Their data advantage is not clever engineering you can copy in a weekend. It's a decade-old relationship with Riot that grants them a rate limit you will not have. Plan around it rather than against it.

### 3.4 The two ingestion models

This is the real architectural fork, and it's where their design differs from yours fundamentally.

**Model A — Ladder crawl (what they do).** Seed from the ranked leaderboards, walk each player's match list, fetch every match, then fan out to all 10 participants and repeat. U.GG states they "analyze every game available from Riot's API" to maximise sample size ([U.GG FAQ](https://u.gg/faq)). You end up with a near-complete picture of the ladder.

- ✅ Champion win rates, tier lists, item builds, rune pages, matchup data — all computable, and all of it is what actually pulls SEO traffic.
- ✅ Any player looked up is probably already in the database, so profile loads are instant and cost zero Riot calls.
- ❌ Request cost scales with *the game*, not with your users. Utterly impossible below partner-tier limits.

**Model B — User pull (what you do).** Fetch only what a user asks for.

- ✅ Cost scales with your userbase; viable on a standard production key.
- ❌ No meta statistics — you can't compute Ahri's win rate from your users' games alone.
- ❌ Cold profile lookups are slow and expensive (measured: 14+ calls, §4).

**You cannot switch to Model A.** At 50 req/s you could ingest ~130M matches/month; Riot serves well over a billion. You would capture under 10% of the ladder and burn your entire quota doing it, leaving nothing for actual users.

**What to do instead:** stay on Model B for player data, and get meta statistics from somewhere else. Options: use a free public aggregate source for tier lists (several exist and are refreshed per patch), or do a *tiny targeted crawl* — only your users' rank bands and only the champions they actually play, which is a few thousand requests per patch rather than hundreds of millions.

### 3.5 What they do that you can and should copy

**Desktop client reading the local League client.** OP.GG's Overwolf app, Porofessor, Blitz and Mobalytics all run a desktop companion that talks to the League Client Update API on localhost. The Live Client Data API on `localhost:2999` and the LCU serve real-time game state **without consuming any Riot API quota**, because it's your own machine talking to your own game client ([HextechDocs](https://hextechdocs.dev/getting-started-with-the-lcu-api/)).

You already have [lcu-monitor.js](../apps/electron/lcu-monitor.js) doing exactly this for LP snapshots — which is why your LP tracking costs **zero Riot requests**. That's genuinely good and worth extending.

> ⚠️ **Compliance line, and it's a real one.** Riot permits LCU use but explicitly forbids using the LCU **to circumvent Riot API rate limits**. Reading local state for overlays and using it to *avoid unnecessary polling* is fine. Scraping match data out of the client to sidestep quota is not. Your proposed design — LCU tells you the match ID, you then fetch that match through the official API — is on the correct side of the line, because it *reduces* calls rather than replacing them. Keep it there.

**Aggressive permanent caching.** Match data is immutable, so every one of these sites fetches a match exactly once, ever. Nobody re-fetches a finished game.

**Split OLTP from OLAP.** Profile pages hit a transactional store; tier lists and champion statistics come from a pre-computed analytical store refreshed on a schedule. U.GG's published role-detection algorithm — which they claim is 99.9% accurate — is a batch-pipeline artefact, not something computed per page view.

### 3.6 Why they're successful — and where the gap actually is

Ranked by how much it matters, and none of the top three are technical:

1. **SEO.** "ahri build", "yasuo counters", "[summoner name] op.gg" — they own these searches. That traffic is the business.
2. **Habit.** Typing `op.gg` after a bad game is muscle memory for millions.
3. **Rate-limit privilege.** §3.3.
4. **Meta data breadth.** A consequence of 1–3, not a cause.
5. Engineering. Real, but the *least* differentiating item on the list.

**None of that is winnable head-on, and you shouldn't try.** A web tracker competing on tier lists loses to op.gg on SEO before it writes a line of code.

What you have that they don't: **multi-account vault management, local-first history that survives without a server, session/account switching, and a desktop app that owns the whole pre-game flow.** op.gg's desktop app is a companion to their website. Yours is the product. Keep the ingestion model matched to that — user-pull is *correct* for a personal vault, and its weakness (no meta stats) is a feature you can buy or borrow rather than build.

---

## 4. Complete fetch inventory — every Riot call LoL Vault makes

Every path traced through the actual code. "Cost" = Riot API requests against the rate-limited key.

### 4.1 Identity & profile

| What | Code path | Riot calls | Cached? | Notes |
| --- | --- | --- | --- | --- |
| Riot ID → PUUID | `getSummonerByRiotId` → `riot.Account.getByRiotId` + `lol.Summoner.getByPUUID` | **2** | Only via `account.puuid` on the vault entry | Two calls, not one — Account-v1 then Summoner-v4 |
| PUUID → profile | `getSummonerByPuuid` | **1** | ❌ **Never cached** | Called on *every* external profile open |
| Summoner icon for a co-player | `SummonerIconService.request` | **1 per unknown PUUID** | localStorage, permanent | See §4.6 — this is the hidden cost |

### 4.2 Rank & mastery

| What | Code path | Riot calls | Cached? | Notes |
| --- | --- | --- | --- | --- |
| Ranked entries | `getRankedByPuuid` (League-v4 by-puuid) | **1** | ❌ **Never cached** | Fires on every single profile load |
| Champion mastery | `getTopMasteryChampions` | **1** | ❌ **Never cached** | Fires on every single profile load |
| **LP snapshots** | `lcu-monitor.js:169` → `saveLpSnapshot` | **0** ✅ | SQLite `lp_snapshots` | **Free.** Read from the local League client on the `EndOfGame` phase. This is the model to copy everywhere. |
| LP trend on account card | `acc-card.component.ts:409` `syncLpTrend` | **0** | Local read | Reads snapshots written by the LCU monitor |

### 4.3 Match history

| What | Code path | Riot calls | Cached? | Notes |
| --- | --- | --- | --- | --- |
| Match ID list | `listMatchIds` → `MatchV5.list` | **1 per 100 ids** | ❌ Never | Correctly unfiltered by queue |
| Match detail | `MatchV5.get` | **1 per match** | ✅ `match_cache` + `match_detail`, permanent | The main cost driver |
| Cached rows | `db.getMatchCache` | **0** ✅ | SQLite | Instant |
| Refetch of incomplete matches | `fetchAndCacheMatchHistory` filter `|| !db.hasMatchDetail(id)` | **1 per incomplete match** | — | ⚠️ On a pre-`match_detail` cache this silently re-fetches large swathes of history |
| Match timeline | `MatchV5.timeline` | **1 per match** | ✅ `match_timeline`, permanent | **108 KB each** — see §5.2 |
| Year backfill | `fetchYearHistory` | `ceil(N/100)` + 1 per missing match | ✅ | User-triggered with cancel + ETA ✅ |
| Bulk backfill | `backfillMatchData` | **2 per match** (detail + timeline) | ✅ | ⚠️ The timeline half is the problem — §4.7 |

### 4.4 Static game data

| What | Riot calls | Notes |
| --- | --- | --- |
| Champions, items, runes, spells | **0** ✅ | Bundled as JSON in `src/app/data/` — excellent decision, zero runtime cost |
| Objective / role / ability art | **0** ✅ | Bundled (commit `3ba01eb`) |
| DDragon version | 1 once, then 0 | Not key-limited (public CDN). ⚠️ But see §4.7 |

### 4.4b ⚠️ The dev database lived inside the watched source tree

Not an API cost, but it was the single most visible defect in the product and it invalidates any conclusion drawn from watching the app in development.

`getDataPath()` returned `apps/electron/src/app/data` in dev, and that is where `lolvault.db` was created. `ng serve` watches the whole source tree — and `angular.json` additionally declared `src/app/data` as an asset input, so the directory was watched twice over.

Every `persistMatch()` writes SQLite. So **every game cached during a year sweep triggered a dev-server rebuild and reloaded the renderer.** A 400-game sweep reloaded the page 400 times. The analytics screen was not "flickering" or "re-rendering" — it was being destroyed and reconstructed from scratch, once per fetched match, which also meant the route re-fired, `reset()` ran, and the sweep's own results were repeatedly thrown away on the renderer side.

Fixed by moving runtime state to `apps/electron/.dev-data` (gitignored, outside the watched tree), with a one-time non-destructive migration of `lolvault.db*`, `accounts.json`, `boards.json` and `riot-session-vault`.

Two things fell out of the same fix:

- **Builds no longer ship the developer's personal data.** `src/app/data/**/*` was listed in both the Angular asset glob and electron-builder's `files`/`extraResources`, so every installer carried the dev machine's 20 MB match database, `accounts.json`, and the Riot session vault. Now excluded in all three places.
- **The 20 MB database is no longer tracked in git**, where it was producing a large binary diff on essentially every commit.

### 4.5 Derived views — all free

| Screen | Riot calls | Source |
| --- | --- | --- |
| **Activity heatmap** | **0** ✅ | `heatmap.service.ts` is pure computation over `matches()`. No network at all. |
| **Champion stats table** | **0** ✅ | `match-aggregation.service.ts` over cached rows |
| **Played-with panel** | **0** for the data ✅ | Reads `raw_json._allParticipants` — but see §4.6 for icons |
| **Match score / performance tone** | **0** ✅ | Pure computation |
| **LP graph** | **0** ✅ | `lp_snapshots`, written by LCU |

**This is the strongest part of the current design.** Every analytics view is derived from cache. Nothing on a screen refresh costs a Riot call except the three unconditional lookups in §4.8.

### 4.6 Summoner icons — corrected

**An earlier revision of this document claimed this path could add ~100 calls to a cold profile load. That was wrong, and the error is worth stating plainly because it drove a recommendation that wasn't needed.**

The mistake was reading the fan-out from the *data* (10 matches × 10 participants = 100 distinct PUUIDs) rather than from the *caller*. Nothing ever asks for 100 icons. [analytics-shell.component.ts](../apps/electron/src/app/pages/analytics/analytics-shell.component.ts) slices `playedWith` to **5 rows**, and that panel is the only consumer of [summoner-icon.service.ts](../apps/electron/src/app/pages/analytics/services/summoner-icon.service.ts). The realistic worst case was five calls, not a hundred.

**Everything else about a co-player is already free.** Riot returns the full ten-player roster inside the match payload we were fetching anyway, and `summariseParticipant` stores puuid, Riot ID, tagline, champion, team, KDA, CS, damage, gold, items, position and vision inline on `raw_json._allParticipants`. Names, click-through to their profile, played-with aggregation and the champion columns all read from that — **zero additional requests**. `profileIcon` is stored inline too, so any match cached since that change needs no lookup at all.

So the endpoint is a patch for two narrow cases: rows cached before `profileIcon` was recorded, and players whose icon was genuinely 0 at game time.

**What changed anyway:**

- A hard session budget of 20 lookups in `summoner-icon.service.ts`, so the five-row cap is a guarantee rather than an accident of the caller.
- `getSummonerByPuuid` now shares the main-process cache with a 6-hour TTL (§4.9), so the same recurring teammates are not re-resolved as you move between profiles.

An unresolved icon falls back to the default portrait, which is not worth an interactive request against a shared budget.

### 4.9 Short-lived response cache (new)

`getRankedByPuuid`, `getTopMasteryChampions` and `getSummonerByPuuid` are memoised in the main process — 10 minutes for rank and mastery, 6 hours for summoner identity. This removes the "3 calls on every profile open regardless of whether anything changed" problem in §4.8: a profile reopened inside ten minutes now costs **0**.

### 4.10 Free cross-account hydration (new)

`hydrateFromLocal` in [riot-api.service.js](../apps/electron/riot-api.service.js) builds an account's `match_cache` row from an existing `match_detail` row plus any sibling `match_cache` row (which supplies the kickoff timestamp `match_detail` does not store). When a game is already on disk for anybody, a second account's view of it costs **zero Riot requests** instead of one.

This is the temporal-dedup win of §7 realised locally rather than server-side. It matters most for exactly the case the §5.1 measurements showed — multiple vault accounts that queue together — and for opening the profile of someone you just played with, where every one of their recent games that you shared is already held.

### 4.7 ⚠️ Three defects worth fixing

**Bulk timeline fetching.** `backfillMatchData` fetches a timeline for every cached match. Measured (§5.2), timelines are **108,715 bytes** — 6.3× a full match record — and cost a second request each. Making them lazy **halves total Riot request volume and cuts storage ~4.7×**. `getMatchTimeline` already handles the interactive path correctly; it's only the bulk loop that shouldn't call it.

**DDragon version never refreshes.** [riot-api.service.js:719-726](../apps/electron/riot-api.service.js#L719-L726) reads `ddragon_version` from SQLite and returns it if present — with no TTL. After the first successful fetch it never updates again, so item and champion art silently goes stale on every patch. Needs a timestamp and a ~6-hour TTL.

**`raw_json` largely duplicates `match_detail`.** Measured: 11,626 B per user per match, of which 4,112 B (35.4%) is `_allParticipants` — a summary of the same ten players already stored in `match_detail.participants_json`. Locally this is merely wasteful. Server-side, where ten of your users can share one match, it's a 10× write amplification. Normalise to a `match_participants` table.

### 4.8 Cost per user action — measured totals

| Action | Before | Now | Breakdown |
| --- | --- | --- | --- |
| **Open own profile, warm, no new games** | 3 | **1** | match-list 1; rank + mastery served from the 10-min cache |
| Reopen the same profile inside 10 min | 3 | **0** | everything cached |
| Open own profile, 2 new games | 5 | **3** | list 1 + 2 detail |
| Open own profile, first ever (30 games) | 35 | **35** | unchanged — a cold cache is a cold cache |
| **Open external player, cold (10 games)** | 14 | **≤13** | summoner 1 + ranked 1 + mastery 1 + list 1 + up to 10 detail, **minus every game you shared with them**, which hydrates free |
| …plus icon fan-out, worst case | ~~+100~~ | **+5** | see §4.6 — the +100 figure was wrong |
| Expand a match card (first time) | 2 | 2 | detail 1 + timeline 1 |
| Refresh an account card | 4 | 4 | identity 2 + ranked 1 + mastery 1 |
| **Heatmap year, heavy player, all queues** | ~1,697 | — | 17 list pages + 1,680 detail |
| **Heatmap year, ranked solo only** | — | **~400–700** | `queue=420` on the id listing; the rest are never listed, so never fetched |

**The old headline — 3 calls on every profile open whether or not anything changed — is fixed.** Rank and mastery are memoised for 10 minutes (§4.9), so a warm reopen costs nothing and a normal open costs one list call.

**The year sweep is where the real saving is.** Two compounding changes:

1. **`queue` is applied to the id listing, not to the results.** Riot filters server-side, so games in other modes cost nothing rather than one request each. On a mixed account this alone is routinely 3–5×.
2. **Anything already on disk is rebuilt free** (§4.10).

Combined with the ETA and the live row streaming, the sweep is both several times cheaper and no longer feels like a hang.

---

## 5. Measured cost per user (from our real database)

Everything below is measured from `apps/electron/src/app/data/lolvault.db`, not estimated.

### 5.1 What's in the database today

| Metric | Value |
| --- | --- |
| File size | **4.83 MB** |
| Schema version | `user_version = 5` |
| Unique matches | **154** |
| `match_cache` rows | 156 (across 3 accounts) |
| `match_detail` rows | 154 (100% coverage) |
| `match_timeline` rows | **1** (0.6% coverage) |
| `lp_snapshots` | 11 |
| Queues present | 420 only — this cache predates the unfiltered-queue fix |
| Time span | 203 days |

Per-account activity — note the enormous spread, which is why a single "games per month" figure is a blend, not a typical user:

| Account | Matches | Span | Rate |
| --- | --- | --- | --- |
| A (heavy) | 70 | 15.1 days | **4.6/day → ~140/month** |
| B (casual) | 65 | 200 days | **0.33/day → ~10/month** |
| C (looked-up profile) | 21 | 1.1 days | burst — a backfill, not organic play |

156 rows across 154 unique matches means **2 matches contained two of these accounts** — real cross-account dedup, visible even at n=3.

### 5.2 Measured storage per match

| Component | Raw | gzip -9 | brotli | Scope |
| --- | --- | --- | --- | --- |
| `match_detail` (participants + teams) | **17,201 B** | 3,653 B (4.7×) | **2,884 B (6.0×)** | Once per match — shareable |
| `match_cache.raw_json` | **11,626 B** | 4,467 B (2.6×) | **3,913 B (3.0×)** | Once per *user* per match |
| `match_cache` structured columns | ~400 B | — | — | Once per user per match |
| **`match_timeline`** | **108,715 B** | 19,784 B (5.5×) | **15,807 B (6.9×)** | Once per match |
| └ of which `events_json` | 87,290 B | | | 80% of the timeline |

**Timelines are 6.3× the size of a complete match record.** This single measurement justifies making them lazy more than any argument.

`raw_json` decomposition:

| | Bytes | Share |
| --- | --- | --- |
| With `_allParticipants` | 11,626 | 100% |
| Without | 7,514 | 64.6% |
| **`_allParticipants` overhead** | **4,112** | **35.4%** |

### 5.3 What this database cost in API calls

| Call type | Count |
| --- | --- |
| `MatchV5.get` (match detail) | 154 |
| `MatchV5.timeline` | 1 |
| `MatchV5.list` | ~4 |
| Account-v1 + Summoner-v4 (3 accounts) | ~6 |
| League-v4 ranked (per profile load) | ~11 |
| Champion mastery | ~11 |
| **Total** | **≈ 187 calls → 4.83 MB** |

On the current dev key (0.79 req/s sustained) that's **~3.9 minutes of the global budget** — for 154 matches belonging to three accounts.

### 5.4 Projected per-user cost

Using the measured heavy (140/mo) and casual (10/mo) rates, plus a 60/mo blend:

**Year-one Riot requests** (backfill + ongoing, lazy timelines):

| User type | Backfill | Ongoing/yr | **Total yr 1** | Time on dev key | Time on prod key |
| --- | --- | --- | --- | --- | --- |
| Heavy (140/mo) | 1,697 | 1,680 | **3,377** | 71 min | 68 s |
| Blended (60/mo) | 727 | 720 | **1,447** | 30 min | 29 s |
| Casual (10/mo) | 121 | 120 | **241** | 5 min | 5 s |

With bulk timelines on, every number doubles.

**Year-one storage, current local schema, uncompressed:**

| User type | Matches/yr | Without timelines | With timelines |
| --- | --- | --- | --- |
| Heavy | 1,680 | **49.1 MB** | **231.7 MB** |
| Blended | 720 | 21.0 MB | 99.3 MB |
| Casual | 120 | 3.5 MB | 16.6 MB |

*(per match: 17,201 detail + 11,626 raw_json + 400 columns = 29,227 B; +108,715 with timeline)*

**Year-one storage, server-side, normalised + brotli + 5% timelines:**

| Component | Bytes per match-user pair |
| --- | --- |
| Shared match blob (brotli) | 2,884 ÷ users-in-match ≈ **2,884** |
| Per-user row, structured only (no `raw_json`) | **400** |
| Timeline amortised at 5% | 15,807 × 0.05 = **790** |
| **Total** | **≈ 4,074 B** |

| User type | Local (current) | Server (normalised) | Reduction |
| --- | --- | --- | --- |
| Heavy | 49.1 MB/yr | **6.8 MB/yr** | **7.2×** |
| Blended | 21.0 MB/yr | 2.9 MB/yr | 7.2× |
| Casual | 3.5 MB/yr | 0.5 MB/yr | 7.2× |

Dropping `raw_json` entirely (it's ~90% recoverable from `match_detail`) is where most of that comes from; brotli supplies the rest.

---

## 6. Concurrency — what breaks with real people at the same time

This is the section that determines whether you can launch.

### 6.1 The model

From §4.8, an active user in a normal session generates:

- ~3 profile opens per 10-minute session × 3 calls = **0.9 Riot calls/minute/user** (warm cache)
- A cold external-player lookup: **14 calls**, one-off
- A backfill: **1,697 calls**, one-off

Peak concurrency for a desktop gaming tool runs at roughly **8% of DAU**, and DAU ≈ 30% of MAU.

### 6.2 On the current shared dev key — 100 req / 2 min = 0.83 req/s

| Metric | Value |
| --- | --- |
| Global budget | **50 calls/minute, total, for every user on earth** |
| Warm profile opens supported | 50 ÷ 3 = **16.7 per minute, globally** |
| Concurrent users (warm, no backfills) | 50 ÷ 0.9 = **~55 users** |
| Cold external lookups supported | **3.5 per minute, globally** |
| One heavy backfill | **1,697 calls = 34 minutes at 100% of the key** |

**During a single year-backfill, every other user in the world gets 429s for 34 minutes.** They have no idea why; the app just fails. You cannot ship a public build on this key.

### 6.3 On a production key — ~50 req/s = 3,000/min

| Metric | Value |
| --- | --- |
| Warm profile opens/minute | **1,000** |
| Concurrent users (warm) | 3,000 ÷ 0.9 = **~3,300** |
| Backfills runnable in parallel at 20% budget | ~600 calls/min ÷ 1,697 = **one every 3 minutes** |
| Corresponding DAU (at 8% peak concurrency) | ~41,000 |
| **Corresponding MAU** | **~140,000** |

### 6.4 With a shared backend cache

The backend changes the arithmetic in three ways:

1. **Staleness gate** — a profile opened twice in 10 minutes costs 0 instead of 3. Removes ~70% of warm-path calls.
2. **Shared match cache** — any match already fetched for anyone is free. Matters most for repeat lookups of the same popular players.
3. **Backfill queue at background priority** — backfills consume only leftover budget and can never starve interactive traffic. Your [rate-limiter.js](../apps/electron/rate-limiter.js) already implements exactly this priority model; it just needs to be global instead of per-install.

| Configuration | Concurrent users | Approx. MAU |
| --- | --- | --- |
| Shared dev key (today) | **~55** | ~2,000 |
| Production key, no backend | ~3,300 | ~140,000 |
| Production key + backend cache + staleness gate | **~11,000** | **~460,000** |

### 6.5 What actually breaks first, in order

1. **~55 concurrent users** — dev key saturates. 429s everywhere. *Today's state.*
2. **~3,300 concurrent** (prod key, no backend) — interactive requests queue behind backfills; the ETA display starts reading in hours.
3. **~11,000 concurrent** (prod key + backend) — Riot ceiling reached in earnest; you need negotiated limits or graceful degradation (queue backfills overnight, cap free-tier depth, prioritise paying users).
4. **Postgres write throughput** — not until ~50M+ rows/month, and partitioning solves it.
5. **Money** — never. §13.

---

## 7. Your proposals, graded

### ✅ "Is it better to have a backend?" — Yes, with a correction

Right instinct, wrong stated reason. Reading 50 matches from local SQLite is **single-digit milliseconds**. Loading feels slow because of the Riot fetch on the critical path — §4.8 shows it's 3 calls minimum on *every* profile open — not because SQLite is slow. A backend makes raw page-load latency slightly *worse*.

The real reasons: rate-limit pooling (critical, §6), key security (critical, §2), fetch-once-serve-many, cross-device history, and the comparison features that need other people's data.

**Design consequence:** don't build a thin client. Keep SQLite as the local read path. The backend is an **ingest and sharing layer**.

### ✅ "Store match histories so we don't refetch" — Yes

Match data is immutable; this is the ideal caching workload. Three effects, very different sizes:

- **Temporal dedup (fetch once, ever)** — ~100% saving on repeat visits. All the value is here.
- **Cross-user dedup** — with ~130M monthly LoL players, the chance a given match holds a second one of your users is `1-(1-N/130M)^9`: 0.007% at 1k MAU, 0.7% at 100k, 6.7% at 1M. Don't budget for it. (Our own 3-account DB showed 2 shared matches in 154 — clustering is real when users know each other, but it doesn't generalise.)
- **Profile-lookup dedup — the big one nobody plans for.** Users look up streamers, pros, and whoever just stomped them. Centrally, the 10,000th lookup of a popular player costs **0** Riot calls instead of 14 (+100 icons). This alone justifies the shared store.

### ✅ "Refresh button so we don't refetch on every visit" — Yes, and go further

Measured cost of the current behaviour: **3 calls per profile open, unconditionally**, ~270/user/month — 4.5× what the user's actual games cost.

1. **Staleness gate first** (~10 lines): skip if `last_synced_at < 10 min`. Kills ~70% of warm-path traffic for almost no work.
2. **Manual refresh button** — `refreshing` signal plumbing already exists.
3. **Cache ranked + mastery** with a 10-minute TTL. They're currently *never* cached and fire on every load.
4. **Keep backfill opt-in** — `fetchYearHistory` with cancel and ETA is already correct.

### ✅ "Push the single game via LCU on game end" — Yes, strongest idea in the list

You already have [lcu-monitor.js](../apps/electron/lcu-monitor.js) handling the `EndOfGame` phase for LP. Extend it to emit the match ID.

- **Cost: exactly 1 Riot call per game.** No list call, no polling, no discovery.
- Data lands before the user alt-tabs.
- With a backend, the client posts the ID as a hint; the server fetches once and it's cached for everyone.
- Stays on the right side of Riot's LCU policy (§3.5) because it *reduces* API calls rather than replacing them.

| Approach | Calls/user/month (60 games) |
| --- | --- |
| Current (3 opens/day, unconditional) | **~330** |
| Staleness-gated | ~120 |
| **+ LCU push** | **~60** (floor) |

### ⚠️ What you didn't mention — see §4.7

Bulk timeline fetching (halves request volume to fix), `raw_json` denormalisation (7.2× storage), the DDragon TTL bug, and the uncapped icon fan-out.

---

## 8. Recommended architecture

```
┌────────────────────────────────────────────────────────────┐
│ ELECTRON CLIENT                                            │
│  Angular renderer                                          │
│      ↕ IPC                                                 │
│  Main process                                              │
│    ├── SQLite (local cache — the READ path, unchanged)     │
│    ├── LCU monitor → LP snapshots (free) + match-id hints  │
│    └── Sync client → talks ONLY to your backend            │
│         (no Riot key on the client, ever)                  │
└────────────────────────────┬───────────────────────────────┘
                             │ HTTPS
┌────────────────────────────▼───────────────────────────────┐
│ BACKEND                                                    │
│  API (Node/Fastify)                                        │
│    GET  /players/:puuid/matches?since=…   → delta only     │
│    GET  /matches/:id/timeline             → lazy           │
│    POST /ingest/match-hint                → LCU push       │
│    POST /players/:puuid/backfill          → queued job     │
│                                                            │
│  Riot Gateway  ← the ONLY holder of the production key     │
│    ├── global token bucket (Redis)                         │
│    ├── priority: interactive > LCU hint > backfill         │
│    └── per-region routing                                  │
│                                                            │
│  PostgreSQL          Redis           Cloudflare R2         │
│  matches             token bucket    timelines (brotli)    │
│  match_participants  hot responses   cold matches >2yr     │
│  players             job queue       (zero egress)         │
│  user_matches                                              │
└────────────────────────────────────────────────────────────┘

Firebase stays where it is: auth + Paddle entitlements.
```

**The client never blocks on the backend.** Page renders from local SQLite immediately. Sync happens in the background. Backend down ⇒ app still works, just no new data.

### Reuse from what exists

| File | Server-side fate |
| --- | --- |
| [rate-limiter.js](../apps/electron/rate-limiter.js) | Move as-is; swap the in-memory `recent[]` for a Redis sorted set. ~40 lines. The priority queue is already right. |
| [riot-api.service.js](../apps/electron/riot-api.service.js) | Near-verbatim. Swap `db.*` for Postgres; region routing, error handling and `persistMatch` shaping all survive. |
| [timeline-compact.js](../apps/electron/timeline-compact.js) | Verbatim. |
| [database.js](../apps/electron/database.js) | Schema translates 1:1; the `user_version` migration ladder maps to any migration tool. Stays on the client too. |

---

## 9. Stack recommendation

### 9.1 Runtime — Node + TypeScript + Fastify

Not because Go would be slower, but because **the entire Riot layer is already written in Node**. You're I/O-bound waiting on Riot at ~50 req/s; runtime speed is irrelevant. A rewrite buys nothing and costs weeks.

### 9.2 Database — PostgreSQL

Your product is analytics. Analytics means aggregates:

```sql
SELECT champion_id,
       AVG(win::int) AS wr,
       PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY cs_per_min) AS median_cspm
FROM match_participants
WHERE champion_id = 103 AND played_at > now() - interval '90 days'
GROUP BY champion_id;
```

One indexed query in Postgres. **Structurally impossible in Firestore** — no `GROUP BY`, no `JOIN`, no percentiles, and billing per document scanned.

- Partition `match_participants` by month on `played_at`.
- Index `(puuid, played_at DESC)` for match lists; `(champion_id, played_at)` for meta.
- Real columns for anything filtered or aggregated; JSONB for the rest.
- **Timelines never go in Postgres** — 108 KB blobs read rarely is R2's job.

### 9.3 Object storage — Cloudflare R2

$0.015/GB-month and **zero egress fees** ([R2 pricing](https://developers.cloudflare.com/r2/pricing)). Timelines are your bulk bytes and they get downloaded. On S3/GCS you'd pay $0.09–0.12/GB to send them.

⚠️ R2 charges **$4.50 per million Class A (write) operations**. One PUT per match at 12M matches/month = $54/mo. **Batch them** — group by day, or only write to R2 on eviction from Postgres. Batched, it's a few dollars.

### 9.4 Cache & coordination — Redis

The rate limiter must be globally coordinated — that's the entire point. Redis sorted set as a sliding-window bucket, plus hot responses and the backfill job queue.

### 9.5 Aggregates — Postgres matviews → ClickHouse

Below ~10k MAU, hourly materialized views cover everything. Past ~50M participant rows, move meta aggregates to ClickHouse. Don't start there.

### 9.6 Hosting

| Option | Best for | Trade-off |
| --- | --- | --- |
| **Hetzner Cloud** ✅ | Cheapest; full control | You own patching, backups, failover. Prices rose substantially in [June 2026](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/) — still cheapest, less dramatically so. |
| **Neon + Cloudflare Workers** | Zero ops, scale-to-zero | ~2× at scale. Workers are stateless, so the limiter needs a **Durable Object** — actually an elegant fit for a global token bucket. |
| **Fly.io / Railway** | Middle ground, real long-running processes | Billing drifts upward. |
| **Supabase** | Postgres + auth + storage at $25/mo Pro | Overlaps your existing Firebase auth. Still strong value under 10k MAU. |
| **Firebase for match data** | — | ❌ Wrong data model. §13.3. |

**Start on a single Hetzner box (~€10/mo) running everything.** Split as you grow. If you'd rather never touch a server, Neon + Workers + R2 at ~2× is defensible, and its free tier covers your first thousand users outright.

---

## 10. Where to store the users

### 10.1 First: how many users actually need an account?

Your [premium entitlement plan](premium-entitlement-plan.md) already says **no mandatory login for free users**. That decision is worth more than any provider choice:

| Scenario | Auth MAU at 100k app MAU |
| --- | --- |
| Everyone must sign in | 100,000 |
| **Only premium + cloud-sync users (5% conversion)** | **5,000** |

At 5k auth MAU you are inside the free tier of every provider on the market. **Keep login optional.** It's the single largest auth cost lever and you've already made the right call.

### 10.2 A user record is tiny

```
uid, email, created_at, entitlement (tier, expires_at, paddle_subscription_id),
linked_riot_accounts[] (puuid, platform, label), settings, boards
```

≈ **2 KB per user.** 100k users = 200 MB. Storage is a rounding error anywhere; **the decision is entirely about auth pricing.**

### 10.3 Auth provider comparison

| Provider | Free tier | Cost at 100k MAU | Notes |
| --- | --- | --- | --- |
| **Firebase Auth** ✅ current | 50k MAU | **~$275/mo** | Already integrated ([main.js:1130](../apps/electron/main.js#L1130) Google sign-in). $0.0055/MAU past 50k. |
| **Supabase Auth** | 50k MAU | **~$25/mo** | Cheapest managed. $0.00325/MAU past 50k. Bundled with Pro. |
| **Clerk** | 10k MAU | **~$1,800/mo** | Best DX, worst price at scale. $0.02/MAU. |
| **Auth0** | ~7.5k MAU | **~$2,400/mo** | Enterprise features you don't need. |
| **Self-hosted** (better-auth / Lucia / Ory) | ∞ | **$0 marginal** | Postgres table + sessions. You own password resets, OAuth, breaches. |

Sources: [Auth comparison 2026](https://agentdeals.dev/auth-comparison-2026), [Firebase Auth cost guide](https://www.metacto.com/blogs/the-complete-guide-to-firebase-auth-costs-setup-integration-and-maintenance), [Clerk vs Auth0 vs Supabase](https://www.devtoolreviews.com/reviews/clerk-vs-auth0-vs-supabase-auth-2026).

### 10.4 Recommendation

**Keep Firebase Auth.** It works, it's integrated, and with optional login you will not approach 50k auth MAU for a very long time. Revisit only if paid conversions exceed 50k — at which point $275/mo is a rounding error against that revenue.

**Do not adopt Clerk.** At 100k auth MAU it would cost **5× your entire infrastructure bill**. It's the most common way small products accidentally quadruple their burn.

**If you ever want everything in one place**, Supabase gives you Postgres + Auth + Storage on one bill at $25/mo — genuinely the best value under 10k MAU. But migrating working auth for $250/mo of hypothetical future savings is not a good trade today.

### 10.5 What lives where

| Data | Home | Why |
| --- | --- | --- |
| Identity, sessions | Firebase Auth | Already there |
| Entitlements, Paddle state | Firestore (existing) | Tiny, transactional, already built |
| Linked Riot accounts, settings, boards | Your Postgres | Joins to match data |
| Match data | Your Postgres + R2 | §9 |
| Local cache | SQLite on device | Offline + instant |

⚠️ **GDPR:** storing other players' PUUIDs and match data centrally makes you a data controller in a way a local-only app isn't. Riot match data is arguably public, but PUUIDs linked to your accounts are personal data. You need a retention policy and a deletion path before anyone asks.

---

## 11. Riot rate limits — the real ceiling

| Key type | Limit | Expiry |
| --- | --- | --- |
| Development | 20 req/s, **100 req/2 min** | 24 hours |
| Personal | 20 req/s, 100 req/2 min — **never eligible for increases** | Renewable |
| **Production** | Not published. Commonly ~500 req/10s and ~30,000 req/10 min (≈50 req/s). | Persistent |
| **Elevated / partner** | Negotiated. Where op.gg lives. | Earned over years |

Riot deliberately doesn't publish exact production limits and reserves per-key overrides — confirm yours in the approval correspondence and read your actual `X-App-Rate-Limit` header on day one. Increases require being "in good standing" with "demonstrated strong community benefit" and having "steadily outgrown the standard production limit" ([Riot Developer Portal](https://developer.riotgames.com/docs/portal)).

Against ~50 req/s sustained, with lazy timelines and the staleness gate:

| MAU | Steady req/mo | Backfill req/mo | Total | Avg req/s | % of key | Peak (≈3.5×) |
| --- | --- | --- | --- | --- | --- | --- |
| 100 | 6k | 6.1k | 12k | 0.005 | 0.01% | 0.03% |
| 1,000 | 60k | 61k | 121k | 0.05 | 0.09% | 0.3% |
| 10,000 | 600k | 606k | 1.2M | 0.46 | 0.9% | 3% |
| 100,000 | 6M | 6.1M | 12.1M | 4.6 | **9%** | **32%** |
| 1,000,000 | 60M | 60.6M | 121M | 46 | **92%** | **over ceiling** |

- Production key carries you to **~250k–350k MAU**. Peak traffic runs 3–4× average, and that's what binds. §6.4's independent concurrency model gives ~460k — same order of magnitude.
- **1M MAU is the wall.**
- **Without lazy timelines and the staleness gate, every number roughly triples** — the wall arrives at ~100k instead of ~350k.
- On today's dev key the ceiling is **~55 concurrent users** (§6.2).

---

## 12. Storage projections

Using measured sizes (§5.2): 1,120 matches/user/year (400 backfill + 720 ongoing), brotli, normalised, 5% timeline rate → **4,074 B per match-user pair**.

| MAU | Matches/yr | Shared blobs | Timelines @5% | Postgres rows | **Total/yr** |
| --- | --- | --- | --- | --- | --- |
| 100 | 112k | 0.32 GB | 0.09 GB | 0.04 GB | **~0.46 GB** |
| 1,000 | 1.1M | 3.2 GB | 0.9 GB | 0.4 GB | **~4.6 GB** |
| 10,000 | 11.2M | 32 GB | 9 GB | 4.5 GB | **~46 GB** |
| 100,000 | 112M | 323 GB | 89 GB | 45 GB | **~456 GB** |
| 1,000,000 | 1.12B | 3.2 TB | 0.9 TB | 0.45 TB | **~4.6 TB** |

**Had you bulk-fetched timelines**, the 100k row becomes **1.77 TB of timelines alone** — 4× the total. Lazy fetching saves ~1.7 TB and half your Riot requests.

Storage stays cheap: 456 GB on R2 is **under $8/month**. Partition by month from day one so tiering is a config change, not a migration.

---

## 13. Cost breakdown by scale

### 13.1 Option A — Hetzner + R2 ✅ recommended

| MAU | Compute | Storage | **Total/mo** | **$/user/mo** |
| --- | --- | --- | --- | --- |
| 100 | 1× CPX21 all-in-one €10 | R2 free tier | **~$11** | $0.110 |
| 1,000 | 1× CPX31 €25 + backups €5 | R2 free tier | **~$34** | $0.034 |
| 10,000 | CPX31 app €25 + CPX41 db €49 + backups €12 | 100 GB vol €4 + R2 ~$9 | **~$110** | $0.011 |
| 100,000 | 2× CPX41 €98 + CPX51 db €99 + replica €49 + LB €6 + backups €40 | 200 GB vol €9 + R2 ~$40 | **~$370** | $0.0037 |
| 1,000,000 | 6× CPX41 €294 + 3× CPX51 shards €297 + replicas €297 + 2× CPX51 ClickHouse €198 + LB/monitoring €150 | 2 TB vol €88 + R2 ~$225 | **~$1,650** | $0.0017 |

### 13.2 Option B — Neon + Cloudflare Workers + R2 (zero ops)

| MAU | Workers + DO | Neon | R2 | **Total/mo** | **$/user/mo** |
| --- | --- | --- | --- | --- | --- |
| 100 | $5 | free | free | **~$5** | $0.050 |
| 1,000 | $5 | ~$25 | ~$1 | **~$31** | $0.031 |
| 10,000 | $8 | ~$90 | ~$9 | **~$107** | $0.011 |
| 100,000 | $30 | ~$335 | ~$40 | **~$405** | $0.0041 |
| 1,000,000 | $210 | ~$2,500 | ~$225 | **~$2,935** | $0.0029 |

Neon: $0.35/GB-month storage, $0.106/CU-hour on Launch. Compute dominates at scale — the price of zero ops.

### 13.3 Option C — Firestore for match data ❌

**Carefully denormalized** (pre-computed aggregate docs, one read per page):

| MAU | Reads | Writes | Storage | Compute+egress | **Total/mo** |
| --- | --- | --- | --- | --- | --- |
| 1,000 | $2 | $2 | $2 | $10 | **~$16** |
| 10,000 | $5 | $2 | $2 | $31 | **~$40** |
| 100,000 | $49 | $16 | $22 | $169 | **~$256** |
| 1,000,000 | $486 | $162 | $220 | $1,386 | **~$2,250** |

**Used the way analytics actually works** — reading match documents to compute champion stats:

| MAU | Reads/mo | Read cost | **Total/mo** |
| --- | --- | --- | --- |
| 10,000 | 135M | $41 | **~$110** |
| 100,000 | 1.35B | $405 | **~$700** |
| 1,000,000 | 13.5B | $4,050 | **~$6,500** |

**Cost isn't the disqualifier — capability is.** Every interesting question ("how does my Ahri compare to Emerald Ahri players?") is a full scan in Firestore and one indexed query in Postgres. You'd end up bolting on a second database anyway.

**Keep Firebase for auth and Paddle entitlements.** That code works and fits. This is narrowly about match data.

### 13.4 Summary

| MAU | Hetzner ✅ | Neon+Workers | Firestore ❌ |
| --- | --- | --- | --- |
| 100 | $11 | $5 | $0 |
| 1,000 | $34 | $31 | $16 |
| 10,000 | $110 | $107 | $40–110 |
| 100,000 | $370 | $405 | $256–700 |
| 1,000,000 | $1,650 | $2,935 | $2,250–6,500 |

**Infrastructure cost is never your constraint.** At 100k MAU you spend under half a cent per user per month. A **0.5% conversion** on a $2 premium tier covers infrastructure at every scale here. Optimise for engineering time and for staying under Riot's rate limit.

---

## 14. Migration path

**Phase 0 — This week, no backend needed**
1. Rotate the leaked Riot key. **← outstanding, and still the most urgent item in this document**
2. Remove `riotApiKey` from `environment.ts`; add a bring-your-own-key screen using `validateApiKey()`. **← outstanding**
3. ~~Staleness gate + 10-min TTL on ranked and mastery~~ — **done**, §4.9.
4. **Stop bulk-fetching timelines** in `backfillMatchData`. *(Halves request volume, 4.7× storage.)* **← outstanding, now the largest remaining win**
5. Fix the DDragon version TTL (§4.7). **← outstanding**
6. ~~Cap the summoner-icon fan-out~~ — **done**, and the exposure was ~20× smaller than this document originally claimed (§4.6).
7. ~~Move the dev database out of the watched source tree~~ — **done**, §4.4b.
8. ~~Filter the heatmap year sweep server-side by queue; hydrate shared games free~~ — **done**, §4.8 / §4.10.
9. **Apply for a production key — approval takes weeks and gates everything.** **← outstanding**

**Phase 1 — Minimum viable backend (1–2 weeks)**
- One Hetzner box: Fastify + Postgres + Redis.
- Port `riot-api.service.js`, `rate-limiter.js`, `timeline-compact.js`; swap SQLite for Postgres, in-memory window for Redis.
- Two endpoints: `GET /players/:puuid/matches?since=` and `GET /matches/:id/timeline`.
- Normalise `match_participants`; drop `raw_json`.
- Client sync path added; **local SQLite read path untouched**.

**Phase 2 — Ingest quality (1 week)**
- `POST /ingest/match-hint` from the LCU `EndOfGame` event.
- Server-side backfill queue at background priority.
- R2 for timelines and cold matches.

**Phase 3 — The payoff (ongoing)**
- Aggregate tables: champion win rates, role percentiles, rank-banded benchmarks.
- "You vs. everyone" comparisons — the features that justify premium and that no local-only tool can offer.
- Public player-profile cache; popular-player lookups become free.

---

## 15. Risks

**Riot production key approval is not guaranteed, and monetization is the sticking point.** Riot's policies restrict commercial use of API data. Your Paddle plan needs framing as payment for *application features* — the vault, account switching, boards, cloud sync — explicitly not for access to Riot data. Disclose the monetization model in the application rather than hoping it isn't noticed; being upfront is both the honest route and the one more likely to be approved. Have a plan for rejection: bring-your-own-key keeps the app alive either way and is worth keeping permanently.

**Concentration risk.** Every number here assumes one production key. If it's suspended, the product stops. BYO-key fallback is real insurance.

**LCU compliance.** Using the LCU for local state is permitted; using it to circumvent rate limits is not (§3.5). Keep the match-hint design — LCU supplies the ID, the official API supplies the data.

**You cannot out-crawl op.gg** (§3.4). Any roadmap item that assumes ladder-wide meta statistics from your own ingestion is not fundable at standard production limits. Buy, borrow, or narrowly target that data.

**GDPR.** Central storage of other players' data makes you a controller. Retention policy and deletion path needed (§10.5).

**Hetzner ops burden.** The €300/mo at 100k MAU assumes you run Postgres backups, failover and patching. If that's not time you want to spend, Neon at $405 is buying something real.

**Sample size on measurements.** §5 is measured from a real database, but the timeline figure comes from **a single row**, and the activity rates from three accounts. The 108 KB timeline is consistent with Riot's payload structure and the 80%-is-`events_json` split, so it's directionally solid — but re-measure once you have a few hundred timelines before treating it as exact.

---

## 16. Open decisions

1. **Hetzner (cheap, you run it) or Neon+Workers (2×, nobody runs it)?** At your scale the gap is ~$25/mo — pick on time, not price.
2. **Does the free tier get server-side sync, or is that the premium hook?** Server storage is your marginal cost, so it's a natural paywall line — and it's a *feature* paywall, not a Riot-data paywall, which matters for §15.
3. **How deep does free-tier backfill go?** One year is generous; three months cuts new-user Riot cost by 75% and makes "unlock full history" a clean upsell.
4. **Do you want meta statistics at all?** If yes, decide now whether to buy them, borrow them, or run a narrow targeted crawl (§3.4) — it changes the schema.
5. **Keep local SQLite indefinitely?** Recommended yes — offline support and instant loads are genuine differentiators, and it's already built.

---

## Appendix A — Measurement methodology

All figures in §4, §5 and §6 come from:

- **Static analysis** of `riot-api.service.js`, `rate-limiter.js`, `main.js` IPC handlers, `analytics-data.service.ts`, `summoner-icon.service.ts`, `acc-card.component.ts`, `heatmap.service.ts`, `match-aggregation.service.ts` and `lcu-monitor.js` — tracing each screen action to the Riot calls it triggers.
- **Direct measurement** of `apps/electron/src/app/data/lolvault.db` (4.83 MB, 154 matches, `user_version = 5`) via `better-sqlite3` under Electron's Node ABI: row counts, `LENGTH()` per TEXT column, and gzip/brotli compression of the actual stored blobs.
- **Arithmetic** for the projections, using the measured per-match sizes and per-action call counts with the assumptions stated inline.

To re-run after the schema changes, measure `AVG(LENGTH(col))` per TEXT column across `match_cache`, `match_detail` and `match_timeline`, and compress a sample with `zlib.brotliCompressSync`.

---

## Appendix B — Assumptions table

| Parameter | Value | Basis |
| --- | --- | --- |
| DAU / MAU | 30% | Industry norm for sticky gaming tools — **unverified** |
| Peak concurrency / DAU | 8% | Desktop gaming tool norm — **unverified** |
| Games/user/month (blend) | 60 | **Measured**: 140 heavy, 10 casual in our DB |
| New users/month | 15% of MAU | Growth + churn assumption — **unverified** |
| Backfill depth | 400 matches | 1 year at blended rate |
| Timeline fetch rate | 5% of matches | Product decision, adjustable |
| Match record size | 17,201 B raw / 2,884 B brotli | **Measured**, n=154 |
| Per-user row size | 11,626 B raw / 400 B normalised | **Measured**, n=156 |
| Timeline size | 108,715 B raw / 15,807 B brotli | **Measured**, n=1 ⚠️ |
| Production key limit | ~50 req/s | Community consensus — **confirm on approval** |

---

## Sources

Pricing verified August 2026; provider pricing drifts — re-check before committing budget.

**Riot API**
- [Riot Developer Portal — rate limiting & key tiers](https://developer.riotgames.com/docs/portal)
- [Riot API rate limiting (HextechDocs)](https://hextechdocs.dev/rate-limiting/)
- [Getting started with the LCU API](https://hextechdocs.dev/getting-started-with-the-lcu-api/)
- [Riot API rate limiting (CommunityDragon)](https://github.com/CommunityDragon/HexDocs/blob/master/lol/riotapi/rate-limiting.md)

**Competitors**
- [OP.GG launches on Overwolf — 30M MAU figure](https://dotesports.com/league-of-legends/news/opgg-overwolf-lol-25121)
- [op.gg traffic analytics (Similarweb)](https://www.similarweb.com/website/op.gg/)
- [u.gg competitors & traffic (Semrush)](https://www.semrush.com/website/u.gg/competitors/)
- [U.GG FAQ — data sourcing and role detection](https://u.gg/faq)
- [mobalytics.gg traffic analytics](https://www.similarweb.com/website/mobalytics.gg/)

**Infrastructure pricing**
- [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing)
- [Firestore pricing](https://cloud.google.com/firestore/pricing)
- [Neon pricing breakdown 2026](https://vela.simplyblock.io/articles/neon-serverless-postgres-pricing-2026/)
- [Supabase pricing 2026](https://makerkit.dev/blog/saas/supabase-pricing)
- [Hetzner price adjustment, 15 June 2026](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/)
- [Hetzner cloud price increases — analysis](https://northflank.com/blog/hetzner-cloud-server-price-increases)

**Auth pricing**
- [Auth & identity comparison 2026](https://agentdeals.dev/auth-comparison-2026)
- [Firebase Auth cost guide 2026](https://www.metacto.com/blogs/the-complete-guide-to-firebase-auth-costs-setup-integration-and-maintenance)
- [Clerk vs Auth0 vs Supabase Auth 2026](https://www.devtoolreviews.com/reviews/clerk-vs-auth0-vs-supabase-auth-2026)
