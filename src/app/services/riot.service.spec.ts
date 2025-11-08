/* eslint-disable @typescript-eslint/no-explicit-any */
import { TestBed } from '@angular/core/testing';
import { RiotService } from './riot.service';
import { environment } from '../../environments/environment';

describe('RiotService (robust)', () => {
  let service: RiotService;
  const originalFetch = (window as any).fetch;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [RiotService],
    });
    service = TestBed.inject(RiotService);
  });

  afterEach(() => {
    (window as any).fetch = originalFetch;
  });

  it('getPUUID: should call long-region endpoint, set headers (including Accept) and return puuid', async () => {
    const expectedBody = { puuid: 'puuid-123' };
    const fetchSpy = spyOn(window as any, 'fetch').and.callFake((url: string, opts: any) => {
      expect(url).toBe(
        'https://europe.api.riotgames.com/riot/account/v1/accounts/by-riot-id/Summoner/Tag'
      );
      expect(opts).toBeDefined();
      expect(opts.method).toBe('GET');
      expect(opts.headers).toBeDefined();
      expect(opts.headers['X-Riot-Token']).toBe(environment.RIOT_API);

      expect(opts.headers['Accept']).toBe('application/json');
      return Promise.resolve({ ok: true, json: () => Promise.resolve(expectedBody) });
    });
    const puuid = await service.getPUUID('Summoner', 'Tag', 'EUW');
    expect(puuid).toBe('puuid-123');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('getPUUID: should reject when Riot responds with non-ok status (error includes status)', async () => {
    spyOn(window as any, 'fetch').and.returnValue(
      Promise.resolve({ ok: false, status: 404, statusText: 'Not Found' })
    );
    await expectAsync(service.getPUUID('x', 'y', 'NA')).toBeRejectedWithError(
      /Riot API error: 404/
    );
  });

  it('getPUUID: should reject when response body lacks puuid', async () => {
    spyOn(window as any, 'fetch').and.returnValue(
      Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    );
    await expectAsync(service.getPUUID('a', 'b', 'EUW')).toBeRejectedWithError(/PUUID not found/);
  });

  it('getBasicAccountInfo: should call short-region endpoint, include token header and return parsed JSON', async () => {
    const expectedBody = { id: '1', name: 'TestSumm' };
    const fetchSpy = spyOn(window as any, 'fetch').and.callFake((url: string, opts: any) => {
      expect(url).toBe('https://euw1.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/puuid-1');
      expect(opts.method).toBe('GET');
      expect(opts.headers['X-Riot-Token']).toBe(environment.RIOT_API);
      return Promise.resolve({ ok: true, json: () => Promise.resolve(expectedBody) });
    });
    const info = await service.getBasicAccountInfo('puuid-1', 'EUW');
    expect(info).toEqual(expectedBody as any);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('getBasicAccountInfo: should reject on non-ok response', async () => {
    spyOn(window as any, 'fetch').and.returnValue(
      Promise.resolve({ ok: false, status: 403, statusText: 'Forbidden' })
    );
    await expectAsync(service.getBasicAccountInfo('puuid-1', 'EUNE')).toBeRejectedWithError(
      /Riot API error: 403/
    );
  });

  it('getRankedInfo: should call ranked endpoint for EUW and return array data', async () => {
    const expectedBody = [{ queueType: 'RANKED_SOLO_5x5', tier: 'GOLD' }];
    const fetchSpy = spyOn(window as any, 'fetch').and.callFake((url: string, opts: any) => {
      expect(url).toBe('https://euw1.api.riotgames.com/lol/league/v4/entries/by-puuid/puuid-xyz');
      expect(opts.headers['X-Riot-Token']).toBe(environment.RIOT_API);
      return Promise.resolve({ ok: true, json: () => Promise.resolve(expectedBody) });
    });
    const ranked = await service.getRankedInfo('puuid-xyz', 'EUW');
    expect(Array.isArray(ranked)).toBeTrue();
    expect(ranked).toEqual(expectedBody as any);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('getTopMasteryChampions: should call mastery endpoint and return list', async () => {
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
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('region mapping: unknown region falls back to europe/euw1', async () => {
    const expectedBody = { puuid: 'fallback' };
    const fetchSpy = spyOn(window as any, 'fetch').and.callFake((url: string) => {
      expect(url.startsWith('https://europe.api.riotgames.com/')).toBeTrue();
      return Promise.resolve({ ok: true, json: () => Promise.resolve(expectedBody) });
    });
    const puuid = await service.getPUUID('a', 'b', 'unknown-region');
    expect(puuid).toBe('fallback');
    expect(fetchSpy).toHaveBeenCalled();
  });

  it('getPUUID: supports EUNE and NA region mappings', async () => {
    const fetchSpy = spyOn(window as any, 'fetch').and.callFake((url: string) => {
      if (url.includes('europe.api.riotgames.com')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ puuid: 'puuid-eune' }) });
      }
      if (url.includes('americas.api.riotgames.com')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ puuid: 'puuid-na' }) });
      }
      return Promise.resolve({ ok: false, status: 500, statusText: 'Server Error' });
    });
    const [p1, p2] = await Promise.all([
      service.getPUUID('Summ', 'Tag', 'EUNE'),
      service.getPUUID('Summ', 'Tag', 'NA'),
    ]);
    expect(p1).toBe('puuid-eune');
    expect(p2).toBe('puuid-na');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('getBasicAccountInfo: short region mapping is case-insensitive and includes header', async () => {
    const expectedBody = { id: '2', name: 'CaseTest' };
    const fetchSpy = spyOn(window as any, 'fetch').and.callFake((url: string, opts: any) => {
      expect(url).toBe('https://euw1.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/puuid-2');
      expect(opts.headers['X-Riot-Token']).toBe(environment.RIOT_API);
      return Promise.resolve({ ok: true, json: () => Promise.resolve(expectedBody) });
    });
    const info = await service.getBasicAccountInfo('puuid-2', 'eUw');
    expect(info).toEqual(expectedBody as any);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('getBasicAccountInfo: should reject when fetch itself fails (network error)', async () => {
    spyOn(window as any, 'fetch').and.returnValue(Promise.reject(new Error('network down')));
    await expectAsync(service.getBasicAccountInfo('puuid-x', 'EUW')).toBeRejectedWithError(
      /network down/
    );
  });

  it('getRankedInfo: should propagate JSON parse errors', async () => {
    spyOn(window as any, 'fetch').and.returnValue(
      Promise.resolve({ ok: true, json: () => Promise.reject(new Error('bad json')) })
    );
    await expectAsync(service.getRankedInfo('puuid-xyz', 'EUW')).toBeRejectedWithError(/bad json/);
  });

  it('getTopMasteryChampions: handles empty lists', async () => {
    spyOn(window as any, 'fetch').and.returnValue(
      Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
    );
    const list = await service.getTopMasteryChampions('puuid-empty', 'EUW');
    expect(Array.isArray(list)).toBeTrue();
    expect(list.length).toBe(0);
  });

  it('concurrent getPUUID calls result in multiple fetch requests', async () => {
    let call = 0;
    const fetchSpy = spyOn(window as any, 'fetch').and.callFake(() => {
      const idx = ++call;
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ puuid: `p${idx}` }) });
    });
    const [a, b, c] = await Promise.all([
      service.getPUUID('s1', 't1', 'EUW'),
      service.getPUUID('s2', 't2', 'EUW'),
      service.getPUUID('s3', 't3', 'EUW'),
    ]);
    expect([a, b, c]).toEqual(['p1', 'p2', 'p3']);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});
