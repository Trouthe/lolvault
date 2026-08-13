/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  Component,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { filter } from 'rxjs';
import { Account, LpTrendPoint } from '../../models/interfaces/Account';
import { RankedInfo } from '../../models/interfaces/Riot';
import { CardLayout, SettingsService } from '../../services/settings.service';
import { RiotApiService } from '../../services/riot-api.service';
import { ChampionCatalogService } from '../../services/champion-catalog.service';
import { LcuService } from '../../services/lcu.service';

const REFRESH_COOLDOWN_MS = 3 * 60 * 1000; // 3 minutes

/** Riot team positions → the labels and position-selector icon slugs we display. */
const LANE_META: Record<string, { label: string; slug: string }> = {
  TOP: { label: 'Top', slug: 'top' },
  JUNGLE: { label: 'Jungle', slug: 'jungle' },
  MIDDLE: { label: 'Mid', slug: 'middle' },
  MID: { label: 'Mid', slug: 'middle' },
  BOTTOM: { label: 'ADC', slug: 'bottom' },
  ADC: { label: 'ADC', slug: 'bottom' },
  UTILITY: { label: 'Support', slug: 'utility' },
  SUPPORT: { label: 'Support', slug: 'utility' },
};

const POSITION_ICON_BASE =
  'https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-clash/global/default/assets/images/position-selector/positions/icon-position-';

/** Sparkline viewBox — kept in sync with the <svg> in the template. */
const SPARK_WIDTH = 96;
const SPARK_HEIGHT = 28;
const SPARK_PADDING_X = 3;
/** Vertical breathing room so the smoothed curve never clips at the extremes. */
const SPARK_PADDING_Y = 5;
/** Curve tension for the Catmull-Rom → bezier conversion. Low = hugs the data. */
const SPARK_TENSION = 0.18;

/** The trend only ever describes the last 7 days of recorded readings. */
const LP_TREND_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Queues we keep a daily rank history for. */
const TRACKED_RANK_QUEUES = ['RANKED_SOLO_5x5', 'RANKED_FLEX_SR'];

/** Gradient ids must be unique per card instance or the fills collide. */
let sparkInstanceCounter = 0;

@Component({
  selector: 'app-acc-card',
  imports: [CommonModule],
  templateUrl: './acc-card.component.html',
  styleUrl: './acc-card.component.scss',
})
export class AccCardComponent implements OnDestroy {
  account = input<Account>();
  showRemoveFromFolder = input<boolean>(false);
  layout = input<CardLayout>('list');
  editRequested = output<Account>();
  deleteRequested = output<Account>();
  removeFromFolderRequested = output<Account>();
  refreshRequested = output<Account>();
  /** Emitted when the user drives this account from LoL Vault (launch / session save). */
  activityRecorded = output<Account>();

  settingsService = inject(SettingsService);
  private riotApiService = inject(RiotApiService);
  private championCatalog = inject(ChampionCatalogService);
  private lcuService = inject(LcuService);
  private router = inject(Router);

  isGrid = computed(() => this.layout() === 'grid');

  isLaunching = signal(false);
  isSavingSession = signal(false);
  isRefreshing = signal(false);
  launchErrorState = signal(false);
  showLaunchToast = signal(false);
  launchToastMessage = signal('');
  showSessionToast = signal(false);
  sessionToastMessage = signal('');
  sessionToastError = signal(false);
  private launchToastTimeout: ReturnType<typeof setTimeout> | null = null;
  private sessionToastTimeout: ReturnType<typeof setTimeout> | null = null;

  // ── LCU live state ───────────────────────────────────────────────────────────

  /** True when this card's account is the one currently active in the LCU. */
  isLive = computed(() => {
    const state = this.lcuService.liveState();
    const acc = this.account();
    if (!acc || !state.activeVaultId) return false;
    // Match using the same vaultId formula as lcu-monitor.js
    const vaultId = acc.syncId || String(acc.id);
    return !!vaultId && vaultId === state.activeVaultId;
  });

