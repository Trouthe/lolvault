/* eslint-disable @typescript-eslint/no-explicit-any */
import { Component, input, output, signal, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Account } from '../../models/interfaces/Account';
import { DeleteAccountModalComponent } from '../modals/delete-account-modal/delete-account-modal.component';
import { EditAccountModalComponent } from '../modals/edit-account-modal/edit-account-modal.component';
import { SettingsService } from '../../services/settings.service';

// Declare the electronAPI that will be available via preload script
declare global {
  interface Window {
    electronAPI: {
      launchAccount: (accountData: any) => Promise<any>;
      loadAccounts: () => Promise<any[]>;
      saveAccounts: (accounts: any[]) => Promise<{ success: boolean; error?: string }>;
    };
  }
}

@Component({
  selector: 'app-acc-card',
  imports: [CommonModule, DeleteAccountModalComponent, EditAccountModalComponent],
  templateUrl: './acc-card.component.html',
  styleUrl: './acc-card.component.scss',
})
export class AccCardComponent {
  account = input<Account>();
  accountUpdated = output<Account>();
  accountDeleted = output<Account>();

  settingsService = inject(SettingsService);

  // Modal states
  isDeleteModalOpen = signal(false);
  isEditModalOpen = signal(false);
  isLaunching = signal(false);

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

  openEditModal() {
    this.isEditModalOpen.set(true);
  }

  openDeleteModal() {
    this.isDeleteModalOpen.set(true);
  }

  closeEditModal() {
    this.isEditModalOpen.set(false);
  }

  closeDeleteModal() {
    this.isDeleteModalOpen.set(false);
  }

  onAccountUpdated(updatedAccount: Account) {
    this.accountUpdated.emit(updatedAccount);
  }

  onAccountDeleted(deletedAccount: Account) {
    this.accountDeleted.emit(deletedAccount);
  }

  getRankName(rank: string | undefined): string {
    if (!rank) return '';
    const base = rank.split(' ')[0]?.trim();
    if (!base) return '';
    return base.charAt(0).toUpperCase() + base.slice(1).toLowerCase();
  }
}
