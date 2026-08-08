import { Account } from '../app/models/interfaces/Account';
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

export interface CaptureAccountSessionPayload {
  account: Account;
  riotClientPath?: string;
  relaunch?: boolean;
}

export interface CaptureAccountSessionResult {
  success: boolean;
  error?: string;
  capturedAt?: number;
  relaunched?: boolean;
}

export interface OpenCleanRiotClientPayload {
  riotClientPath: string;
}

export interface GoogleSystemSignInOptions {
  apiKey: string;
}

export interface GoogleSystemSignInResult {
  success: boolean;
  idToken?: string;
  error?: string;
}

export interface LeagueConfigFile {
  path: string;
  name: string;
  readOnly: boolean;
}

export interface InspectLeagueConfigResult {
  success: boolean;
  error?: string;
  exists?: boolean;
  files?: LeagueConfigFile[];
  readOnly?: boolean;
}

export interface SetLeagueConfigReadOnlyResult {
  success: boolean;
  error?: string;
  warning?: string;
  readOnly?: boolean;
  files?: string[];
  failed?: string[];
}

export interface ElectronAPI {
  launchAccount: (accountData: LaunchAccountData) => Promise<LaunchResult>;
  captureAccountSession: (
    payload: CaptureAccountSessionPayload
  ) => Promise<CaptureAccountSessionResult>;
  openCleanRiotClient: (payload: OpenCleanRiotClientPayload) => Promise<LaunchResult>;
  loadAccounts: () => Promise<Account[]>;
  saveAccounts: (accounts: Account[]) => Promise<{ success: boolean; error?: string }>;
  loadBoards: () => Promise<Board[]>;
  saveBoards: (boards: Board[]) => Promise<{ success: boolean; error?: string }>;
  openFilePicker: (options?: {
    title?: string;
    defaultPath?: string;
  }) => Promise<{ canceled: boolean; filePaths: string[] }>;
  openDirectoryPicker: (options?: {
    title?: string;
    defaultPath?: string;
  }) => Promise<{ canceled: boolean; filePaths: string[] }>;
  openExternal: (url: string) => void;
  getPlatform: () => Promise<string>;
  startGoogleSystemSignIn: (
    options: GoogleSystemSignInOptions
  ) => Promise<GoogleSystemSignInResult>;

  // Persistent game settings (League config read-only lock)
  inspectLeagueConfig: (payload: { configPath: string }) => Promise<InspectLeagueConfigResult>;
  setLeagueConfigReadOnly: (payload: {
    configPath: string;
    readOnly: boolean;
  }) => Promise<SetLeagueConfigReadOnlyResult>;

  // Auto-update
  onUpdateAvailable: (callback: (version: string) => void) => void;
  onUpdateProgress: (callback: (percent: number) => void) => void;
  onUpdateDownloaded: (callback: () => void) => void;
  onUpdateError: (callback: (message: string) => void) => void;
  startUpdateDownload: () => Promise<void>;
  installUpdate: () => Promise<void>;
  checkForUpdates: () => Promise<void>;

  // SQLite — App Settings
  getApiKey: () => Promise<{ success: boolean; value: string | null }>;
  setApiKey: (key: string | null) => Promise<{ success: boolean; error?: string }>;
  getSetting: (key: string) => Promise<{ success: boolean; value: string | null }>;
  setSetting: (key: string, value: string | null) => Promise<{ success: boolean; error?: string }>;

  // SQLite — LP Snapshots
  getLpSnapshots: (accountId: string) => Promise<{ success: boolean; snapshots: LpSnapshot[] }>;
  saveLpSnapshot: (data: {
    accountId: string;
    tier: string;
    division: string;
    lp: number;
  }) => Promise<{ success: boolean; error?: string }>;

  // SQLite — Match Cache
  getMatchCache: (
    accountId: string,
    limit?: number
  ) => Promise<{ success: boolean; matches: MatchCacheRow[] }>;
  saveMatch: (data: {
    matchId: string;
    accountId: string;
    computed: { csPerMin?: number; damageShare?: number; lpDelta?: number };
    rawJson: unknown;
  }) => Promise<{ success: boolean; error?: string }>;

  // Riot API
  riotGetSummonerByRiotId: (args: {
    gameName: string;
    tagLine: string;
    platform: string;
  }) => Promise<{
    puuid: string;
    summonerId: string;
    accountId: string;
    profileIconId: number;
    summonerLevel: number;
    gameName: string;
    tagLine: string;
  } | { error: string } | null>;

  riotGetSummonerByPuuid: (args: { puuid: string; platform: string }) => Promise<{
    id: string;
    accountId: string;
    puuid: string;
    profileIconId: number;
    summonerLevel: number;
  } | { error: string } | null>;

  riotGetRankedByPuuid: (args: { puuid: string; platform: string }) => Promise<
    Array<{
      queueType: string;
      tier: string;
      rank: string;
      leaguePoints: number;
      wins: number;
      losses: number;
      hotStreak: boolean;
    }> | { error: string }
  >;

  riotGetTopMastery: (args: { puuid: string; platform: string }) => Promise<
    Array<{
      puuid: string;
      championId: number;
      championLevel: number;
      championPoints: number;
    }> | { error: string }
  >;

  riotGetMatchHistory: (args: {
    accountId: string;
    puuid: string;
    platform: string;
    count?: number;
  }) => Promise<MatchCacheRow[] | { error: string }>;

  riotGetCachedMatches: (args: { accountId: string; limit?: number }) => Promise<MatchCacheRow[]>;

  riotValidateKey: (args: { key: string }) => Promise<
    { valid: true; reason?: string } | { valid: false; reason: string } | { error: string }
  >;

  riotSaveKey: (args: { key: string | null }) => Promise<{ success: boolean; error?: string }>;

  riotGetDDragonVersion: () => Promise<string>;

  // LCU Monitor — pull current state (handles race condition on startup)
  getLcuState: () => Promise<{
    activeVaultId: string | null;
    puuid: string | null;
    phase: string;
    displayName: string | null;
  }>;

  // LCU Monitor events (main → renderer, one-way push)
  onLcuAccountIdentified: (
    callback: (data: { vaultId: string; puuid: string; displayName: string }) => void
  ) => void;
  onLcuAccountUnrecognized: (callback: (data: { displayName: string }) => void) => void;
  onLcuPhaseChange: (callback: (data: { vaultId: string; phase: string }) => void) => void;
  onLcuGameEnded: (
    callback: (data: {
      vaultId: string;
      win: boolean | null;
      lpDelta: number | null;
      newTier: string;
      newDivision: string;
      newLP: number;
      newAbsoluteLP: number;
    }) => void
  ) => void;
  onLcuDisconnected: (callback: () => void) => void;
}

export interface LpSnapshot {
  id: number;
  account_id: string;
  timestamp: number;
  tier: string;
  division: string;
  lp: number;
  absolute_lp: number;
}

export interface MatchCacheRow {
  match_id: string;
  account_id: string;
  timestamp: number;
  puuid: string | null;
  champion: string | null;
  position: string | null;
  win: 0 | 1 | null;
  kills: number | null;
  deaths: number | null;
  assists: number | null;
  cs: number | null;
  cs_per_min: number | null;
  damage_dealt: number | null;
  damage_share: number | null;
  gold: number | null;
  vision_score: number | null;
  duration_seconds: number | null;
  items: string | null;
  lp_before: number | null;
  lp_after: number | null;
  lp_delta: number | null;
  queue_type: string | null;
  raw_json: unknown;
}
