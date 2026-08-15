import { Injectable, inject, signal } from '@angular/core';
import { Account } from '../../../models/interfaces/Account';
import {
  BackfillProgress,
  CompactTimeline,
  LadderHarvestPlan,
  LadderHarvestProgress,
  MatchCacheRow,
  MatchDetail,
  PlayerRank,
  RankSnapshot,
  YearHistoryProgress,
} from '../../../../types/electron';
import { RiotApiService } from '../../../services/riot-api.service';

export interface RankedEntry {
  queueType: string;
  tier: string;
  rank: string;
  leaguePoints: number;
  wins: number;
  losses: number;
  hotStreak: boolean;
}

/** One champion-mastery entry, trimmed to what the overview panel renders. */
export interface MasteryEntry {
  championId: number;
  championLevel: number;
  championPoints: number;
}

/** Why analytics has nothing to show, so the UI can explain rather than spin. */
export type LoadFailure = 'no-api-key' | 'no-account' | 'no-puuid' | 'error' | null;

function hasError(value: unknown): value is { error: string } {
  return !!value && typeof value === 'object' && 'error' in value;
}

/**
 * How many cached games a screen reads. A full calendar year of an active
 * player runs well past a thousand, and the heatmap is only as complete as this
 * limit allows.
 */
const MATCH_CACHE_LIMIT = 2000;

/** Cache namespace for a non-vault player, kept clear of any vault id. */
export function externalCacheKey(puuid: string): string {
  return `player:${puuid}`;
}

/**
 * Runs an optional main-process call, swallowing the case where the handler is
 * not there.
 *
 * The main process is a separate process with its own lifetime: a dev rebuild
 * reloads the renderer while `main.js` keeps running the code it started with,
 * and a packaged build can be older still. A renderer that hard-depends on a
 * freshly added IPC channel therefore fails against a main process that has
 * never heard of it. Housekeeping calls opt out of that — better to skip the
 * cleanup than to take the page down with "No handler registered".
 */
async function optionalIpc<T>(call: () => Promise<T>): Promise<T | null> {
  try {
    return await call();
  } catch (err) {
    console.warn('[analytics] optional IPC unavailable:', err);
    return null;
  }
}

/**
 * Loads and caches everything the analytics screens read for one account.
 *
 * Timelines and match detail are fetched lazily (on card expand) rather than up
 * front: Riot's sustained budget is ~0.83 req/s, so eagerly pulling a timeline
 * for every match would cost minutes for data the user may never open.
 */
@Injectable({ providedIn: 'root' })
export class AnalyticsDataService {
  private riotApi = inject(RiotApiService);

  readonly loading = signal(true);
  readonly failure = signal<LoadFailure>(null);
  readonly errorMessage = signal<string | null>(null);

  readonly account = signal<Account | null>(null);
  readonly puuid = signal<string | null>(null);
  readonly platform = signal<string>('euw1');
  readonly ranked = signal<RankedEntry[]>([]);
  readonly matches = signal<MatchCacheRow[]>([]);
  /**
   * Daily rank series, every queue — one row per day the account was recorded.
   *
   * Holds all queues rather than solo alone so a single read feeds the overview
   * chart, the peak badge and each rail queue card; every consumer filters to
   * the queue it means. This replaced the raw `lp_snapshots` readings, which
   * had no queue column and clustered around whenever the app happened to be
   * open.
   */
  readonly rankSnapshots = signal<RankSnapshot[]>([]);
  readonly mastery = signal<MasteryEntry[]>([]);

  /** True when viewing somebody else's profile rather than a vault account. */
  readonly external = signal(false);

  /**
   * True once this profile has painted real content at least once.
   *
   * `loading` gates the skeleton, and the skeleton is only ever correct for a
   * screen that has nothing on it. Any later work — a background refresh, a
   * year sweep, a re-entry into the same profile — updates panels in place. A
   * page that has already drawn must never be replaced by its own outline.
   */
  readonly hydrated = signal(false);

  /** A history refresh is running behind an already-painted page. */
  readonly refreshing = signal(false);

  readonly backfill = signal<BackfillProgress | null>(null);
  readonly backfillRunning = signal(false);

  readonly yearHistory = signal<YearHistoryProgress | null>(null);
  readonly yearHistoryRunning = signal(false);

