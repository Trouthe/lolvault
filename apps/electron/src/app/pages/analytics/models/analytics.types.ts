import { TimelineParticipantFrame } from '../../../../types/electron';

/**
 * Index map for the positional per-participant timeline frame arrays.
 *
 * Timeline frames are stored positionally (see apps/electron/timeline-compact.js)
 * because key names would otherwise dominate the payload. Always decode through
 * these constants rather than literal indices — this map and `FRAME_FIELDS` in
 * timeline-compact.js must stay in sync.
 */
export const TF = {
  X: 0,
  Y: 1,
  TOTAL_GOLD: 2,
  XP: 3,
  LEVEL: 4,
  MINIONS: 5,
  JUNGLE_MINIONS: 6,
  CURRENT_GOLD: 7,
  DMG_DONE_TOTAL: 8,
  DMG_DONE_MAGIC: 9,
  DMG_DONE_PHYSICAL: 10,
  DMG_DONE_TRUE: 11,
  DMG_TAKEN_TOTAL: 12,
  TIME_CC: 13,
} as const;

/** Summoner's Rift spans 0..14870 on both axes; Riot's origin is bottom-left. */
export const MAP_MAX = 14870;

/** Total CS (lane + jungle) for one participant frame. */
export function frameCs(frame: TimelineParticipantFrame): number {
  return (frame[TF.MINIONS] ?? 0) + (frame[TF.JUNGLE_MINIONS] ?? 0);
}

/** The three analytics screens. */
export type AnalyticsScreen = 'overview' | 'champions' | 'insights';

/** Tabs inside an expanded match card. */
export type MatchTab = 'overview' | 'performance' | 'damage' | 'build';

/** Queue filter used by the Overview most-played toggle. */
export type QueueFilter = 'all' | 'solo' | 'flex' | 'normal';

export const QUEUE_FILTER_IDS: Record<QueueFilter, number[] | null> = {
  all: null,
  solo: [420],
  flex: [440],
  normal: [400, 430],
};

export const QUEUE_FILTER_LABELS: Record<QueueFilter, string> = {
  all: 'Total',
  solo: 'Ranked Solo',
  flex: 'Ranked Flex',
  normal: 'Normal',
};

/** Whether "recently played with" counts teammates or opponents. */
export type PlayedWithMode = 'with' | 'against';

export interface ChampionStatRow {
  champion: string;
  championId: number;
  games: number;
  wins: number;
  losses: number;
  winRate: number;
  kills: number;
  deaths: number;
  assists: number;
  kda: number;
  csPerMin: number;
  damagePerMin: number;
  damageTakenPerMin: number;
  /** Average gold diff at 15 min; null when no game had timeline data. */
  goldDiff15: number | null;
}

export interface PlayedWithRow {
  puuid: string;
  name: string;
  tagline: string;
  games: number;
  wins: number;
  winRate: number;
  championsPlayed: string[];
}

export interface RolePerformanceRow {
  role: string;
  games: number;
  wins: number;
  winRate: number;
  kda: number;
  share: number;
}
