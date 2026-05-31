/* eslint-disable @typescript-eslint/no-explicit-any */
import { Component, OnDestroy, input, output, signal, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Account } from '../../models/interfaces/Account';
import { SettingsService } from '../../services/settings.service';
import { RiotService } from '../../services/riot.service';

const REFRESH_COOLDOWN_MS = 3 * 60 * 1000; // 3 minutes

@Component({
  selector: 'app-acc-card',
  imports: [CommonModule],
  templateUrl: './acc-card.component.html',
  styleUrl: './acc-card.component.scss',
})
export class AccCardComponent implements OnDestroy {
  account = input<Account>();
  showRemoveFromFolder = input<boolean>(false);
  editRequested = output<Account>();
  deleteRequested = output<Account>();
  removeFromFolderRequested = output<Account>();
  refreshRequested = output<Account>();

  settingsService = inject(SettingsService);
  private riotService = inject(RiotService);

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

  // Windows-only paths (unused on macOS)
  private psFilePath = 'src/app/data/core-actions/login-action.ps1';
  private nircmdPath = 'src/app/data/core-actions/nircmdc.exe';
  private windowTitle = 'Riot Client';

  ngOnDestroy(): void {
    if (this.launchToastTimeout !== null) {
      clearTimeout(this.launchToastTimeout);
      this.launchToastTimeout = null;
    }

    if (this.sessionToastTimeout !== null) {
      clearTimeout(this.sessionToastTimeout);
      this.sessionToastTimeout = null;
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
      this.showSessionFeedback('Unable to save session. Try again after Riot Client fully opens.', true);
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

    this.sessionToastTimeout = setTimeout(() => {
      this.showSessionToast.set(false);
      this.sessionToastTimeout = null;
    }, isError ? 5200 : 4200);
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
      let puuid = acc.id as string;

      // Fetch PUUID if needed
      if (typeof acc.id !== 'string' || acc.id.length <= 20) {
        puuid = await this.riotService.getPUUID(summonerId, tagline, acc.server);
      }

      // Fetch basic account info
      const basicInfo = await this.riotService.getBasicAccountInfo(puuid, acc.server);

      // Fetch ranked info
      const rankedInfo = await this.riotService.getRankedInfo(puuid, acc.server);
      const soloQueue = rankedInfo?.find(
        (q: { queueType: string }) => q.queueType === 'RANKED_SOLO_5x5'
      );

      // Fetch top mastery champions
      const masteryData = await this.riotService.getTopMasteryChampions(puuid, acc.server);
      let topChampionId: string | undefined;
      if (masteryData?.length) {
        const top = masteryData.reduce((a, b) => (b.championLevel > a.championLevel ? b : a));
        topChampionId = top.championId.toString();
      }

      // Create updated account
      const updatedAccount: Account = {
        ...acc,
        id: puuid,
        profileIconId: basicInfo?.profileIconId,
        summonerLevel: basicInfo?.summonerLevel,
        rank: soloQueue ? `${soloQueue.tier} ${soloQueue.rank}` : undefined,
        leaguePoints: soloQueue?.leaguePoints,
        wins: soloQueue?.wins,
        losses: soloQueue?.losses,
        hotStreak: soloQueue?.hotStreak,
        topChampionId,
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
