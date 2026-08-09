import { Injectable, inject, signal } from '@angular/core';
import { Account } from '../../../models/interfaces/Account';
import {
  BackfillProgress,
  CompactTimeline,
  LpSnapshot,
  MatchCacheRow,
  MatchDetail,
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
  readonly lpSnapshots = signal<LpSnapshot[]>([]);
  readonly mastery = signal<MasteryEntry[]>([]);

  /** True when viewing somebody else's profile rather than a vault account. */
  readonly external = signal(false);

  /** A history refresh is running behind an already-painted page. */
  readonly refreshing = signal(false);

  readonly backfill = signal<BackfillProgress | null>(null);
  readonly backfillRunning = signal(false);

  readonly yearHistory = signal<YearHistoryProgress | null>(null);
  readonly yearHistoryRunning = signal(false);

  /** In-memory caches so re-opening a match card is instant. */
  private timelineCache = new Map<string, CompactTimeline>();
  private detailCache = new Map<string, MatchDetail>();

  private backfillListenerBound = false;
  private yearHistoryListenerBound = false;

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
    this.refreshing.set(false);
    this.failure.set(null);
    this.errorMessage.set(null);
    return this.loadToken;
  }

  private isCurrent(token: number): boolean {
    return token === this.loadToken;
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

      const lpResult = await window.electronAPI.getLpSnapshots(vaultId);
      if (!this.isCurrent(token)) return;
      this.lpSnapshots.set(lpResult?.snapshots ?? []);

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
    this.lpSnapshots.set([]);

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
    // written before the key was fixed can still hold them.
    await window.electronAPI.riotPurgeForeignMatches({ accountId, puuid });
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

    this.loading.set(false);
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
      this.matches.set(Array.isArray(all) && all.length ? all : (fresh as MatchCacheRow[]));
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

    if (!this.backfillListenerBound) {
      window.electronAPI.onBackfillProgress((progress) => {
        if (progress.accountId === accountId) this.backfill.set(progress);
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
      if (Array.isArray(refreshed) && refreshed.length) this.matches.set(refreshed);
    } finally {
      this.backfillRunning.set(false);
    }
  }

  /**
   * Pulls a full calendar year of games so the heatmap has something to show
   * outside the last few weeks. Streams progress into `yearHistory`.
   */
  async fetchYear(year: number): Promise<void> {
    const puuid = this.puuid();
    const accountId = this.cacheKey;
    if (!puuid || !accountId || this.yearHistoryRunning()) return;

    if (!this.yearHistoryListenerBound) {
      window.electronAPI.onYearHistoryProgress((progress) => {
        if (progress.accountId === accountId) this.yearHistory.set(progress);
      });
      this.yearHistoryListenerBound = true;
    }

    this.yearHistoryRunning.set(true);
    try {
      await window.electronAPI.riotFetchYearHistory({
        accountId,
        puuid,
        platform: this.platform(),
        year,
      });
      const refreshed = await window.electronAPI.riotGetCachedMatches({
        accountId,
        limit: MATCH_CACHE_LIMIT,
      });
      if (Array.isArray(refreshed) && refreshed.length) this.matches.set(refreshed);
    } finally {
      this.yearHistoryRunning.set(false);
      this.yearHistory.set(null);
    }
  }

  async cancelYearHistory(): Promise<void> {
    if (!this.cacheKey) return;
    await window.electronAPI.riotCancelYearHistory({ accountId: this.cacheKey });
  }

  async cancelBackfill(): Promise<void> {
    if (!this.cacheKey) return;
    await window.electronAPI.riotCancelBackfill({ accountId: this.cacheKey });
  }

  /** Clears per-account state when navigating to a different profile. */
  reset(): void {
    this.loadToken++;
    this.refreshing.set(false);
    this.cacheKey = '';
    this.external.set(false);
    this.yearHistory.set(null);
    this.timelineCache.clear();
    this.detailCache.clear();
    this.matches.set([]);
    this.ranked.set([]);
    this.lpSnapshots.set([]);
    this.mastery.set([]);
    this.backfill.set(null);
    this.account.set(null);
    this.puuid.set(null);
  }
}
