export interface PUUIDResponse {
  puuid: string;
  gameName: string;
  tagLine: string;
}

export interface BasicAccountInfo {
  puuid: string;
  profileIconId: number;
  revisionDate: number;
  summonerLevel: number;
}

export interface RankedInfo {
  leagueId: string;
  queueType: string;
  tier: string;
  rank: string;
  puuid: string;
  leaguePoints: number;
  wins: number;
  losses: number;
  veteran: boolean;
  inactive: boolean;
  freshBlood: boolean;
  hotStreak: boolean;
}

export interface MasteryInfoItem {
  puuid: string;
  championId: number;
  championLevel: number;
  championPoints: number;
  lastPlayTime: number;
  championPointsSinceLastLevel: number;
  championPointsUntilNextLevel: number;
  markRequiredForNextLevel: number;
  tokensEarned: number;
  championSeasonMilestone: number;
  milestoneGrades: string[];
  nextSeasonMilestone: NextSeasonMilestone;
}
export interface NextSeasonMilestone {
  requireGradeCounts: Record<string, number>;
  rewardMarks: number;
  bonus: boolean;
  totalGamesRequires: number;
}
