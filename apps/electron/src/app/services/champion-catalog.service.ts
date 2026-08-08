import { Injectable, inject, signal } from '@angular/core';
import { RiotApiService } from './riot-api.service';

/**
 * Lazily loads the bundled Data Dragon champion list and exposes a
 * numeric-key → champion-id lookup (e.g. "266" → "Aatrox") so templates can
 * resolve mastery icons synchronously once the catalog signal is populated.
 */
@Injectable({ providedIn: 'root' })
export class ChampionCatalogService {
  private readonly riotApiService = inject(RiotApiService);

  /** championKey → champion id (DDragon image name). Empty until loaded. */
  readonly byKey = signal<Record<string, string>>({});

  private loading: Promise<void> | null = null;

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    if (this.loading) return this.loading;

    this.loading = (async () => {
      try {
        const { data } = await import('../data/champions.json');
        const map: Record<string, string> = {};
        for (const champion of Object.values(data)) {
          map[champion.key] = champion.id;
        }
        this.byKey.set(map);
      } catch (error) {
        console.error('Error loading champion catalog:', error);
      }
    })();

    return this.loading;
  }

  /** Returns the DDragon champion id for a numeric mastery key, or '' if unknown. */
  getChampionId(championKey: string | undefined): string {
    if (!championKey) return '';
    return this.byKey()[championKey] || '';
  }

  /** Returns a champion square icon URL for a numeric mastery key, or '' if unknown. */
  getIconUrl(championKey: string | undefined): string {
    const championId = this.getChampionId(championKey);
    if (!championId) return '';
    return this.riotApiService.getChampionIconUrl(championId);
  }
}
