/* eslint-disable @typescript-eslint/no-explicit-any */
import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AccCardComponent } from '../../components/acc-card/acc-card.component';
import {
  AddAccountModalComponent,
  Account,
} from '../../components/add-account-modal/add-account-modal.component';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, AccCardComponent, AddAccountModalComponent],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss',
})
export class DashboardComponent {
  public accounts: any[] = [];
  public isModalOpen = false;

  constructor() {
    this.loadAccounts();
  }

  async loadAccounts() {
    try {
      this.accounts = await window.electronAPI.loadAccounts();
    } catch (error) {
      console.error('Error loading accounts:', error);
    }
  }

  addAccount(): void {
    this.isModalOpen = true;
  }

  closeModal(): void {
    this.isModalOpen = false;
  }

  onAccountsAdded(newAccounts: Account[]): void {
    // Add new accounts to the existing accounts array
    this.accounts.push(...newAccounts);

    // Here you would typically save the accounts to the JSON file
    // For now, we'll just update the local array
    console.log('New accounts added:', newAccounts);

    // TODO: Implement saving to accounts.json file via Electron API
    // await window.electronAPI.saveAccounts(this.accounts);
  }
}