  /** mm:ss game timer — non-empty only while a live game is in progress. */
  gameTimerDisplay = signal('');

  /** LP delta from the last completed game (+18 / -15), or null when hidden. */
  lpDeltaValue = signal<number | null>(null);
  lpDeltaWin = signal(false);
  private lpDeltaTimeout: ReturnType<typeof setTimeout> | null = null;

  // Windows-only paths (unused on macOS)
  private psFilePath = 'src/app/data/core-actions/login-action.ps1';
  private nircmdPath = 'src/app/data/core-actions/nircmdc.exe';
  private windowTitle = 'Riot Client';

  constructor() {
    // ── Game timer via effect ────────────────────────────────────────────────
    // The effect re-runs whenever isLive or gameStartedAt change.
    // onCleanup clears the previous interval before starting a new one.
    effect((onCleanup) => {
      const live = this.isLive();
      const startedAt = this.lcuService.liveState().gameStartedAt;

      if (!live || !startedAt) {
        this.gameTimerDisplay.set('');
        return;
      }

      const tick = () => {
        const elapsed = Math.floor((Date.now() - startedAt) / 1000);
        const m = Math.floor(elapsed / 60)
          .toString()
          .padStart(2, '0');
        const s = (elapsed % 60).toString().padStart(2, '0');
        this.gameTimerDisplay.set(`${m}:${s}`);
      };
      tick(); // render immediately, then tick every second
      const intervalId = setInterval(tick, 1000);
      onCleanup(() => {
        clearInterval(intervalId);
        this.gameTimerDisplay.set('');
      });
    });

    // ── LP delta overlay on game end ─────────────────────────────────────────
    this.lcuService.gameEnded$
      .pipe(
        filter((event) => {
          const acc = this.account();
          if (!acc) return false;
          return event.vaultId === (acc.syncId || String(acc.id));
        }),
        takeUntilDestroyed()
      )
      .subscribe((event) => {
        if (event.lpDelta === null) return;
        this.lpDeltaValue.set(event.lpDelta);
        this.lpDeltaWin.set(event.win === true);
        if (this.lpDeltaTimeout !== null) clearTimeout(this.lpDeltaTimeout);
        this.lpDeltaTimeout = setTimeout(() => {
          this.lpDeltaValue.set(null);
          this.lpDeltaTimeout = null;
        }, 4000);
      });
  }

  ngOnDestroy(): void {
    if (this.launchToastTimeout !== null) {
      clearTimeout(this.launchToastTimeout);
      this.launchToastTimeout = null;
    }
    if (this.sessionToastTimeout !== null) {
      clearTimeout(this.sessionToastTimeout);
      this.sessionToastTimeout = null;
    }
    if (this.lpDeltaTimeout !== null) {
      clearTimeout(this.lpDeltaTimeout);
      this.lpDeltaTimeout = null;
    }
  }

  async launchAccount(): Promise<void> {
    const acc = this.account();
    if (!acc || this.isLaunching()) {
      console.warn('No account data provided or already launching');
      return;
    }

    this.launchErrorState.set(false);
    this.showLaunchToast.set(false);

    this.isLaunching.set(true);

    try {
      const launchData: any = {
        account: acc,
        riotClientPath: this.settingsService.getRiotClientPath(),
        windowTitle: this.windowTitle,
      };

      // Only include Windows-specific paths on Windows
      const isMac = navigator.userAgent.toLowerCase().includes('mac');
      if (!isMac) {
        launchData.psFilePath = this.psFilePath;
        launchData.nircmdPath = this.nircmdPath;
      }

      const result = await window.electronAPI.launchAccount(launchData);

      if (result.success) {
        console.log('Account launched successfully');
        this.launchErrorState.set(false);
        this.showLaunchToast.set(false);
        this.recordActivity();
      } else {
        console.error('Launch failed:', result.error);
        this.showLaunchError(result.error || 'Launch failed.');
      }
    } catch (error) {
      console.error(`Error launching account: ${error}`);
      this.showLaunchError('Launch failed due to an unexpected error.');
    } finally {
      setTimeout(() => {
        this.isLaunching.set(false);
      }, 2000);
    }
  }