  /**
   * Ranks of every player seen in the loaded match history, from the local
   * cache — keyed by puuid.
   *
   * The point of this signal is that filling it is nearly free. A ladder harvest
   * caches 205 players per request, so the ranks of the nine other people in a
   * match are almost always already here; without one, showing them would cost
   * nine requests per card. Misses stay absent rather than being looked up
   * behind the user's back.
   */
  readonly playerRanks = signal<Record<string, PlayerRank>>({});

  readonly ladderHarvest = signal<LadderHarvestProgress | null>(null);
  readonly ladderHarvestRunning = signal(false);
  readonly ladderHarvestError = signal<string | null>(null);

  /** In-memory caches so re-opening a match card is instant. */
  private timelineCache = new Map<string, CompactTimeline>();
  private detailCache = new Map<string, MatchDetail>();

  private backfillListenerBound = false;
  private yearHistoryListenerBound = false;
  private ladderListenerBound = false;

  /**
   * Cache key the streaming year-history listener is currently filtering on.
   *
   * The listener is registered once for the lifetime of the app — `ipcRenderer`
   * has no unsubscribe here — so it reads the key from this field rather than
   * closing over whichever account happened to be open when it was bound.
   */
  private streamingKey = '';

  /**
   * Cache namespace for the account being viewed. For a vault entry this is the
   * vault id; for someone else's profile it is their puuid, so their games are
   * cached under their own key instead of polluting ours.
   */
  private cacheKey = '';

  /** Incremented per load; stale loads check it before touching any signal. */
  private loadToken = 0;

  /**
   * Marks the start of a load and invalidates any still in flight.
   *
   * This service is a singleton shared by every analytics screen, and a load is
   * a long chain of awaits — a history refresh alone can run for minutes. Click
   * through to another player and back and the first load's remaining awaits
   * would still resolve and write *its* account, matches and rank over the
   * newer ones. That is how you end up looking at someone else's stats on your
   * own profile. Every write past an await is gated on still being current.
   */
  private beginLoad(): number {
    this.loadToken++;
    this.loading.set(true);
    this.hydrated.set(false);
    this.refreshing.set(false);
    this.failure.set(null);
    this.errorMessage.set(null);
    return this.loadToken;
  }

  private isCurrent(token: number): boolean {
    return token === this.loadToken;
  }

  /** Clears `loading` exactly once, the first time real content is available. */
  private markPainted(): void {
    this.loading.set(false);
    this.hydrated.set(true);
  }

  /**
   * Folds rows into `matches` by match id, newest first.
   *
   * Deliberately a merge rather than a `set`. Replacing the array wholesale
   * hands every downstream computed a completely new object graph, so panels
   * that did not change still recompute and repaint — which is what made a
   * background fetch look like the page reloading. Rows that are genuinely
   * unchanged keep their identity here, so Angular has nothing to re-render for
   * them.
   */
  private mergeMatches(incoming: MatchCacheRow[]): void {
    if (!incoming.length) return;

    this.matches.update((current) => {
      const byId = new Map(current.map((row) => [row.match_id, row]));
      let changed = false;

      for (const row of incoming) {
        const existing = byId.get(row.match_id);
        if (existing && !this.rowDiffers(existing, row)) continue;
        byId.set(row.match_id, row);
        changed = true;
      }

      if (!changed) return current;
      return [...byId.values()].sort((a, b) => b.timestamp - a.timestamp);
    });
  }

  /**
   * Cheap staleness check for a cached row. Compares the fields a re-fetch can
   * actually move rather than deep-equalling an 11 KB `raw_json` blob.
   */
  private rowDiffers(a: MatchCacheRow, b: MatchCacheRow): boolean {
    return (
      a.timestamp !== b.timestamp ||
      a.win !== b.win ||
      a.has_detail !== b.has_detail ||
      a.has_timeline !== b.has_timeline ||
      a.gold_diff_15 !== b.gold_diff_15
    );
  }

