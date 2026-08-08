/**
 * @deprecated Use RiotApiService from riot-api.service.ts directly.
 * This class is kept for backward-compatibility with existing imports.
 * It delegates all calls to RiotApiService.
 */
import { Injectable, inject } from '@angular/core';
import { BasicAccountInfo, MasteryInfoItem, RankedInfo } from '../models/interfaces/Riot';
import { RiotApiService } from './riot-api.service';

@Injectable({ providedIn: 'root' })
export class RiotService {
  private api = inject(RiotApiService);

  isLikelyPuuid(value: unknown): value is string {
    return this.api.isLikelyPuuid(value);
  }

  getPUUID(gameName: string, tagLine: string, server: string): Promise<string> {
    return this.api.getPUUID(gameName, tagLine, server);
  }

  getBasicAccountInfo(puuid: string, server: string): Promise<BasicAccountInfo> {
    return this.api.getBasicAccountInfo(puuid, server);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getRankedInfo(puuid: string, server: string): Promise<RankedInfo[]> {
    return this.api.getRankedInfo(puuid, server);
  }

  getTopMasteryChampions(puuid: string, server: string): Promise<MasteryInfoItem[]> {
    return this.api.getTopMasteryChampions(puuid, server);
  }
}
