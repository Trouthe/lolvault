import { Account } from '../app/components/modals/add-account-modal/add-account-modal.component';
import { Board } from '../app/models/interfaces/Board';

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
  loadBoards: () => Promise<Board[]>;
  saveBoards: (boards: Board[]) => Promise<{ success: boolean; error?: string }>;
  openFilePicker: (options?: {
    title?: string;
    defaultPath?: string;
  }) => Promise<{ canceled: boolean; filePaths: string[] }>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