  /** Loads everything for a vault entry. Safe to call repeatedly. */
  async load(vaultId: string): Promise<void> {
    const token = this.beginLoad();
    this.external.set(false);

    try {
      const accounts: Account[] = await window.electronAPI.loadAccounts();
      if (!this.isCurrent(token)) return;

      const account = accounts.find((a) => (a.syncId || String(a.id)) === vaultId) ?? null;
      if (!account) {
        this.failure.set('no-account');
        return;
      }
      this.account.set(account);
      this.cacheKey = vaultId;

      const hasKey = await this.hasApiKey();
      if (!this.isCurrent(token)) return;
      if (!hasKey) return;

      const platform = this.riotApi.serverToPlatform(account.server || 'EUW');
      this.platform.set(platform);

      let puuid = account.puuid as string | undefined;
      if (!puuid) {
        const [gameName, tagLine] = (account.name || '').split('#');
        if (gameName && tagLine) {
          const summoner = await window.electronAPI.riotGetSummonerByRiotId({
            gameName,
            tagLine,
            platform,
          });
          if (!this.isCurrent(token)) return;
          if (summoner && 'puuid' in summoner) puuid = summoner.puuid;
        }
      }
      if (!puuid) {
        this.failure.set('no-puuid');
        return;
      }
      this.puuid.set(puuid);

      // Optional: a main process from before the daily series exists has no
      // handler for this, and an empty graph is a far better outcome than a
      // dead analytics page.
      const rankResult = await optionalIpc(() => window.electronAPI.getRankSnapshots(vaultId));
      if (!this.isCurrent(token)) return;
      this.rankSnapshots.set(rankResult?.snapshots ?? []);

      await this.loadRiotData(token, vaultId, puuid, platform, 30);
    } catch (err: unknown) {
      if (this.isCurrent(token)) this.fail(err);
    } finally {
      if (this.isCurrent(token)) this.loading.set(false);
    }
  }

  /**
   * Loads analytics for somebody who is not in the vault — a teammate or an
   * opponent the user clicked through to.
   *
   * Their games are cached under their own puuid rather than under one of our
   * vault ids, so the two never mix. There are no LP snapshots for them: we
   * have never been running while they climbed, which is exactly why the
   * heatmap reads from games rather than from LP.
   */
  async loadPlayer(puuid: string, platform: string, displayName?: string): Promise<void> {
    const token = this.beginLoad();
    this.external.set(true);
    this.rankSnapshots.set([]);

    try {
      if (!puuid) {
        this.failure.set('no-puuid');
        return;
      }

      this.puuid.set(puuid);
      this.platform.set(platform);
      this.cacheKey = externalCacheKey(puuid);

      // Paint the name we were handed immediately; the profile lookup below
      // fills in the icon and level a moment later.
      this.account.set({
        id: puuid,
        name: displayName || 'Unknown player',
        game: 'lol',
        server: this.riotApi.platformToServer(platform),
        puuid,
      } as Account);

      const hasKey = await this.hasApiKey();
      if (!this.isCurrent(token)) return;
      if (!hasKey) return;

      const profile = await window.electronAPI.riotGetSummonerByPuuid({ puuid, platform });
      if (!this.isCurrent(token)) return;
      if (profile && !hasError(profile)) {
        this.account.update((current) =>
          current
            ? {
                ...current,
                profileIconId: profile.profileIconId,
                summonerLevel: profile.summonerLevel,
              }
            : current
        );
      }

      // A profile we have never seen has nothing cached, so every game in the
      // first page is a fresh request. Ten per queue is enough to fill the
      // opening screen; the heatmap's own control pulls the rest on demand.
      await this.loadRiotData(token, this.cacheKey, puuid, platform, 10);
    } catch (err: unknown) {
      if (this.isCurrent(token)) this.fail(err);
    } finally {
      if (this.isCurrent(token)) this.loading.set(false);
    }
  }

