import { Account } from '../app/components/modals/add-account-modal/add-account-modal.component';
import { Board } from '../app/models/interfaces/Board';

export interface LaunchAccountData {
  account: Account;
  riotClientPath: string;
  psFilePath?: string;
  nircmdPath?: string;
  windowTitle: string;
}

export interface LaunchResult {
  success: boolean;
  error?: string;
  warning?: string;
}

export interface GoogleSystemSignInOptions {
  apiKey: string;
}

export interface GoogleSystemSignInResult {
  success: boolean;
  idToken?: string;
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
  getPlatform: () => Promise<string>;
  startGoogleSystemSignIn: (
    options: GoogleSystemSignInOptions
  ) => Promise<GoogleSystemSignInResult>;

  // Auto-update
  onUpdateAvailable: (callback: (version: string) => void) => void;
  onUpdateProgress: (callback: (percent: number) => void) => void;
  onUpdateDownloaded: (callback: () => void) => void;
  onUpdateError: (callback: (message: string) => void) => void;
  startUpdateDownload: () => Promise<void>;
  installUpdate: () => Promise<void>;
  checkForUpdates: () => Promise<void>;
}
