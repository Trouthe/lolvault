import { Injectable, inject, signal } from '@angular/core';
import { Account } from '../../../models/interfaces/Account';
import {
  BackfillProgress,
  CompactTimeline,
  LpSnapshot,
  MatchCacheRow,
  MatchDetail,
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

/** Why analytics has nothing to show, so the UI can explain rather than spin. */
export type LoadFailure = 'no-api-key' | 'no-account' | 'no-puuid' | 'error' | null;

function hasError(value: unknown): value is { error: string } {
  return !!value && typeof value === 'object' && 'error' in value;
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

  readonly backfill = signal<BackfillProgress | null>(null);
  readonly backfillRunning = signal(false);

  /** In-memory caches so re-opening a match card is instant. */
  private timelineCache = new Map<string, CompactTimeline>();
  private detailCache = new Map<string, MatchDetail>();

  private backfillListenerBound = false;

  /** Loads everything for a vault id. Safe to call repeatedly. */
  async load(vaultId: string): Promise<void> {
    this.loading.set(true);
    this.failure.set(null);
    this.errorMessage.set(null);

    try {
      const accounts: Account[] = await window.electronAPI.loadAccounts();
      const account = accounts.find((a) => (a.syncId || String(a.id)) === vaultId) ?? null;
      if (!account) {
        this.failure.set('no-account');
        return;
      }
      this.account.set(account);

      const keyResult = await window.electronAPI.getApiKey();
      if (!keyResult?.value) {
        this.failure.set('no-api-key');
        return;
      }

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
          if (summoner && 'puuid' in summoner) puuid = summoner.puuid;
        }
      }
      if (!puuid) {
        this.failure.set('no-puuid');
        return;
      }
      this.puuid.set(puuid);

      // Cached rows first so the UI paints immediately, then refresh from Riot.
      const cached = await window.electronAPI.riotGetCachedMatches({
        accountId: vaultId,
        limit: 200,
      });
      if (Array.isArray(cached) && cached.length) this.matches.set(cached);

      const [ranked, lpResult] = await Promise.all([
        window.electronAPI.riotGetRankedByPuuid({ puuid, platform }),
        window.electronAPI.getLpSnapshots(vaultId),
        this.riotApi.getDDragonVersion(),
      ]);

      if (hasError(ranked)) throw new Error(ranked.error);
      this.ranked.set(Array.isArray(ranked) ? (ranked as RankedEntry[]) : []);
      this.lpSnapshots.set(lpResult?.snapshots ?? []);

      const fresh = await window.electronAPI.riotGetMatchHistory({
        accountId: vaultId,
        puuid,
        platform,
        count: 30,
      });
      if (hasError(fresh)) {
        // Keep whatever was cached — a refresh failure shouldn't blank the page.
        if (!this.matches().length) throw new Error(fresh.error);
      } else if (Array.isArray(fresh)) {
        const all = await window.electronAPI.riotGetCachedMatches({
          accountId: vaultId,
          limit: 200,
        });
        this.matches.set(Array.isArray(all) && all.length ? all : fresh);
      }
    } catch (err: unknown) {
      this.failure.set('error');
      this.errorMessage.set(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      this.loading.set(false);
    }
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
    const account = this.account();
    if (!account) return { pendingMatches: 0, pendingRequests: 0, etaSeconds: 0 };
    return window.electronAPI.riotGetBackfillStatus({
      accountId: account.syncId || String(account.id),
    });
  }

  /** Starts a cancellable backfill, streaming progress into `backfill`. */
  async startBackfill(limit = 200): Promise<void> {
    const account = this.account();
    const puuid = this.puuid();
    if (!account || !puuid || this.backfillRunning()) return;

    const accountId = account.syncId || String(account.id);

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
      const refreshed = await window.electronAPI.riotGetCachedMatches({ accountId, limit: 200 });
      if (Array.isArray(refreshed) && refreshed.length) this.matches.set(refreshed);
    } finally {
      this.backfillRunning.set(false);
    }
  }

  async cancelBackfill(): Promise<void> {
    const account = this.account();
    if (!account) return;
    await window.electronAPI.riotCancelBackfill({
      accountId: account.syncId || String(account.id),
    });
  }

  /** Clears per-account state when navigating to a different vault. */
  reset(): void {
    this.timelineCache.clear();
    this.detailCache.clear();
    this.matches.set([]);
    this.ranked.set([]);
    this.lpSnapshots.set([]);
    this.backfill.set(null);
    this.account.set(null);
    this.puuid.set(null);
  }
}