  /**
   * The half of a load that only needs a puuid.
   *
   * Everything cheap happens before `loading` clears — identity, rank, mastery
   * and whatever is already cached. The history refresh is deliberately left
   * running afterwards: it costs one Riot request per uncached game, which for
   * a new profile is minutes, and holding a spinner over the whole page for
   * that long reads as a hang.
   */
  private async loadRiotData(
    token: number,
    accountId: string,
    puuid: string,
    platform: string,
    historyCount: number
  ): Promise<void> {
    // Any row filed under this account but belonging to someone else is not
    // ours to show. Rows like that should no longer be created, but a cache
    // written before the key was fixed can still hold them. Housekeeping, so it
    // is skipped rather than fatal if the running main process predates it.
    await optionalIpc(() => window.electronAPI.riotPurgeForeignMatches({ accountId, puuid }));
    if (!this.isCurrent(token)) return;

    const cached = await window.electronAPI.riotGetCachedMatches({
      accountId,
      limit: MATCH_CACHE_LIMIT,
    });
    if (!this.isCurrent(token)) return;
    this.matches.set(Array.isArray(cached) ? cached : []);

    const [ranked, mastery] = await Promise.all([
      window.electronAPI.riotGetRankedByPuuid({ puuid, platform }),
      window.electronAPI.riotGetTopMastery({ puuid, platform }),
      this.riotApi.getDDragonVersion(),
    ]);
    if (!this.isCurrent(token)) return;

    if (hasError(ranked)) throw new Error(ranked.error);
    this.ranked.set(Array.isArray(ranked) ? (ranked as RankedEntry[]) : []);
    // Mastery is decoration, not the point of the page — a failure here just
    // leaves the panel empty rather than failing the whole load.
    this.mastery.set(Array.isArray(mastery) ? mastery : []);

    this.markPainted();
    void this.refreshHistory(token, accountId, puuid, platform, historyCount);
  }

  /** Background history refresh. Never blocks the page, never fails it. */
  private async refreshHistory(
    token: number,
    accountId: string,
    puuid: string,
    platform: string,
    count: number
  ): Promise<void> {
    this.refreshing.set(true);
    try {
      const fresh = await window.electronAPI.riotGetMatchHistory({
        accountId,
        puuid,
        platform,
        count,
      });
      if (!this.isCurrent(token)) return;

      if (hasError(fresh)) {
        // Cached rows are still on screen; a refresh failure only matters when
        // there was nothing to show in the first place.
        if (!this.matches().length) this.fail(new Error(fresh.error));
        return;
      }

      const all = await window.electronAPI.riotGetCachedMatches({
        accountId,
        limit: MATCH_CACHE_LIMIT,
      });
      if (!this.isCurrent(token)) return;
      this.mergeMatches(Array.isArray(all) && all.length ? all : (fresh as MatchCacheRow[]));
    } catch (err: unknown) {
      if (this.isCurrent(token) && !this.matches().length) this.fail(err);
    } finally {
      if (this.isCurrent(token)) this.refreshing.set(false);
    }
  }

  private async hasApiKey(): Promise<boolean> {
    const keyResult = await window.electronAPI.getApiKey();
    if (!keyResult?.value) {
      this.failure.set('no-api-key');
      return false;
    }
    return true;
  }

  private fail(err: unknown): void {
    this.failure.set('error');
    this.errorMessage.set(err instanceof Error ? err.message : 'Unknown error');
  }

  /** Compacted timeline for a match, fetched on first request. */
  async timeline(matchId: string): Promise<CompactTimeline | null> {
    const cached = this.timelineCache.get(matchId);
    if (cached) return cached;

    const result = await window.electronAPI.riotGetMatchTimeline({
      matchId,
      platform: this.platform(),
    });
    if (!result || hasError(result)) return null;

    this.timelineCache.set(matchId, result);
    return result;
  }

  /** Full match detail (bans, objectives, damage breakdown), fetched on demand. */
  async detail(matchId: string): Promise<MatchDetail | null> {
    const cached = this.detailCache.get(matchId);
    if (cached) return cached;

    const account = this.account();
    const puuid = this.puuid();
    if (!account || !puuid) return null;

    const result = await window.electronAPI.riotGetMatchDetail({
      matchId,
      accountId: account.syncId || String(account.id),
      puuid,
      platform: this.platform(),
    });
    if (!result || hasError(result)) return null;

    this.detailCache.set(matchId, result);
    return result;
  }

  /** Pending backfill work and an honest ETA, for the history control. */
  async backfillStatus(): Promise<{
    pendingMatches: number;
    pendingRequests: number;
    etaSeconds: number;
  }> {
    if (!this.cacheKey) return { pendingMatches: 0, pendingRequests: 0, etaSeconds: 0 };
    return window.electronAPI.riotGetBackfillStatus({ accountId: this.cacheKey });
  }

