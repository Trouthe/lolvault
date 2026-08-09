import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { AnalyticsDataService } from './analytics-data.service';

/**
 * Opens another player's analytics from wherever their name appears.
 *
 * Everyone in a match shares the platform of the profile being viewed, so the
 * caller only ever has to supply a puuid. The display name rides along as a
 * query param purely so the new page can put a name on screen before the
 * summoner lookup returns.
 */
@Injectable({ providedIn: 'root' })
export class PlayerNavService {
  private router = inject(Router);
  private data = inject(AnalyticsDataService);

  /** False for the profile already on screen — clicking yourself is a no-op. */
  canOpen(puuid: string | null | undefined): boolean {
    return !!puuid && puuid !== this.data.puuid();
  }

  open(puuid: string | null | undefined, displayName?: string, tagline?: string): void {
    if (!this.canOpen(puuid)) return;

    const name = tagline ? `${displayName}#${tagline}` : (displayName ?? '');
    void this.router.navigate(['/analytics/player', this.data.platform(), puuid], {
      queryParams: name ? { name } : {},
    });
  }
}