  async saveSession(): Promise<void> {
    const acc = this.account();
    if (!acc || this.isSavingSession()) {
      return;
    }

    this.showSessionToast.set(false);
    this.sessionToastError.set(false);
    this.isSavingSession.set(true);

    try {
      const result = await window.electronAPI.captureAccountSession({
        account: acc,
        riotClientPath: this.settingsService.getRiotClientPath(),
        relaunch: true,
      });

      if (result.success) {
        this.recordActivity();
        this.showSessionFeedback(
          'Session saved. Riot Client was restarted and should remain signed in for this account.',
          false
        );
      } else {
        this.showSessionFeedback(
          result.error || 'Unable to save session. Make sure Riot Client is logged in first.',
          true
        );
      }
    } catch (error) {
      console.error('Failed to save session snapshot:', error);
      this.showSessionFeedback(
        'Unable to save session. Try again after Riot Client fully opens.',
        true
      );
    } finally {
      this.isSavingSession.set(false);
    }
  }

  private showLaunchError(message: string): void {
    this.launchErrorState.set(true);
    this.launchToastMessage.set(message);
    this.showLaunchToast.set(true);

    if (this.launchToastTimeout !== null) {
      clearTimeout(this.launchToastTimeout);
    }

    this.launchToastTimeout = setTimeout(() => {
      this.launchErrorState.set(false);
      this.showLaunchToast.set(false);
      this.launchToastTimeout = null;
    }, 4200);
  }

  private showSessionFeedback(message: string, isError: boolean): void {
    this.sessionToastMessage.set(message);
    this.sessionToastError.set(isError);
    this.showSessionToast.set(true);

    if (this.sessionToastTimeout !== null) {
      clearTimeout(this.sessionToastTimeout);
    }

    this.sessionToastTimeout = setTimeout(
      () => {
        this.showSessionToast.set(false);
        this.sessionToastTimeout = null;
      },
      isError ? 5200 : 4200
    );
  }

  requestEdit() {
    const acc = this.account();
    if (acc) this.editRequested.emit(acc);
  }

  requestDelete() {
    const acc = this.account();
    if (acc) this.deleteRequested.emit(acc);
  }

  requestRemoveFromFolder() {
    const acc = this.account();
    if (acc) this.removeFromFolderRequested.emit(acc);
  }

  isRefreshOnCooldown(): boolean {
    const acc = this.account();
    if (!acc?.lastRefreshed) return false;
    return Date.now() - acc.lastRefreshed < REFRESH_COOLDOWN_MS;
  }

  getCooldownRemaining(): string {
    const acc = this.account();
    if (!acc?.lastRefreshed) return '';
    const remaining = REFRESH_COOLDOWN_MS - (Date.now() - acc.lastRefreshed);
    if (remaining <= 0) return '';
    const minutes = Math.ceil(remaining / 60000);
    return `${minutes}m`;
  }