  /** Starts a cancellable backfill, streaming progress into `backfill`. */
  async startBackfill(limit = MATCH_CACHE_LIMIT): Promise<void> {
    const puuid = this.puuid();
    const accountId = this.cacheKey;
    if (!accountId || !puuid || this.backfillRunning()) return;

    this.streamingKey = accountId;

    if (!this.backfillListenerBound) {
      // Bound once for the app's lifetime, so it filters on the field rather
      // than on whichever account was open when it was registered.
      window.electronAPI.onBackfillProgress((progress) => {
        if (progress.accountId === this.streamingKey) this.backfill.set(progress);
      });
      this.backfillListenerBound = true;
    }

    this.backfillRunning.set(true);
    try {
      await window.electronAPI.riotBackfillMatchData({
        accountId,
        puuid,
        platform: this.platform(),
        limit,
      });
      // Newly derived @15 diffs live on match_cache, so re-read the rows.
      const refreshed = await window.electronAPI.riotGetCachedMatches({
        accountId,
        limit: MATCH_CACHE_LIMIT,
      });
      if (Array.isArray(refreshed)) this.mergeMatches(refreshed);
    } finally {
      this.backfillRunning.set(false);
    }
  }

  /**
   * Pulls a calendar year of games so the heatmap has something to show outside
   * the last few weeks.
   *
   * `queue` narrows the sweep server-side — the heatmap passes ranked solo/duo,
   * which is both what it reports on and, on a mixed account, several times
   * cheaper than listing every mode.
   *
   * Games are merged into `matches` as they land rather than in one block at
   * the end, so the grid fills in while the fetch runs. That matters at this
   * duration: a year on a rate-limited key is minutes, and a screen that shows
   * nothing for minutes and then rebuilds itself reads as a page reload.
   */
  async fetchYear(year: number, queue?: number): Promise<void> {
    const puuid = this.puuid();
    const accountId = this.cacheKey;
    if (!puuid || !accountId || this.yearHistoryRunning()) return;

    this.streamingKey = accountId;

    if (!this.yearHistoryListenerBound) {
      // Subscribing to a channel the running main process does not publish is
      // harmless; invoking a handler it lacks is not.
      void optionalIpc(async () => {
        window.electronAPI.onYearHistoryProgress((progress) => {
          if (progress.accountId === this.streamingKey) this.yearHistory.set(progress);
        });
        window.electronAPI.onYearHistoryRows?.(({ accountId: id, rows }) => {
          if (id === this.streamingKey) this.mergeMatches(rows);
        });
      });
      this.yearHistoryListenerBound = true;
    }

    this.yearHistoryRunning.set(true);
    try {
      const result = await optionalIpc(() =>
        window.electronAPI.riotFetchYearHistory({
          accountId,
          puuid,
          platform: this.platform(),
          year,
          queue,
        })
      );
      if (result === null) {
        this.errorMessage.set(
          'Loading a full year needs a newer app version than the one currently running. Restart LoL Vault and try again.'
        );
        return;
      }

      // A main process without the row stream sent nothing during the sweep, so
      // reconcile once at the end. With streaming on, this is a no-op merge.
      const refreshed = await window.electronAPI.riotGetCachedMatches({
        accountId,
        limit: MATCH_CACHE_LIMIT,
      });
      if (Array.isArray(refreshed)) this.mergeMatches(refreshed);
    } finally {
      this.yearHistoryRunning.set(false);
      this.yearHistory.set(null);
    }
  }

  /**
   * Which divisions a harvest would cover and what it would cost, so the button
   * can quote a wait before the user commits. Null when the running main process
   * predates ladder harvesting.
   */
  async ladderHarvestPlan(
    queue = 'RANKED_SOLO_5x5',
    spread = 1
  ): Promise<LadderHarvestPlan | null> {
    const puuid = this.puuid();
    if (!puuid) return null;

    const result = await optionalIpc(() =>
      window.electronAPI.riotPlanLadderHarvest({
        puuid,
        platform: this.platform(),
        queue,
        spread,
      })
    );
    if (!result || 'error' in result) return null;
    return result;
  }

