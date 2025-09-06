import { Component } from '@angular/core';
import { signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AccCardComponent } from '../../components/acc-card/acc-card.component';
import { AddAccountModalComponent } from '../../components/modals/add-account-modal/add-account-modal.component';
import { SettingsModalComponent } from '../../components/modals/settings-modal/settings-modal.component';
import { Account } from '../../models/interfaces/Account';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    AccCardComponent,
    AddAccountModalComponent,
    SettingsModalComponent,
  ],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss',
})
export class DashboardComponent {
  public accounts = signal<Account[]>([]);
  public isModalOpen = signal(false);
  public isSettingsOpen = signal(false);
  private _searchQuery = signal('');
  public searchQuery = '';

  // Computed property for filtered accounts
  public filteredAccounts = computed(() => {
    const query = this._searchQuery().toLowerCase().trim();
    if (!query) {
      return this.accounts();
    }

    return this.accounts().filter(
      (account) =>
        account.name?.toLowerCase().includes(query) ||
        account.username?.toLowerCase().includes(query) ||
        account.server?.toLowerCase().includes(query) ||
        account.rank?.toLowerCase().includes(query) ||
        account.game?.toLowerCase().includes(query)
    );
  });

  // Update search signal when searchQuery changes
  updateSearch() {
    this._searchQuery.set(this.searchQuery);
  }

  constructor() {
    this.loadAccounts();
  }

  async loadAccounts() {
    try {
      const loadedAccounts = await window.electronAPI.loadAccounts();
      this.accounts.set(loadedAccounts);
    } catch (error) {
      console.error('Error loading accounts:', error);
    }
  }

  addAccount(): void {
    this.isModalOpen.set(true);
  }

  closeModal(): void {
    this.isModalOpen.set(false);
  }

  openSettings(): void {
    this.isSettingsOpen.set(true);
  }

  closeSettings(): void {
    this.isSettingsOpen.set(false);
  }

  onSearchChange(query: string): void {
    this._searchQuery.set(query);
  }

  async onAccountsAdded(newAccounts: Account[]): Promise<void> {
    // Add new accounts to the existing accounts array
    const updatedAccounts = [...this.accounts(), ...newAccounts];
    this.accounts.set(updatedAccounts);

    // Save the accounts to the JSON file via Electron API
    try {
      const result = await window.electronAPI.saveAccounts(updatedAccounts);
      if (result.success) {
        console.log('Accounts saved successfully');
      } else {
        console.error('Error saving accounts:', result.error);
      }
    } catch (error) {
      console.error('Error saving accounts:', error);
    }
  }

  async onAccountUpdated(updatedAccount: Account): Promise<void> {
    // Update the specific account in the array
    const currentAccounts = this.accounts();
    const updatedAccounts = currentAccounts.map((acc) =>
      acc.id === updatedAccount.id ? updatedAccount : acc
    );
    this.accounts.set(updatedAccounts);

    // Save the accounts to the JSON file via Electron API
    try {
      const result = await window.electronAPI.saveAccounts(updatedAccounts);
      if (result.success) {
        console.log('Account updated successfully');
      } else {
        console.error('Error updating account:', result.error);
      }
    } catch (error) {
      console.error('Error updating account:', error);
    }
  }

  async onAccountDeleted(deletedAccount: Account): Promise<void> {
    // Remove the account from the array
    const currentAccounts = this.accounts();
    const updatedAccounts = currentAccounts.filter((acc) => acc.id !== deletedAccount.id);
    this.accounts.set(updatedAccounts);

    // Save the accounts to the JSON file via Electron API
    try {
      const result = await window.electronAPI.saveAccounts(updatedAccounts);
      if (result.success) {
        console.log('Account deleted successfully');
      } else {
        console.error('Error deleting account:', result.error);
      }
    } catch (error) {
      console.error('Error deleting account:', error);
    }
  }
}
