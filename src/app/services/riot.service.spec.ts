/* eslint-disable @typescript-eslint/no-explicit-any */
import { TestBed } from '@angular/core/testing';
import { RiotService } from './riot.service';
import { environment } from '../../environments/environment';

describe('RiotService', () => {
  let service: RiotService;
  const originalFetch = (window as any).fetch;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [RiotService],
    });
    service = TestBed.inject(RiotService);
  });

  afterEach(() => {
    // restore original fetch to avoid leaking mocks between tests
    (window as any).fetch = originalFetch;
  });

  it('getPUUID should call correct EUW (long) endpoint and return puuid on success', async () => {
    const expectedBody = { puuid: 'puuid-123' };

    const fetchSpy = spyOn(window as any, 'fetch').and.callFake((url: string, opts: any) => {
      expect(url).toBe(
        'https://europe.api.riotgames.com/riot/account/v1/accounts/by-riot-id/Summoner/Tag'
      );
      expect(opts.method).toBe('GET');
      expect(opts.headers['X-Riot-Token']).toBe(environment.RIOT_API);
      return Promise.resolve({ ok: true, json: () => Promise.resolve(expectedBody) });
    });

    const puuid = await service.getPUUID('Summoner', 'Tag', 'EUW');
    expect(puuid).toBe('puuid-123');
    expect(fetchSpy).toHaveBeenCalled();
  });

  it('getPUUID should reject when Riot responds with non-ok status', async () => {
    spyOn(window as any, 'fetch').and.returnValue(
      Promise.resolve({ ok: false, status: 404, statusText: 'Not Found' })
    );

    await expectAsync(service.getPUUID('x', 'y', 'NA')).toBeRejectedWithError(
      /Riot API error: 404/
    );
  });

  it('getBasicAccountInfo should call short region endpoint and return account info', async () => {
    const expectedBody = { id: '1', name: 'TestSumm' };

    const fetchSpy = spyOn(window as any, 'fetch').and.callFake((url: string, opts: any) => {
      // NA/short mapping -> na1; test using EUW to assert euw1 mapping
      expect(url).toBe('https://euw1.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/puuid-1');
      expect(opts.method).toBe('GET');
      expect(opts.headers['X-Riot-Token']).toBe(environment.RIOT_API);
      return Promise.resolve({ ok: true, json: () => Promise.resolve(expectedBody) });
    });

    const info = await service.getBasicAccountInfo('puuid-1', 'EUW');
    // cast to any to avoid strict typing mismatch between partial mock and full interface
    expect(info).toEqual(expectedBody as any);
    expect(fetchSpy).toHaveBeenCalled();
  });

  it('getBasicAccountInfo should reject on non-ok response', async () => {
    spyOn(window as any, 'fetch').and.returnValue(
      Promise.resolve({ ok: false, status: 403, statusText: 'Forbidden' })
    );

    await expectAsync(service.getBasicAccountInfo('puuid-1', 'EUNE')).toBeRejectedWithError(
      /Riot API error: 403/
    );
  });

  it('getRankedInfo should call ranked endpoint and return array data', async () => {
    const expectedBody = [{ queueType: 'RANKED_SOLO_5x5', tier: 'GOLD' }];

    const fetchSpy = spyOn(window as any, 'fetch').and.callFake((url: string, opts: any) => {
      expect(url).toBe('https://euw1.api.riotgames.com/lol/league/v4/entries/by-puuid/puuid-xyz');
      expect(opts.headers['X-Riot-Token']).toBe(environment.RIOT_API);
      return Promise.resolve({ ok: true, json: () => Promise.resolve(expectedBody) });
    });

    const ranked = await service.getRankedInfo('puuid-xyz', 'EUW');
    expect(ranked).toEqual(expectedBody as any);
    expect(fetchSpy).toHaveBeenCalled();
  });

  it('getTopMasteryChampions should call mastery endpoint and return list', async () => {
    const expectedBody = [{ championId: 10, championLevel: 7 }];

    const fetchSpy = spyOn(window as any, 'fetch').and.callFake((url: string, opts: any) => {
      expect(url).toBe(
        'https://euw1.api.riotgames.com/lol/champion-mastery/v4/champion-masteries/by-puuid/puuid-abc/top'
      );
      expect(opts.headers['X-Riot-Token']).toBe(environment.RIOT_API);
      return Promise.resolve({ ok: true, json: () => Promise.resolve(expectedBody) });
    });

    const list = await service.getTopMasteryChampions('puuid-abc', 'EUW');
    expect(list).toEqual(expectedBody as any);
    expect(fetchSpy).toHaveBeenCalled();
  });
});