  /**
   * Loads cached ranks for every player in the currently visible matches.
   *
   * Costs nothing: it reads the local cache and never falls back to per-player
   * lookups. Players the cache has never seen simply stay absent, and the UI
   * says "unknown" rather than spending nine requests to avoid saying it.
   */
  async loadPlayerRanks(puuids: string[], queue = 'RANKED_SOLO_5x5'): Promise<void> {
    if (!puuids.length) return;

    const result = await optionalIpc(() =>
      window.electronAPI.riotGetPlayerRanks({
        puuids,
        platform: this.platform(),
        queue,
      })
    );
    if (!result?.ranks) return;

    // Merged, not replaced: scrolling further down the match list should add to
    // what is known rather than discard the ranks already on screen.
    this.playerRanks.update((current) => ({ ...current, ...result.ranks }));
  }

  /**
   * Pages the divisions around this account's rank into the local rank cache.
   *
   * The one call in this service whose cost is bounded by the size of the ladder
   * rather than by the user's own history, so it is never automatic. What it
   * buys is that every match card afterwards shows ranks for free — the same
   * information that costs nine requests per card to fetch player by player.
   */
  async harvestLadder(queue = 'RANKED_SOLO_5x5', spread = 1): Promise<void> {
    const puuid = this.puuid();
    const accountId = this.cacheKey;
    if (!puuid || !accountId || this.ladderHarvestRunning()) return;

    this.streamingKey = accountId;
    this.ladderHarvestError.set(null);

    if (!this.ladderListenerBound) {
      void optionalIpc(async () => {
        window.electronAPI.onLadderHarvestProgress((progress) => {
          if (progress.accountId === this.streamingKey) this.ladderHarvest.set(progress);
        });
      });
      this.ladderListenerBound = true;
    }

    this.ladderHarvestRunning.set(true);
    try {
      const result = await optionalIpc(() =>
        window.electronAPI.riotHarvestLadder({
          accountId,
          puuid,
          platform: this.platform(),
          queue,
          spread,
        })
      );

      if (result === null) {
        this.ladderHarvestError.set(
          'Harvesting the ladder needs a newer app version than the one currently running. Restart LoL Vault and try again.'
        );
        return;
      }
      if ('error' in result) {
        this.ladderHarvestError.set(
          result.error === 'unranked'
            ? 'This queue has no rank yet, so there is no division to harvest around.'
            : result.error
        );
        return;
      }

      // The harvest also wrote a rank-snapshot row if it paged over this
      // account's own entry, so re-read the series rather than guessing.
      const snapshots = await optionalIpc(() =>
        window.electronAPI.getRankSnapshots(accountId)
      );
      if (snapshots?.snapshots) this.rankSnapshots.set(snapshots.snapshots);
    } finally {
      this.ladderHarvestRunning.set(false);
      this.ladderHarvest.set(null);
    }
  }

  async cancelLadderHarvest(): Promise<void> {
    if (!this.cacheKey) return;
    await optionalIpc(() =>
      window.electronAPI.riotCancelLadderHarvest({ accountId: this.cacheKey })
    );
  }

  async cancelYearHistory(): Promise<void> {
    if (!this.cacheKey) return;
    await optionalIpc(() =>
      window.electronAPI.riotCancelYearHistory({ accountId: this.cacheKey })
    );
  }

  async cancelBackfill(): Promise<void> {
    if (!this.cacheKey) return;
    await window.electronAPI.riotCancelBackfill({ accountId: this.cacheKey });
  }

  /** Clears per-account state when navigating to a different profile. */
  reset(): void {
    this.loadToken++;
    this.refreshing.set(false);
    this.hydrated.set(false);
    this.cacheKey = '';
    this.streamingKey = '';
    this.external.set(false);
    this.yearHistory.set(null);
    this.ladderHarvest.set(null);
    this.ladderHarvestError.set(null);
    // The rank cache itself is on disk and shared across accounts; only this
    // profile's view of it is cleared.
    this.playerRanks.set({});
    this.timelineCache.clear();
    this.detailCache.clear();
    this.matches.set([]);
    this.ranked.set([]);
    this.rankSnapshots.set([]);
    this.mastery.set([]);
    this.backfill.set(null);
    this.account.set(null);
    this.puuid.set(null);
  }
}