  async refreshAccount(): Promise<void> {
    const acc = this.account();
    if (!acc || this.isRefreshing() || this.isRefreshOnCooldown()) return;

    if (!acc.name?.includes('#') || !acc.server) {
      console.warn('Cannot refresh: missing name or server');
      return;
    }

    this.isRefreshing.set(true);

    try {
      const [summonerId, tagline] = acc.name.split('#');

      // Always resolve via Riot ID — avoids Summoner v4 by-PUUID (restricted on dev keys)
      const summoner = await this.riotApiService.getSummonerByRiotId(summonerId, tagline, acc.server);
      const puuid = summoner.puuid;

      // Fetch ranked info
      const rankedInfo = await this.riotApiService.getRankedInfo(puuid, acc.server);
      const soloQueue = rankedInfo?.find(
        (q: { queueType: string }) => q.queueType === 'RANKED_SOLO_5x5'
      );

      // Fetch top mastery champions — highest points first, keep the top 3
      const masteryData = await this.riotApiService.getTopMasteryChampions(puuid, acc.server);
      const topChampionIds = [...(masteryData ?? [])]
        .sort((a, b) => b.championPoints - a.championPoints)
        .slice(0, 3)
        .map((entry) => entry.championId.toString());

      const vaultId = acc.syncId || String(acc.id);

      // Record where this account sits now, then read the series back for the
      // trend. The whole ranked payload goes in: flex history is already paid
      // for by the same request, and wins/losses are what make a day's game
      // count knowable.
      const lpTrend = await this.syncLpTrend(vaultId, rankedInfo);

      // Previous games + most played lane from the cached match history
      const { recentResults, mainLane } = await this.loadMatchDerivedStats(
        vaultId,
        puuid,
        acc.server
      );

      // Create updated account
      const updatedAccount: Account = {
        ...acc,
        id: puuid,
        puuid,
        profileIconId: summoner.profileIconId,
        summonerLevel: summoner.summonerLevel,
        rank: soloQueue ? `${soloQueue.tier} ${soloQueue.rank}` : undefined,
        leaguePoints: soloQueue?.leaguePoints,
        wins: soloQueue?.wins,
        losses: soloQueue?.losses,
        hotStreak: soloQueue?.hotStreak,
        topChampionId: topChampionIds[0] ?? acc.topChampionId,
        topChampionIds: topChampionIds.length ? topChampionIds : acc.topChampionIds,
        lpTrend: lpTrend.length ? lpTrend : acc.lpTrend,
        recentResults: recentResults.length ? recentResults : acc.recentResults,
        mainLane: mainLane ?? acc.mainLane,
        lastRefreshed: Date.now(),
      };

      this.refreshRequested.emit(updatedAccount);
      console.log('Account refreshed successfully:', updatedAccount);
    } catch (error) {
      console.error('Error refreshing account:', error);
    } finally {
      this.isRefreshing.set(false);
    }
  }

  /**
   * Records where the account stands now, then returns the absolute-LP series
   * used to draw the trend line.
   *
   * Two destinations with deliberately different rules:
   *
   * - The daily series takes **every** ranked queue, unconditionally. Its rows
   *   are keyed by day and upsert, so writing on every refresh cannot bloat it,
   *   and writing unconditionally is the point: a day where you went 1W-1L nets
   *   zero LP but is real activity, and the equality check below would throw it
   *   away. That check is why a played-but-flat day used to leave no trace.
   * - `lp_snapshots` keeps the moved-only guard. It is append-only on a raw
   *   timestamp with no day key, so recording every refresh really would grow
   *   it without bound.
   */
  private async syncLpTrend(
    vaultId: string,
    rankedInfo: RankedInfo[] | undefined
  ): Promise<LpTrendPoint[]> {
    const soloQueue = rankedInfo?.find((q) => q.queueType === 'RANKED_SOLO_5x5');

    try {
      for (const entry of rankedInfo ?? []) {
        if (!TRACKED_RANK_QUEUES.includes(entry.queueType)) continue;
        try {
          await window.electronAPI.recordRankSnapshot({
            accountId: vaultId,
            queue: entry.queueType,
            entry,
          });
        } catch (error) {
          // The main process has its own lifetime and may predate this channel.
          // Losing a daily row is not worth failing a card refresh over.
          console.warn('Could not record rank snapshot:', error);
        }
      }

      if (soloQueue) {
        const existing = await window.electronAPI.getLpSnapshots(vaultId);
        const latest = existing?.snapshots?.[existing.snapshots.length - 1];
        const moved =
          !latest ||
          latest.tier !== soloQueue.tier ||
          latest.division !== soloQueue.rank ||
          latest.lp !== soloQueue.leaguePoints;

        if (moved) {
          await window.electronAPI.saveLpSnapshot({
            accountId: vaultId,
            tier: soloQueue.tier,
            division: soloQueue.rank,
            lp: soloQueue.leaguePoints,
          });
        }
      }

      const result = await window.electronAPI.getLpSnapshots(vaultId);
      const cutoff = Date.now() - LP_TREND_WINDOW_MS;

      // Only the 7-day window is ever rendered, so that is all we carry around.
      return (result?.snapshots ?? [])
        .filter((snapshot) => snapshot.timestamp >= cutoff)
        .map((snapshot) => ({ t: snapshot.timestamp, lp: snapshot.absolute_lp }));
    } catch (error) {
      console.error('Error syncing LP trend:', error);
      return [];
    }
  }

