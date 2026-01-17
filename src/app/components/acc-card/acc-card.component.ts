/* eslint-disable @typescript-eslint/no-explicit-any */
import { Component, input, output, signal, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Account } from '../../models/interfaces/Account';
import { Board } from '../../models/interfaces/Board';
import { SettingsService } from '../../services/settings.service';
import { RiotService } from '../../services/riot.service';

// Declare the electronAPI that will be available via preload script
declare global {
  interface Window {
    electronAPI: {
      launchAccount: (accountData: any) => Promise<any>;
      loadAccounts: () => Promise<any[]>;
      saveAccounts: (accounts: any[]) => Promise<{ success: boolean; error?: string }>;
      loadBoards: () => Promise<Board[]>;
      saveBoards: (boards: Board[]) => Promise<{ success: boolean; error?: string }>;
    };
  }
}

const REFRESH_COOLDOWN_MS = 3 * 60 * 1000; // 3 minutes

@Component({
  selector: 'app-acc-card',
  imports: [CommonModule],
  templateUrl: './acc-card.component.html',
  styleUrl: './acc-card.component.scss',
})
export class AccCardComponent {
  account = input<Account>();
  showRemoveFromFolder = input<boolean>(false);
  editRequested = output<Account>();
  deleteRequested = output<Account>();
  removeFromFolderRequested = output<Account>();
  refreshRequested = output<Account>();

  settingsService = inject(SettingsService);
  private riotService = inject(RiotService);

  isLaunching = signal(false);
  isRefreshing = signal(false);

  private psFilePath = 'src/app/data/core-actions/login-action.ps1';
  private nircmdPath = 'src/app/data/core-actions/nircmdc.exe';
  private windowTitle = 'Riot Client';

  async launchAccount(): Promise<void> {
    const acc = this.account();
    if (!acc || this.isLaunching()) {
      console.warn('No account data provided or already launching');
      return;
    }

    this.isLaunching.set(true);

    try {
      const result = await window.electronAPI.launchAccount({
        account: acc,
        riotClientPath: this.settingsService.getRiotClientPath(),
        psFilePath: this.psFilePath,
        nircmdPath: this.nircmdPath,
        windowTitle: this.windowTitle,
      });

      if (result.success) {
        console.log('Account launched successfully');
      } else {
        console.error('Launch failed:', result.error);
      }
    } catch (error) {
      console.error(`Error launching account: ${error}`);
    } finally {
      setTimeout(() => {
        this.isLaunching.set(false);
      }, 2000);
    }
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
    if (!acc || this.isRefreshing() || this.isRefreshOnCooldown()) {
      return;
    }

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
}
