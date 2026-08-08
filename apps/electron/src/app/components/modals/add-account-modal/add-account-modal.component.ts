import { Component, OnDestroy, inject } from '@angular/core';
import { input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { LOL_DATA } from '../../../models/constants';
import { Account } from '../../../models/interfaces/Account';
import { RiotApiService } from '../../../services/riot-api.service';
import { SettingsService } from '../../../services/settings.service';

@Component({
  selector: 'app-add-account-modal',
  imports: [CommonModule, FormsModule],
  templateUrl: './add-account-modal.component.html',
  styleUrl: './add-account-modal.component.scss',
})
export class AddAccountModalComponent implements OnDestroy {
  private riotApiService = inject(RiotApiService);
  private settingsService = inject(SettingsService);

  isOpen = input<boolean>(false);
  closeModal = output<void>();
  accountsAdded = output<Account[]>();

  activeTab = signal<'single' | 'bulk'>('single');

  servers = LOL_DATA.SERVERS;

  // Forms
  bulkAccountsText = signal('');
  singleAccount = signal({
    username: '',
    password: '',
    riotId: '',
    server: '',
  });
  isOpeningCleanClient = signal(false);
  cleanClientNotice = signal('');
  cleanClientNoticeError = signal(false);
  private cleanClientNoticeTimeout: ReturnType<typeof setTimeout> | null = null;

  ngOnDestroy(): void {
    if (this.cleanClientNoticeTimeout !== null) {
      clearTimeout(this.cleanClientNoticeTimeout);
      this.cleanClientNoticeTimeout = null;
    }
  }

  setActiveTab(tab: 'single' | 'bulk') {
    this.activeTab.set(tab);
  }

  hasSingleFormCredentialWarning(): boolean {
    const account = this.singleAccount();
    return !account.username.trim() || !account.password.trim();
  }

  isRiotIdInvalid(): boolean {
    const riotId = this.singleAccount().riotId.trim();
    return riotId.length > 0 && !this.parseRiotId(riotId);
  }

  close() {
    this.resetForm();
    this.closeModal.emit();
  }

  async openCleanRiotClient(): Promise<void> {
    if (this.isOpeningCleanClient()) {
      return;
    }

    this.isOpeningCleanClient.set(true);

    try {
      const result = await window.electronAPI.openCleanRiotClient({
        riotClientPath: this.settingsService.getRiotClientPath(),
      });

      if (result.success) {
        this.showCleanClientNotice(
          'Opened Riot Client with a clean profile. Log in to the next account, then click Save Session on its card.',
          false
        );
      } else {
        this.showCleanClientNotice(result.error || 'Unable to open clean Riot Client.', true);
      }
    } catch (error) {
      console.error('Failed to open clean Riot Client:', error);
      this.showCleanClientNotice('Unable to open clean Riot Client right now.', true);
    } finally {
      this.isOpeningCleanClient.set(false);
    }
  }

  async addSingleAccount() {
    const acc = this.singleAccount();
    const parsedRiotId = this.parseRiotId(acc.riotId);

    if (!parsedRiotId || !acc.server) {
      return;
    }

    const username = acc.username.trim();
    const password = acc.password.trim();

    const fullName = `${parsedRiotId.displayName}#${parsedRiotId.tag}`;

    // Fetch PUUID and ranked info
    let puuid: string | undefined;
    let fetchedRank: string | undefined;
    let profileIconId: number | undefined;
    let summonerLevel: number | undefined;
    let leaguePoints: number | undefined;
    let wins: number | undefined;
    let losses: number | undefined;
    let hotStreak: boolean | undefined;

    try {
      puuid = await this.riotApiService.getPUUID(
        parsedRiotId.displayName,
        parsedRiotId.tag,
        acc.server
      );
      console.log('Fetched PUUID:', puuid);

      // Fetch basic account info (profile icon and level)
      const basicInfo = await this.riotApiService.getBasicAccountInfo(puuid, acc.server);
      if (basicInfo) {
        profileIconId = basicInfo.profileIconId;
        summonerLevel = basicInfo.summonerLevel;
        console.log('Fetched basic info:', { profileIconId, summonerLevel });
      }

      // Fetch ranked info
      const rankedInfo = await this.riotApiService.getRankedInfo(puuid, acc.server);
      if (rankedInfo && rankedInfo.length > 0) {
        // Find RANKED_SOLO_5x5 queue
        const soloQueue = rankedInfo.find(
          (q: { queueType: string }) => q.queueType === 'RANKED_SOLO_5x5'
        );
        if (soloQueue) {
          fetchedRank = `${soloQueue.tier} ${soloQueue.rank}`;
          leaguePoints = soloQueue.leaguePoints;
          wins = soloQueue.wins;
          losses = soloQueue.losses;
          hotStreak = soloQueue.hotStreak;
        }
      }
    } catch (error) {
      console.error('Error fetching Riot data:', error);
    }

    const account: Account = {
      id: puuid || Date.now(),
      name: fullName,
      username: username || undefined,
      password: password || undefined,
      game: 'League of Legends',
      server: acc.server,
      rank: fetchedRank,
      profileIconId,
      summonerLevel,
      leaguePoints,
      wins,
      losses,
      hotStreak,
      lastRefreshed: Date.now(),
    };
    this.accountsAdded.emit([account]);
    this.resetForm();
    this.close();
  }

  importBulkAccounts() {
    const bulkText = this.bulkAccountsText().trim();
    if (!bulkText) {
      return;
    }

    const lines = bulkText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const accounts: Account[] = [];
    lines.forEach((line) => {
      const parts = line.split(':').map((p) => p.trim());

      if (!parts.length) {
        return;
      }

      let username = '';
      let password = '';
      let name = '';
      let server = '';
      let rank = '';

      if (parts[0].includes('#')) {
        [name, server, rank] = parts;
      } else {
        [username, password, name, server, rank] = parts;
      }

      if (!name) {
        return;
      }

      const account: Account = {
        id: Date.now() + Math.random(),
        name,
        username: username || undefined,
        password: password || undefined,
        game: 'League of Legends',
        server: server || undefined,
        rank: rank || undefined,
      };

      accounts.push(account);
    });

    if (accounts.length > 0) {
      this.accountsAdded.emit(accounts);
      this.resetForm();
      this.close();
    }
  }

  private resetForm() {
    this.singleAccount.set({
      username: '',
      password: '',
      riotId: '',
      server: '',
    });
    this.bulkAccountsText.set('');
  }

  private showCleanClientNotice(message: string, isError: boolean): void {
    this.cleanClientNotice.set(message);
    this.cleanClientNoticeError.set(isError);

    if (this.cleanClientNoticeTimeout !== null) {
      clearTimeout(this.cleanClientNoticeTimeout);
    }

    this.cleanClientNoticeTimeout = setTimeout(
      () => {
        this.cleanClientNotice.set('');
        this.cleanClientNoticeError.set(false);
        this.cleanClientNoticeTimeout = null;
      },
      isError ? 5200 : 4500
    );
  }

  private parseRiotId(input: string): { displayName: string; tag: string } | null {
    const trimmed = input.trim();
    const separatorIndex = trimmed.lastIndexOf('#');
    if (separatorIndex <= 0 || separatorIndex >= trimmed.length - 1) {
      return null;
    }

    const displayName = trimmed.slice(0, separatorIndex).trim();
    const tag = trimmed.slice(separatorIndex + 1).trim();
    if (!displayName || !tag) {
      return null;
    }

    return { displayName, tag };
  }
}
