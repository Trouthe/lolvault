export interface Account {
  id: number | string;
  name: string;
  username: string;
  password: string;
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
}
