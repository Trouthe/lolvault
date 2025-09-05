/* eslint-disable @typescript-eslint/no-explicit-any */
import { Component, input } from '@angular/core';

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
  imports: [],
  templateUrl: './acc-card.component.html',
  styleUrl: './acc-card.component.scss',
})
export class AccCardComponent {
  account = input<any>();

  private psFilePath = 'src/app/data/core-actions/login-action.ps1';
  private nircmdPath = 'src/app/data/core-actions/nircmdc.exe';
  private riotClientPath = 'C:\\Riot Games\\Riot Client\\RiotClientServices.exe';
  private windowTitle = 'Riot Client';

  async launchAccount(): Promise<void> {
    if (!this.account) {
      console.warn('No account data provided');
      return;
    }

    try {
      await window.electronAPI.launchAccount({
        account: this.account,
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
