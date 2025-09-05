export interface Account {
  id: number;
  name: string;
  username: string;
  password: string;
  game: string;
  server?: string;
  rank?: string;
}
