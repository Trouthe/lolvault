export interface Account {
  id: number | string;
  name: string;
  username: string;
  password: string;
  game: string;
  server?: string;
  rank?: string;
  profileIconId?: number;
  topChampionId?: string;
}
