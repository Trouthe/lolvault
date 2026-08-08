/** One recorded LP reading — timestamped so the card can window it by date. */
export interface LpTrendPoint {
  /** When the reading was taken (epoch ms). */
  t: number;
  /** Absolute LP at that moment: tier base + division + league points. */
  lp: number;
}

export interface Account {
  id: number | string;
  syncId?: string;
  name: string;
  username?: string;
  password?: string;
  game: string;
  server?: string;
  rank?: string;
  profileIconId?: number;
  summonerLevel?: number;
  leaguePoints?: number;
  wins?: number;
  losses?: number;
  hotStreak?: boolean;
  topChampionId?: string;
  boardId?: string;
  lastRefreshed?: number;
  /** PUUID discovered by the LCU monitor and persisted for fast re-identification. */
  puuid?: string;

  // ── Card stats (locally derived, never round-tripped through cloud sync) ─────

  /** Top 3 mastery champion IDs (numeric keys), highest mastery first. */
  topChampionIds?: string[];
  /** Most recent ranked-solo results, newest first — true = win. */
  recentResults?: boolean[];
  /** Recorded LP readings, oldest first. The card windows these to 7 days. */
  lpTrend?: LpTrendPoint[];
  /** Most played team position from the cached match history (TOP/JUNGLE/…). */
  mainLane?: string;
  /**
   * Last time LoL Vault itself saw this account in use — set when we launch it,
   * capture its session, or the LCU reports it as the signed-in account.
   * This is our own detection, not a Riot login timestamp.
   */
  lastActiveAt?: number;
}
