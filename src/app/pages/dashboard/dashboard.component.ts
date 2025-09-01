/* eslint-disable @typescript-eslint/no-explicit-any */
import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';

// Declare the electronAPI that will be available via preload script
declare global {
  interface Window {
    electronAPI: {
      launchAccount: (accountData: any) => Promise<any>;
      loadAccounts: () => Promise<any[]>;
    };
  }
}

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss',
})
export class DashboardComponent {
  public accounts: any[] = [];
  private psFilePath = 'src/app/data/core-actions/login-action.ps1';
  private nircmdPath = 'src/app/data/core-actions/nircmdc.exe';
  private riotClientPath = 'C:\\Riot Games\\Riot Client\\RiotClientServices.exe';
  private windowTitle = 'Riot Client';

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

  async loginWithAccount(id: number): Promise<void> {
    const account = this.accounts.find((acc) => acc.id === id);
    if (!account) {
      console.warn(`Account with ID ${id} not found`);
      return;
    }

    try {
      await window.electronAPI.launchAccount({
        account,
        riotClientPath: this.riotClientPath,
        psFilePath: this.psFilePath,
        nircmdPath: this.nircmdPath,
        windowTitle: this.windowTitle,
      });
    } catch (error) {
      console.error(`Error launching account: ${error}`);
    }
  }
}
