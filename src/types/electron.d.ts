import { Account } from '../app/components/modals/add-account-modal/add-account-modal.component';

export interface LaunchAccountData {
  account: Account;
  riotClientPath: string;
  psFilePath: string;
  nircmdPath: string;
  windowTitle: string;
}

export interface LaunchResult {
  success: boolean;
  error?: string;
}

export interface ElectronAPI {
  launchAccount: (accountData: LaunchAccountData) => Promise<LaunchResult>;
  loadAccounts: () => Promise<Account[]>;
  saveAccounts: (accounts: Account[]) => Promise<{ success: boolean; error?: string }>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
