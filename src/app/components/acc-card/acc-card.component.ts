/* eslint-disable @typescript-eslint/no-explicit-any */
import { Component, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Account } from '../../models/interfaces/Account';
import { DeleteAccountModalComponent } from '../delete-account-modal/delete-account-modal.component';
import { EditAccountModalComponent } from '../edit-account-modal/edit-account-modal.component';

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

  // Modal states
  isDeleteModalOpen = signal(false);
  isEditModalOpen = signal(false);

  private psFilePath = 'src/app/data/core-actions/login-action.ps1';
  private nircmdPath = 'src/app/data/core-actions/nircmdc.exe';
  private riotClientPath = 'C:\\Riot Games\\Riot Client\\RiotClientServices.exe';
  private windowTitle = 'Riot Client';

  async launchAccount(): Promise<void> {
    const acc = this.account();
    if (!acc) {
      console.warn('No account data provided');
      return;
    }

    try {
      await window.electronAPI.launchAccount({
        account: acc,
        riotClientPath: this.riotClientPath,
        psFilePath: this.psFilePath,
        nircmdPath: this.nircmdPath,
        windowTitle: this.windowTitle,
      });
    } catch (error) {
      console.error(`Error launching account: ${error}`);
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
}
