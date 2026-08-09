import { Injectable, inject, signal } from '@angular/core';
import { RiotApiService } from './riot-api.service';

export interface ItemInfo {
  name: string;
  image: string;
  gold: number;
  from?: string[];
}

export interface SummonerSpellInfo {
  name: string;
  image: string;
}

export interface RuneInfo {
  id: number;
  key: string;
  name: string;
  icon: string;
}

export interface RuneTree {
  id: number;
  key: string;
  name: string;
  icon: string;
  slots: { runes: RuneInfo[] }[];
}

/**
 * Item, summoner-spell and rune metadata.
 *
 * Bundled locally (trimmed to the fields the UI renders — names and icon paths,
 * not the localised shop descriptions) so the app works offline, matching the
 * precedent set by champions.json. When a lookup misses — a new item or rune
 * released after this dataset — it falls back to the live Data Dragon CDN and
 * caches the result for the session, so a stale bundle degrades rather than breaks.
 */
@Injectable({ providedIn: 'root' })
export class GameDataService {
  private riotApi = inject(RiotApiService);

  readonly items = signal<Record<string, ItemInfo>>({});
  readonly summonerSpells = signal<Record<string, SummonerSpellInfo>>({});
  readonly runeTrees = signal<RuneTree[]>([]);

  /** Champion name → ability icon filenames (Q, W, E, R) plus passive. */
  readonly championSpells = signal<Record<string, { spells: string[]; passive: string }>>({});

  /** id → rune, flattened across all trees for O(1) perk lookups. */
  readonly runesById = signal<Record<string, RuneInfo>>({});

  private loading: Promise<void> | null = null;
  private remoteAttempted = new Set<string>();

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    if (this.loading) return this.loading;

    this.loading = (async () => {
      try {
        const [items, spells, runes, champSpells] = await Promise.all([
          import('../data/item.json'),
          import('../data/summoner.json'),
          import('../data/runesReforged.json'),
          import('../data/champion-spells.json'),
        ]);

        this.championSpells.set(
          (champSpells.default ?? champSpells).byName as Record<
            string,
            { spells: string[]; passive: string }
          >
        );

        this.items.set((items.default ?? items).data as Record<string, ItemInfo>);
        this.summonerSpells.set(
          (spells.default ?? spells).data as Record<string, SummonerSpellInfo>
        );

        const trees = ((runes.default ?? runes) as unknown as RuneTree[]) ?? [];
        this.runeTrees.set(trees);

        const flat: Record<string, RuneInfo> = {};
        for (const tree of trees) {
          flat[String(tree.id)] = { id: tree.id, key: tree.key, name: tree.name, icon: tree.icon };
          for (const slot of tree.slots) {
            for (const rune of slot.runes) flat[String(rune.id)] = rune;
          }
        }
        this.runesById.set(flat);
      } catch (error) {
        console.error('Error loading bundled game data:', error);
      }
    })();

    return this.loading;
  }

  // ── Items ──────────────────────────────────────────────────────────────────

  getItem(itemId: number | string): ItemInfo | null {
    const item = this.items()[String(itemId)];
    if (item) return item;
    // Unknown id — likely newer than the bundle. Pull it in the background so
    // subsequent renders resolve, and let this call fall back to the CDN icon.
    void this.hydrateItemFromCdn();
    return null;
  }

  getItemName(itemId: number | string): string {
    return this.getItem(itemId)?.name ?? '';
  }

  /** Item icon URL; always resolvable since DDragon serves icons by id. */
  getItemIconUrl(itemId: number): string {
    return this.riotApi.getItemIconUrl(itemId);
  }

  // ── Summoner spells ────────────────────────────────────────────────────────

  getSummonerSpell(key: number | string): SummonerSpellInfo | null {
    return this.summonerSpells()[String(key)] ?? null;
  }

  getSummonerSpellIconUrl(key: number | string): string {
    const spell = this.getSummonerSpell(key);
    if (!spell?.image) return '';
    return this.riotApi.getSpellIconUrl(spell.image);
  }

  // ── Champion abilities ─────────────────────────────────────────────────────

  /**
   * Ability icon for a champion's skill slot (1=Q, 2=W, 3=E, 4=R).
   * Returns '' when the champion isn't in the bundled dataset, so callers can
   * fall back to a letter rather than rendering a broken image.
   */
  getAbilityIconUrl(championName: string, skillSlot: number): string {
    const entry = this.championSpells()[championName];
    const file = entry?.spells?.[skillSlot - 1];
    if (!file) return '';
    return this.riotApi.getSpellIconUrl(file);
  }

  getPassiveIconUrl(championName: string): string {
    const file = this.championSpells()[championName]?.passive;
    if (!file) return '';
    return this.riotApi.getPassiveIconUrl(file);
  }

  // ── Runes ──────────────────────────────────────────────────────────────────

  getRune(id: number | string): RuneInfo | null {
    const rune = this.runesById()[String(id)];
    if (rune) return rune;
    void this.hydrateRunesFromCdn();
    return null;
  }

  /** Rune icons use a full path from the DDragon root, not a versioned img dir. */
  getRuneIconUrl(id: number | string): string {
    const rune = this.getRune(id);
    if (!rune?.icon) return '';
    return `https://ddragon.leagueoflegends.com/cdn/img/${rune.icon}`;
  }

  // ── CDN fallback ───────────────────────────────────────────────────────────

  /** Merges the live item list over the bundle once per session. */
  private async hydrateItemFromCdn(): Promise<void> {
    if (this.remoteAttempted.has('item')) return;
    this.remoteAttempted.add('item');

    try {
      const version = await this.riotApi.getDDragonVersion();
      const res = await fetch(
        `https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/item.json`
      );
      if (!res.ok) return;

      const json = (await res.json()) as { data: Record<string, { name: string; image?: { full?: string }; gold?: { total?: number } }> };
      const merged = { ...this.items() };
      for (const [id, data] of Object.entries(json.data)) {
        if (merged[id]) continue;
        merged[id] = {
          name: data.name,
          image: data.image?.full ?? `${id}.png`,
          gold: data.gold?.total ?? 0,
        };
      }
      this.items.set(merged);
    } catch {
      /* Offline or blocked — bundled data remains in use. */
    }
  }

  private async hydrateRunesFromCdn(): Promise<void> {
    if (this.remoteAttempted.has('runes')) return;
    this.remoteAttempted.add('runes');

    try {
      const version = await this.riotApi.getDDragonVersion();
      const res = await fetch(
        `https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/runesReforged.json`
      );
      if (!res.ok) return;

      const trees = (await res.json()) as RuneTree[];
      const flat = { ...this.runesById() };
      for (const tree of trees) {
        flat[String(tree.id)] = { id: tree.id, key: tree.key, name: tree.name, icon: tree.icon };
        for (const slot of tree.slots) {
          for (const rune of slot.runes) flat[String(rune.id)] = rune;
        }
      }
      this.runesById.set(flat);
      this.runeTrees.set(trees);
    } catch {
      /* Offline or blocked — bundled data remains in use. */
    }
  }
}
