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

  /** Compacted match timeline; fetched and cached on first request. */
  riotGetMatchTimeline: (args: {
    matchId: string;
    platform: string;
  }) => Promise<CompactTimeline | { error: string }>;

  /** Full match detail (bans, objectives, untrimmed participants). */
  riotGetMatchDetail: (args: {
    matchId: string;
    accountId: string;
    puuid: string;
    platform: string;
  }) => Promise<MatchDetail | { error: string }>;

  riotBackfillMatchData: (args: {
    accountId: string;
    puuid: string;
    platform: string;
    limit?: number;
  }) => Promise<
    { processed: number; total: number; failed: number; cancelled: boolean } | { error: string }
  >;

  riotCancelBackfill: (args: { accountId: string }) => Promise<{ success: boolean }>;

  riotGetBackfillStatus: (args: { accountId: string }) => Promise<{
    pendingMatches: number;
    pendingRequests: number;
    etaSeconds: number;
  }>;

  onBackfillProgress: (callback: (data: BackfillProgress) => void) => void;

  /** Drops rows filed under an account that record a different player's game. */
  riotPurgeForeignMatches: (args: {
    accountId: string;
    puuid: string;
  }) => Promise<{ removed: number }>;

  /** Pulls one calendar year of match ids and caches whatever is missing. */
  riotFetchYearHistory: (args: {
    accountId: string;
    puuid: string;
    platform: string;
    year: number;
    /** Riot queue id to narrow the listing server-side. Omit for every mode. */
    queue?: number;
  }) => Promise<
    | { scanned: number; added: number; reused: number; failed: number; cancelled: boolean }
    | { error: string }
  >;

  riotCancelYearHistory: (args: { accountId: string }) => Promise<{ success: boolean }>;

  onYearHistoryProgress: (callback: (data: YearHistoryProgress) => void) => void;

  /** Batches of freshly-cached rows, pushed during a year sweep. */
  onYearHistoryRows: (
    callback: (data: { accountId: string; year: number; rows: MatchCacheRow[] }) => void
  ) => void;

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

export interface BackfillProgress {
  accountId: string;
  processed: number;
  total: number;
  failed: number;
  etaSeconds: number;
  done: boolean;
}

export interface YearHistoryProgress extends BackfillProgress {
  year: number;
  /** `scanning` walks the id endpoint; `fetching` pulls match detail. */
  phase: 'scanning' | 'fetching';
  /** Match ids the year listing returned, before anything was filtered out. */
  scanned: number;
  /** Games rebuilt from data already on disk — these cost no Riot request. */
  reused: number;
}

/**
 * One participant's stats for a single timeline frame.
 *
 * Stored positionally rather than as an object — key names would otherwise
 * dominate the payload. Decode with `TIMELINE_FRAME_FIELDS`, never by literal
 * index. Mirrors `FRAME_FIELDS` in apps/electron/timeline-compact.js.
 */
export type TimelineParticipantFrame = number[];

export interface TimelineEvent {
  /** Milliseconds from game start. */
  t: number;
  type: string;
  x?: number;
  y?: number;
  killerId?: number;
  victimId?: number;
  creatorId?: number;
  participantId?: number;
  assists?: number[];
  itemId?: number;
  beforeId?: number;
  afterId?: number;
  skillSlot?: number;
  levelUpType?: string;
  level?: number;
  teamId?: number;
  killerTeamId?: number;
  buildingType?: string;
  towerType?: string;
  laneType?: string;
  monsterType?: string;
  monsterSubType?: string;
  wardType?: string;
  killType?: string;
  multiKill?: number;
  bounty?: number;
}

export interface CompactTimeline {
  matchId: string;
  /** Milliseconds between frames — 60000 in practice. */
  frameInterval: number;
  frameCount: number;
  participants: { participantId: number; puuid: string }[];
  /** `frames[frameIndex][participantId - 1]` → positional stat array. */
  frames: TimelineParticipantFrame[][];
  events: TimelineEvent[];
  schemaVersion: number;
  fetchedAt: number;
}

export interface MatchTeam {
  teamId: number;
  win: boolean;
  bans: { championId: number; pickTurn: number }[];
  objectives: Record<string, { first?: boolean; kills?: number }>;
}

export interface MatchDetailParticipant {
  puuid: string;
  participantId: number;
  riotIdGameName: string;
  riotIdTagline: string;
  championName: string;
  championId: number;
  teamId: number;
  teamPosition: string;
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  cs: number;
  champLevel: number;
  summoner1Id: number;
  summoner2Id: number;
  goldEarned: number;
  goldSpent: number;
  visionScore: number;
  items: number[];
  totalDamageDealtToChampions: number;
  physicalDamageDealtToChampions: number;
  magicDamageDealtToChampions: number;
  trueDamageDealtToChampions: number;
  totalDamageTaken: number;
  physicalDamageTaken: number;
  magicDamageTaken: number;
  trueDamageTaken: number;
  damageSelfMitigated: number;
  totalHeal: number;
  totalHealsOnTeammates: number;
  totalDamageShieldedOnTeammates: number;
  damageDealtToTurrets: number;
  damageDealtToObjectives: number;
  totalMinionsKilled: number;
  neutralMinionsKilled: number;
  wardsPlaced: number;
  wardsKilled: number;
  visionWardsBoughtInGame: number;
  firstBloodKill: boolean;
  doubleKills: number;
  tripleKills: number;
  quadraKills: number;
  pentaKills: number;
  timeCCingOthers: number;
  totalTimeSpentDead: number;
  perks: unknown;
  gameEndedInSurrender: boolean;
  gameEndedInEarlySurrender: boolean;
}

export interface MatchDetail {
  matchId: string;
  queueId: number | null;
  gameVersion: string | null;
  gameMode: string | null;
  gameDuration: number | null;
  teams: MatchTeam[];
  participants: MatchDetailParticipant[];
  schemaVersion: number;
  fetchedAt: number;
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

  // ── Added by the analytics rebuild ─────────────────────────────────────────
  /** Numeric Riot queue id (420 solo, 440 flex, …). Source of truth over queue_type. */
  queue_id: number | null;
  /** 1-10; join key into the timeline's participantFrames. */
  participant_id: number | null;
  team_id: number | null;
  champion_id: number | null;
  game_version: string | null;
  has_detail: 0 | 1 | null;
  has_timeline: 0 | 1 | null;
  /** Differentials vs the lane opponent at 15 min; null when no timeline data. */
  gold_diff_15: number | null;
  cs_diff_15: number | null;
  xp_diff_15: number | null;
}
