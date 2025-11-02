import { Injectable } from '@angular/core';
import { environment } from '../../environments/environment';
import { BasicAccountInfo, MasteryInfoItem, PUUIDResponse } from '../models/interfaces/Riot';

@Injectable({
  providedIn: 'root',
})
export class RiotService {
  private riotApi = environment.RIOT_API;

  private mapToRegionLong(server: string): string {
    const mapping: Record<string, string> = {
      EUW: 'europe',
      EUNE: 'europe',
      NA: 'americas',
    };
    return mapping[server.toUpperCase()] || 'europe';
  }

  private mapToRegionShort(server: string): string {
    const mapping: Record<string, string> = {
      EUW: 'euw1',
      EUNE: 'eun1',
      NA: 'na1',
    };
    return mapping[server.toUpperCase()] || 'euw1';
  }

  getPUUID(summonerId: string, tagline: string, region: string): Promise<string> {
    const regionLong = this.mapToRegionLong(region);
    const url = `https://${regionLong}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${summonerId}/${tagline}`;
    return fetch(url, {
      method: 'GET',
      headers: {
        'X-Riot-Token': this.riotApi,
        Accept: 'application/json',
      },
    })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Riot API error: ${response.status} ${response.statusText}`);
        }
        return response.json();
      })
      .then((data: PUUIDResponse) => {
        if (!data || !data.puuid) {
          throw new Error('PUUID not found in Riot response');
        }
        console.log('Riot data:', data);
        return data.puuid as string;
      });
  }

  getBasicAccountInfo(puuid: string, region: string): Promise<BasicAccountInfo> {
    const regionShort = this.mapToRegionShort(region);
    const url = `https://${regionShort}.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${puuid}`;
    return fetch(url, {
      method: 'GET',
      headers: {
        'X-Riot-Token': this.riotApi,
      },
    }).then((response) => {
      if (!response.ok) {
        throw new Error(`Riot API error: ${response.status} ${response.statusText}`);
      }
      console.log('Basic account info response:', response);
      return response.json();
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getRankedInfo(puuid: string, region: string): Promise<any> {
    const regionShort = this.mapToRegionShort(region);
    const url = `https://${regionShort}.api.riotgames.com/lol/league/v4/entries/by-puuid/${puuid}`;
    return fetch(url, {
      method: 'GET',
      headers: {
        'X-Riot-Token': this.riotApi,
      },
    }).then((response) => {
      if (!response.ok) {
        throw new Error(`Riot API error: ${response.status} ${response.statusText}`);
      }
      console.log('Ranked info response:', response);
      return response.json();
    });
  }

  getTopMasteryChampions(puuid: string, region: string): Promise<MasteryInfoItem[]> {
    const regionShort = this.mapToRegionShort(region);
    const url = `https://${regionShort}.api.riotgames.com/lol/champion-mastery/v4/champion-masteries/by-puuid/${puuid}/top`;
    return fetch(url, {
      method: 'GET',
      headers: {
        'X-Riot-Token': this.riotApi,
      },
    }).then((response) => {
      if (!response.ok) {
        throw new Error(`Riot API error: ${response.status} ${response.statusText}`);
      }
      console.log('Top mastery champions response:', response);
      return response.json();
    });
  }
}
