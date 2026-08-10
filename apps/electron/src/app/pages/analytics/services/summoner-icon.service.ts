import { Injectable, signal } from '@angular/core';

const STORAGE_KEY = 'lv:summoner-icons';

/**
 * Ceiling on icon lookups per session.
 *
 * Every other participant field the app renders — name, tagline, champion,
 * team, KDA — comes free with the match itself, and matches cached since
 * `profileIcon` was recorded carry the icon inline too. So this endpoint is
 * only ever a patch for old rows, and it is not worth a single interactive
 * request more than that: an unresolved icon degrades to the default portrait,
 * which nobody notices, whereas a request spent here is a request not spent on
 * a game the user actually asked for.
 *
 * The panel that calls this shows five players, so in practice the cap is
 * never approached. It exists so that stays true if a caller ever asks for
 * more.
 */
const SESSION_LOOKUP_BUDGET = 20;

/**
 * Resolves a PUUID to its summoner icon id, for players we only know from
 * cached match rows.
 *
 * Matches cached before `profileIcon` was recorded carry no icon, so those
 * players are looked up once through Summoner v4 and remembered in
 * localStorage. Lookups are fire-and-forget and deduped per PUUID: the rail
 * shows a handful of recurring players, so this costs a few requests on first
 * open and nothing afterwards. Failures are remembered for the session only,
 * so a rate-limited lookup retries next launch rather than hammering the API.
 */
@Injectable({ providedIn: 'root' })
export class SummonerIconService {
  /** Signal so templates re-render as icons arrive. */
  private readonly resolved = signal<Record<string, number>>(read());

  private readonly pending = new Set<string>();
  private readonly failed = new Set<string>();

  /** Lookups spent this session, against `SESSION_LOOKUP_BUDGET`. */
  private spent = 0;

  /** Cached icon id, or null when we have not resolved this player yet. */
  iconFor(puuid: string): number | null {
    return this.resolved()[puuid] ?? null;
  }

  /** Looks the player up unless they are cached, in flight, or already failed. */
  request(puuid: string, platform: string): void {
    if (!puuid || !platform) return;
    if (this.resolved()[puuid] || this.pending.has(puuid) || this.failed.has(puuid)) return;
    if (this.spent >= SESSION_LOOKUP_BUDGET) return;

    this.spent++;
    this.pending.add(puuid);
    void this.fetch(puuid, platform);
  }

  private async fetch(puuid: string, platform: string): Promise<void> {
    try {
      const result = await window.electronAPI.riotGetSummonerByPuuid({ puuid, platform });
      const icon = result && !('error' in result) ? result.profileIconId : undefined;
      if (typeof icon === 'number' && icon > 0) {
        this.resolved.update((map) => {
          const next = { ...map, [puuid]: icon };
          write(next);
          return next;
        });
      } else {
        this.failed.add(puuid);
      }
    } catch {
      this.failed.add(puuid);
    } finally {
      this.pending.delete(puuid);
    }
  }
}

function read(): Record<string, number> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function write(map: Record<string, number>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* storage full or unavailable — the in-memory copy still works */
  }
}