  /** Pulls recent ranked games to derive the win/loss strip and most played lane. */
  private async loadMatchDerivedStats(
    vaultId: string,
    puuid: string,
    server: string
  ): Promise<{ recentResults: boolean[]; mainLane: string | undefined }> {
    try {
      const matches = await this.riotApiService.getMatchHistory(vaultId, puuid, server, 10);

      if (!Array.isArray(matches)) {
        return { recentResults: [], mainLane: undefined };
      }

      // Rows come back newest first, which is the order the strip renders in.
      const recentResults = matches
        .filter((match) => match.win !== null)
        .map((match) => match.win === 1);

      const laneCounts = new Map<string, number>();
      for (const match of matches) {
        const position = match.position?.trim();
        if (!position) continue;
        laneCounts.set(position, (laneCounts.get(position) ?? 0) + 1);
      }

      let mainLane: string | undefined;
      let topCount = 0;
      for (const [lane, count] of laneCounts) {
        if (count > topCount) {
          mainLane = lane;
          topCount = count;
        }
      }

      return { recentResults, mainLane };
    } catch (error) {
      console.error('Error loading match-derived stats:', error);
      return { recentResults: [], mainLane: undefined };
    }
  }

  // ── Stat strip ───────────────────────────────────────────────────────────────

  /** Top 3 mastery champions, highest first. Falls back to the single legacy id. */
  masteryChampions = computed(() => {
    const acc = this.account();
    if (!acc) return [];

    const ids = acc.topChampionIds?.length
      ? acc.topChampionIds
      : acc.topChampionId
        ? [acc.topChampionId]
        : [];

    return ids
      .slice(0, 3)
      .map((championKey) => ({
        key: championKey,
        name: this.championCatalog.getChampionId(championKey),
        iconUrl: this.championCatalog.getIconUrl(championKey),
      }))
      .filter((champion) => !!champion.iconUrl);
  });

  /** Previous games, newest first, capped at 8 dots so the strip stays readable. */
  previousGames = computed(() => {
    const results = this.account()?.recentResults;
    if (!results?.length) return [];
    return results.slice(0, 8).map((win) => ({ win }));
  });

  previousGamesRecord = computed(() => {
    const games = this.previousGames();
    const wins = games.filter((game) => game.win).length;
    return { wins, losses: games.length - wins, total: games.length };
  });

  /** Unique per instance so each card's gradient fill resolves to its own def. */
  readonly sparkGradientId = `lv-spark-${sparkInstanceCounter++}`;
  readonly sparkFill = `url(#${this.sparkGradientId})`;

  /** Readings from the last 7 days only, oldest first. */
  private lpTrendWindow = computed<LpTrendPoint[]>(() => {
    const trend = this.account()?.lpTrend;
    if (!Array.isArray(trend)) return [];

    const cutoff = Date.now() - LP_TREND_WINDOW_MS;

    return trend
      .filter(
        (point): point is LpTrendPoint =>
          !!point && typeof point.t === 'number' && typeof point.lp === 'number'
      )
      .filter((point) => point.t >= cutoff)
      .sort((a, b) => a.t - b.t);
  });

  hasLpTrend = computed(() => this.lpTrendWindow().length >= 2);

  /** Readings projected into the SVG viewBox. */
  private sparkCoords = computed(() => {
    const points = this.lpTrendWindow();
    if (points.length < 2) return [];

    const values = points.map((point) => point.lp);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min;
    const innerWidth = SPARK_WIDTH - SPARK_PADDING_X * 2;
    const innerHeight = SPARK_HEIGHT - SPARK_PADDING_Y * 2;
    const midY = SPARK_HEIGHT / 2;

    return values.map((value, index) => ({
      x: SPARK_PADDING_X + (innerWidth * index) / (values.length - 1),
      // A completely flat series has no range to scale against — centre it.
      y: range === 0 ? midY : SPARK_HEIGHT - SPARK_PADDING_Y - (innerHeight * (value - min)) / range,
    }));
  });

