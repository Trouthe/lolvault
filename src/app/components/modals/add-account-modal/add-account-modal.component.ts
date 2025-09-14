import { Component } from '@angular/core';
import { input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { LOL_DATA } from '../../../models/constants';
import { Account } from '../../../models/interfaces/Account';

@Component({
  selector: 'app-add-account-modal',
  imports: [CommonModule, FormsModule],
  templateUrl: './add-account-modal.component.html',
  styleUrl: './add-account-modal.component.scss',
})
export class AddAccountModalComponent {
  isOpen = input<boolean>(false);
  closeModal = output<void>();
  accountsAdded = output<Account[]>();

  activeTab = signal<'single' | 'bulk'>('single');

  servers = LOL_DATA.SERVERS;
  ranks = LOL_DATA.RANKS;

  // Forms
  bulkAccountsText = signal('');
  singleAccount = signal({
    username: '',
    password: '',
    displayName: '',
    server: '',
    rank: '',
  });

  setActiveTab(tab: 'single' | 'bulk') {
    this.activeTab.set(tab);
  }

  close() {
    this.resetForm();
    this.closeModal.emit();
  }

  addSingleAccount() {
    const acc = this.singleAccount();
    if (!acc.username || !acc.password) {
      return;
    }
    const account: Account = {
      id: Date.now(),
      name: acc.displayName || acc.username,
      username: acc.username,
      password: acc.password,
      game: 'League of Legends',
      server: acc.server || undefined,
      rank: acc.rank || undefined,
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
        const [username, password, name, server, rank] = parts;
        if (username && password) {
          const account: Account = {
            id: Date.now() + Math.random(),
            name: name || username,
            username: username,
            password: password,
            game: 'League of Legends',
            server: server || undefined,
            rank: rank || undefined,
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
      server: '',
      rank: '',
    });
    this.bulkAccountsText.set('');
  }
}
