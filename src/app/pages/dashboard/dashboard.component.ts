import { Component } from '@angular/core';
import { signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AccCardComponent } from '../../components/acc-card/acc-card.component';
import { AddAccountModalComponent } from '../../components/add-account-modal/add-account-modal.component';
import { Account } from '../../models/interfaces/Account';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, AccCardComponent, AddAccountModalComponent],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss',
})
export class DashboardComponent {
  public accounts = signal<Account[]>([]);
  public isModalOpen = signal(false);

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
}