  /** Smoothed curve through the readings (Catmull-Rom expressed as beziers). */
  lpLinePath = computed(() => {
    const coords = this.sparkCoords();
    if (coords.length < 2) return '';

    let path = `M ${coords[0].x.toFixed(2)} ${coords[0].y.toFixed(2)}`;

    for (let i = 0; i < coords.length - 1; i++) {
      const previous = coords[i - 1] ?? coords[i];
      const start = coords[i];
      const end = coords[i + 1];
      const next = coords[i + 2] ?? end;

      const c1x = start.x + (end.x - previous.x) * SPARK_TENSION;
      const c1y = start.y + (end.y - previous.y) * SPARK_TENSION;
      const c2x = end.x - (next.x - start.x) * SPARK_TENSION;
      const c2y = end.y - (next.y - start.y) * SPARK_TENSION;

      path +=
        ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)},` +
        ` ${c2x.toFixed(2)} ${c2y.toFixed(2)},` +
        ` ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
    }

    return path;
  });

  /** The same curve closed down to the baseline, for the gradient fill. */
  lpAreaPath = computed(() => {
    const coords = this.sparkCoords();
    const line = this.lpLinePath();
    if (!line || coords.length < 2) return '';

    const first = coords[0];
    const last = coords[coords.length - 1];
    const floor = SPARK_HEIGHT;

    return `${line} L ${last.x.toFixed(2)} ${floor} L ${first.x.toFixed(2)} ${floor} Z`;
  });

  /** Dashed reference line at the LP the window started from. */
  lpBaselineY = computed(() => {
    const coords = this.sparkCoords();
    return coords.length ? coords[0].y : 0;
  });

  sparkWidth = SPARK_WIDTH;
  sparkHeight = SPARK_HEIGHT;
  sparkPaddingX = SPARK_PADDING_X;
  sparkInnerRight = SPARK_WIDTH - SPARK_PADDING_X;

  /** Marker for the most recent reading. */
  lpEndPoint = computed(() => {
    const coords = this.sparkCoords();
    return coords.length ? coords[coords.length - 1] : { x: 0, y: 0 };
  });

  /** Net LP gained or lost across the 7-day window. */
  lpTrendDelta = computed(() => {
    const points = this.lpTrendWindow();
    if (points.length < 2) return 0;
    return points[points.length - 1].lp - points[0].lp;
  });

  lpTrendUp = computed(() => this.lpTrendDelta() >= 0);

  lpTrendLabel = computed(() => {
    const delta = this.lpTrendDelta();
    return `${delta > 0 ? '+' : ''}${delta} LP`;
  });

  /** Tooltip spelling out exactly what the window covers. */
  lpTrendTooltip = computed(() => {
    const points = this.lpTrendWindow();
    if (points.length < 2) return '';
    const readings = `${points.length} readings`;
    return `${this.lpTrendLabel()} over the last 7 days (${readings})`;
  });

  private laneMeta = computed(() => {
    const lane = this.account()?.mainLane?.toUpperCase();
    if (!lane) return null;
    return LANE_META[lane] ?? null;
  });

  hasLane = computed(() => !!this.laneMeta());
  laneLabel = computed(() => this.laneMeta()?.label ?? '');
  laneIconUrl = computed(() => {
    const meta = this.laneMeta();
    return meta ? `${POSITION_ICON_BASE}${meta.slug}.png` : '';
  });

  /** Relative "last active" string from LoL Vault's own usage tracking. */
  lastActiveLabel = computed(() => {
    // Re-evaluates whenever the LCU reports a different active account, which is
    // also when the dashboard stamps a fresh lastActiveAt.
    this.lcuService.liveState();

    const lastActiveAt = this.account()?.lastActiveAt;
    if (!lastActiveAt) return '';

    const elapsed = Date.now() - lastActiveAt;
    if (elapsed < 60_000) return 'just now';

    const minutes = Math.floor(elapsed / 60_000);
    if (minutes < 60) return `${minutes}m ago`;

    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;

    const days = Math.floor(hours / 24);
    if (days === 1) return 'yesterday';
    if (days < 30) return `${days}d ago`;

    const months = Math.floor(days / 30);
    return months < 12 ? `${months}mo ago` : `${Math.floor(months / 12)}y ago`;
  });

  hasStatStrip = computed(
    () =>
      this.hasLane() ||
      this.previousGames().length > 0 ||
      this.masteryChampions().length > 0 ||
      this.hasLpTrend()
  );

  private recordActivity(): void {
    const acc = this.account();
    if (!acc) return;
    this.activityRecorded.emit(acc);
  }

  navigateToAnalytics(): void {
    const acc = this.account();
    if (!acc) return;
    const vaultId = acc.syncId || String(acc.id);
    this.router.navigate(['/analytics', vaultId]);
  }

  getProfileIconUrl(): string {
    return this.riotApiService.getProfileIconUrl(this.account()?.profileIconId);
  }

  getRankName(rank: string | undefined): string {
    if (!rank) return '';
    const base = rank.split(' ')[0]?.trim();
    if (!base) return '';
    return base.charAt(0).toUpperCase() + base.slice(1).toLowerCase();
  }

  getAbbreviatedRank(rank: string | undefined): string {
    if (!rank) return '';
    const parts = rank.split(' ');
    const tier = parts[0]?.toUpperCase();
    const division = parts[1];

    // Special cases for Master, Grandmaster, Challenger
    if (tier === 'MASTER') return 'M';
    if (tier === 'GRANDMASTER') return 'GM';
    if (tier === 'CHALLENGER') return 'C';

    // Regular ranks: PLATINUM II -> P2
    const tierAbbrev = tier?.charAt(0) || '';
    const divisionNum = this.romanToNumber(division);
    return `${tierAbbrev}${divisionNum}`;
  }

  private romanToNumber(roman: string | undefined): string {
    if (!roman) return '';
    const romanMap: Record<string, string> = {
      I: '1',
      II: '2',
      III: '3',
      IV: '4',
    };
    return romanMap[roman] || roman;
  }

  getWinrate(): number {
    const acc = this.account();
    if (!acc?.wins && !acc?.losses) return 0;
    const total = (acc.wins || 0) + (acc.losses || 0);
    if (total === 0) return 0;
    return Math.round(((acc.wins || 0) / total) * 100);
  }

  getTotalGames(): number {
    const acc = this.account();
    return (acc?.wins || 0) + (acc?.losses || 0);
  }

  getSubtitleLabel(): string {
    const acc = this.account();
    if (!acc) return '';

    const username = acc.username?.trim();
    if (username) return username;

    return acc.name?.split('#')[0]?.trim() || 'Unknown';
  }

  getOpGGLink(): string {
    const acc = this.account();
    if (!acc?.name || !acc?.server) return '';
    const [displayName, tag] = acc.name.split('#');
    const serverMap: Record<string, string> = {
      EUW: 'euw',
      EUNE: 'eune',
      NA: 'na',
      KR: 'kr',
      JP: 'jp',
      BR: 'br',
      LAN: 'lan',
      LAS: 'las',
      OCE: 'oce',
      TR: 'tr',
      RU: 'ru',
      PH: 'ph',
      SG: 'sg',
      TH: 'th',
      TW: 'tw',
      VN: 'vn',
    };
    const server = serverMap[acc.server.toUpperCase()] || acc.server.toLowerCase();
    return `https://op.gg/lol/summoners/${server}/${encodeURIComponent(displayName)}-${encodeURIComponent(tag || '')}`;
  }

  openOpGG(event: Event): void {
    event.stopPropagation();
    const link = this.getOpGGLink();
    window.electronAPI.openExternal(link);
  }
}
