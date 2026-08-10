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
export type MatchTab = 'overview' | 'performance' | 'damage' | 'build' | 'map';

/** Queue filter used by the Overview most-played toggle. */
export type QueueFilter = 'all' | 'solo' | 'flex' | 'normal';

/**
 * Ranked Solo/Duo. The activity heatmap reports on this queue alone, and the
 * year sweep passes it to Riot's id listing so other modes never cost a request.
 */
export const RANKED_SOLO_QUEUE = 420;

export const QUEUE_FILTER_IDS: Record<QueueFilter, number[] | null> = {
  all: null,
  solo: [RANKED_SOLO_QUEUE],
  flex: [440],
  normal: [400, 430],
};

export const QUEUE_FILTER_LABELS: Record<QueueFilter, string> = {
  all: 'Total',
  solo: 'Ranked Solo',
  flex: 'Ranked Flex',
  normal: 'Normal',
};

/**
 * Riot queue ids we can name. Anything absent falls back to the queue's own
 * `queue_type` string, which is ugly but honest.
 */
export const QUEUE_NAMES: Record<number, string> = {
  400: 'Normal Draft',
  420: 'Solo/Duo',
  430: 'Normal Blind',
  440: 'Flex 5v5',
  450: 'ARAM',
  700: 'Clash',
  900: 'URF',
  1700: 'Arena',
  1900: 'URF',
};

/** Display name for a queue id, falling back to the raw queue type. */
export function queueName(queueId: number | null | undefined, queueType?: string | null): string {
  if (queueId !== null && queueId !== undefined && QUEUE_NAMES[queueId]) {
    return QUEUE_NAMES[queueId];
  }
  return queueType?.replace(/_/g, ' ') ?? 'Other';
}

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
  /** Total pentakills across all games on this champion. */
  pentaKills: number;
}

export interface PlayedWithRow {
  puuid: string;
  name: string;
  tagline: string;
  games: number;
  wins: number;
  winRate: number;
  championsPlayed: string[];
  /**
   * Their summoner icon id, taken from the most recent game we have with them.
   * 0 when every cached game predates the field being recorded — the panel
   * resolves those from the Summoner API instead.
   */
  profileIcon: number;
}

export interface RolePerformanceRow {
  /** Raw `teamPosition` key, used to resolve the official role icon. */
  roleKey: string;
  role: string;
  games: number;
  wins: number;
  winRate: number;
  kda: number;
  share: number;
}

/** One game in the recent-form strip. */
export interface RecentGame {
  matchId: string;
  win: boolean;
  /** Top rating on the winning team — our own metric, not a Riot flag. */
  mvp: boolean;
  timestamp: number;
}

/**
 * One cell of the activity heatmap.
 *
 * Games played and won, nothing else. LP used to drive the colour, which meant
 * the grid only said anything on days a ranked snapshot happened to bracket the
 * session — and said nothing at all for a player we have never tracked.
 */
export interface ActivityDay {
  date: Date;
  wins: number;
  losses: number;
  games: number;
  future: boolean;
  /** Before the first day we have any data for — rendered as "no data". */
  untracked: boolean;
}

/** A ranked queue entry rendered as a collapsible card in the rail. */
export interface QueueCard {
  queueType: string;
  label: string;
  tier: string;
  rank: string;
  leaguePoints: number;
  wins: number;
  losses: number;
  winRate: number;
  games: number;
  ranked: boolean;
}

/**
 * Queues always shown in the rail, even with no games, so the card is there to
 * expand from day one. Any *other* ranked queue the API returns is appended
 * dynamically, so a newly added 5v5 queue appears without a code change.
 * Clash is deliberately excluded.
 */
export const PINNED_QUEUES: { queueType: string; label: string }[] = [
  { queueType: 'RANKED_SOLO_5x5', label: 'Ranked Solo/Duo' },
  { queueType: 'RANKED_FLEX_SR', label: 'Ranked Flex 5v5' },
];

/** Human label for a queueType, falling back to a de-slugged version. */
export function queueTypeLabel(queueType: string): string {
  const known: Record<string, string> = {
    RANKED_SOLO_5x5: 'Ranked Solo/Duo',
    RANKED_FLEX_SR: 'Ranked Flex 5v5',
    RANKED_FLEX_TT: 'Ranked Flex 3v3',
  };
  if (known[queueType]) return known[queueType];
  return queueType
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Clash queues are excluded from analytics entirely. */
export function isClashQueue(queueType: string): boolean {
  return /CLASH/i.test(queueType);
}

/** Divisions ordered low → high, for the rank stepper. */
export const DIVISION_ORDER = ['IV', 'III', 'II', 'I'] as const;

export const TIER_ORDER = [
  'IRON',
  'BRONZE',
  'SILVER',
  'GOLD',
  'PLATINUM',
  'EMERALD',
  'DIAMOND',
  'MASTER',
  'GRANDMASTER',
  'CHALLENGER',
] as const;
