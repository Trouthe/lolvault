import { Injectable } from '@angular/core';
import { BasicAccountInfo, MasteryInfoItem, RankedInfo } from '../models/interfaces/Riot';

/** Server label (EUW, NA, KR…) → Riot platform slug (euw1, na1, kr…) */
const SERVER_TO_PLATFORM: Record<string, string> = {
  EUW: 'euw1',
  EUNE: 'eun1',
  NA: 'na1',
  KR: 'kr',
  BR: 'br1',
  JP: 'jp1',
  LAN: 'la1',
  LAS: 'la2',
  OCE: 'oc1',
  TR: 'tr1',
  RU: 'ru',
  PH: 'ph2',
  SG: 'sg2',
  TW: 'tw2',
  VN: 'vn2',
};

@Injectable({ providedIn: 'root' })
export class RiotApiService {
  private _ddragonVersion: string | null = null;

  // ── Helpers ────────────────────────────────────────────────────────────────

  serverToPlatform(server: string): string {
    return SERVER_TO_PLATFORM[server.toUpperCase()] || 'euw1';
  }

  /** Riot PUUIDs are 78-char URL-safe base64 tokens. */
  isLikelyPuuid(value: unknown): value is string {
    if (typeof value !== 'string') return false;
    const trimmed = value.trim();
    if (trimmed.length < 60) return false;
    return /^[A-Za-z0-9_-]+$/.test(trimmed);
  }

  // ── Summoner ───────────────────────────────────────────────────────────────

  /** Resolves Riot ID → full summoner info via Account v1 + Summoner v4. */
  async getSummonerByRiotId(
    gameName: string,
    tagLine: string,
    server: string
  ): Promise<{ puuid: string; profileIconId: number; summonerLevel: number }> {
    const platform = this.serverToPlatform(server);
    const result = await window.electronAPI.riotGetSummonerByRiotId({
      gameName,
      tagLine,
      platform,
    });
    if (!result || 'error' in result) {
      throw new Error((result as { error: string })?.error || 'Failed to fetch summoner');
    }
    const r = result as { puuid: string; profileIconId: number; summonerLevel: number };
    return { puuid: r.puuid, profileIconId: r.profileIconId, summonerLevel: r.summonerLevel };
  }

  /** Resolves Riot ID → PUUID via the Account v1 endpoint. */
  async getPUUID(gameName: string, tagLine: string, server: string): Promise<string> {
    return (await this.getSummonerByRiotId(gameName, tagLine, server)).puuid;
  }

  /** Returns profile icon ID, summoner level, etc. from the Summoner v4 endpoint. */
  async getBasicAccountInfo(puuid: string, server: string): Promise<BasicAccountInfo> {
    const platform = this.serverToPlatform(server);
    const result = await window.electronAPI.riotGetSummonerByPuuid({ puuid, platform });
    if (!result || 'error' in result) {
      throw new Error((result as { error: string })?.error || 'Failed to fetch summoner');
    }
    // Map main-process field `id` → puuid field expected by BasicAccountInfo interface
    const r = result as {
      id: string;
      accountId: string;
      puuid: string;
      profileIconId: number;
      summonerLevel: number;
    };
    return {
      puuid: r.puuid,
      profileIconId: r.profileIconId,
      revisionDate: 0,
      summonerLevel: r.summonerLevel,
    };
  }

  /** Returns ranked queue entries array (may be empty for unranked accounts). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getRankedInfo(puuid: string, server: string): Promise<RankedInfo[]> {
    const platform = this.serverToPlatform(server);
    const result = await window.electronAPI.riotGetRankedByPuuid({ puuid, platform });
    if ('error' in (result as object)) return [];
    return result as RankedInfo[];
  }

  /** Returns top mastery champion entries. */
  async getTopMasteryChampions(puuid: string, server: string): Promise<MasteryInfoItem[]> {
    const platform = this.serverToPlatform(server);
    const result = await window.electronAPI.riotGetTopMastery({ puuid, platform });
    if (!result || 'error' in (result as object)) return [];
    return result as MasteryInfoItem[];
  }

  // ── Match history ──────────────────────────────────────────────────────────

  async getMatchHistory(accountId: string, puuid: string, server: string, count = 20) {
    const platform = this.serverToPlatform(server);
    return window.electronAPI.riotGetMatchHistory({ accountId, puuid, platform, count });
  }

  async getCachedMatches(accountId: string, limit?: number) {
    return window.electronAPI.riotGetCachedMatches({ accountId, limit });
  }

  // ── API key ────────────────────────────────────────────────────────────────

  async validateApiKey(key: string) {
    return window.electronAPI.riotValidateKey({ key });
  }

  async saveApiKey(key: string | null) {
    return window.electronAPI.riotSaveKey({ key: key ?? '' });
  }

  // ── Data Dragon ────────────────────────────────────────────────────────────

  async getDDragonVersion(): Promise<string> {
    if (this._ddragonVersion) return this._ddragonVersion;
    const version = await window.electronAPI.riotGetDDragonVersion();
    this._ddragonVersion = version || '15.21.1';
    return this._ddragonVersion;
  }

  /** Eagerly loads the DDragon version and caches it for synchronous getters. */
  prefetchDDragonVersion(): void {
    this.getDDragonVersion().catch(() => {
      /* silent */
    });
  }

  getProfileIconUrl(profileIconId?: number): string {
    const v = this._ddragonVersion || '15.21.1';
    return `https://ddragon.leagueoflegends.com/cdn/${v}/img/profileicon/${profileIconId || 29}.png`;
  }

  getChampionIconUrl(championName: string): string {
    const v = this._ddragonVersion || '15.21.1';
    return `https://ddragon.leagueoflegends.com/cdn/${v}/img/champion/${championName}.png`;
  }

  getItemIconUrl(itemId: number): string {
    const v = this._ddragonVersion || '15.21.1';
    return `https://ddragon.leagueoflegends.com/cdn/${v}/img/item/${itemId}.png`;
  }

  /** Spell icon — covers both summoner spells and champion abilities. */
  getSpellIconUrl(imageFile: string): string {
    const v = this._ddragonVersion || '15.21.1';
    return `https://ddragon.leagueoflegends.com/cdn/${v}/img/spell/${imageFile}`;
  }

  /** Champion passive icon, e.g. 'Katarina_Passive.png'. */
  getPassiveIconUrl(imageFile: string): string {
    const v = this._ddragonVersion || '15.21.1';
    return `https://ddragon.leagueoflegends.com/cdn/${v}/img/passive/${imageFile}`;
  }
}
