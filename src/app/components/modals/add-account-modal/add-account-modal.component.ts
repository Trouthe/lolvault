import { Component, inject } from '@angular/core';
import { input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { LOL_DATA } from '../../../models/constants';
import { Account } from '../../../models/interfaces/Account';
import { RiotService } from '../../../services/riot.service';

@Component({
  selector: 'app-add-account-modal',
  imports: [CommonModule, FormsModule],
  templateUrl: './add-account-modal.component.html',
  styleUrl: './add-account-modal.component.scss',
})
export class AddAccountModalComponent {
  private riotService = inject(RiotService);

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
    displayName: '',
    tag: '',
    server: '',
  });

  setActiveTab(tab: 'single' | 'bulk') {
    this.activeTab.set(tab);
  }

  close() {
    this.resetForm();
    this.closeModal.emit();
  }

  async addSingleAccount() {
    const acc = this.singleAccount();
    if (!acc.username || !acc.password || !acc.displayName || !acc.tag || !acc.server) {
      return;
    }

    // Combine displayName and tag with #
    const fullName = `${acc.displayName}#${acc.tag}`;

    // Fetch PUUID and ranked info
    let puuid: string | undefined;
    let fetchedRank: string | undefined;

    try {
      puuid = await this.riotService.getPUUID(acc.displayName, acc.tag, acc.server);
      console.log('Fetched PUUID:', puuid);

      // Fetch ranked info
      const rankedInfo = await this.riotService.getRankedInfo(puuid, acc.server);
      if (rankedInfo && rankedInfo.length > 0) {
        // Find RANKED_SOLO_5x5 queue
        const soloQueue = rankedInfo.find(
          (q: { queueType: string }) => q.queueType === 'RANKED_SOLO_5x5'
        );
        if (soloQueue) {
          fetchedRank = `${soloQueue.tier} ${soloQueue.rank}`;
          console.log('Fetched rank:', fetchedRank);
        }
      }
    } catch (error) {
      console.error('Error fetching Riot data:', error);
    }

    const account: Account = {
      id: puuid || Date.now(),
      name: fullName,
      username: acc.username,
      password: acc.password,
      game: 'League of Legends',
      server: acc.server,
      rank: fetchedRank,
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
    const lines = bulkText.split('\n');
    const accounts: Account[] = [];
    lines.forEach((line) => {
      const parts = line.split(':').map((p) => p.trim());
      if (parts.length >= 2) {
        const [username, password, name, server] = parts;
        if (username && password) {
          const account: Account = {
            id: Date.now() + Math.random(),
            name: name || username,
            username: username,
            password: password,
            game: 'League of Legends',
            server: server || undefined,
          };
          accounts.push(account);
        }
      }
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
      displayName: '',
      tag: '',
      server: '',
    });
    this.bulkAccountsText.set('');
  }
}
