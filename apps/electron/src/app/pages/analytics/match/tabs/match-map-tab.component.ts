import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CompactTimeline, MatchCacheRow, MatchDetail } from '../../../../../types/electron';
import { HeatmapService, FeedEvent } from '../../services/heatmap.service';
import { RiotApiService } from '../../../../services/riot-api.service';
import {
  DEATH_ICON_RED,
  KILL_ICON,
  objectiveIcon,
} from '../../services/game-assets';
import { MapHeatmapComponent } from '../../widgets/map-heatmap.component';
import { EmptyStateComponent } from '../../widgets/empty-state.component';
import { IconComponent } from '../../widgets/icon.component';

/**
 * Position heatmap plus the chronological match timeline.
 *
 * The two read together: the map shows *where* the game happened, the feed
 * beside it shows *what* happened and when.
 */
@Component({
  selector: 'app-match-map-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, MapHeatmapComponent, EmptyStateComponent, IconComponent],
  templateUrl: './match-map-tab.component.html',
  styleUrl: './match-map-tab.component.scss',
})
export class MatchMapTabComponent {
  private heatmap = inject(HeatmapService);
  private riotApi = inject(RiotApiService);

  match = input.required<MatchCacheRow>();
  detail = input.required<MatchDetail>();
  timeline = input.required<CompactTimeline | null>();

  readonly feed = computed<FeedEvent[]>(() => {
    const tl = this.timeline();
    if (!tl) return [];
    return this.heatmap.buildEventFeed(
      tl,
      this.detail().participants.map((p) => ({
        participantId: p.participantId,
        championName: p.championName,
        riotIdGameName: p.riotIdGameName,
        teamId: p.teamId,
      })),
      this.match().team_id
    );
  });

  readonly hasFeed = computed(() => this.feed().length > 0);

  championIcon(name: string): string {
    return name ? this.riotApi.getChampionIconUrl(name) : '';
  }

  /** Official client art for each event kind, coloured by which side gained. */
  iconFor(event: FeedEvent): string {
    const side = event.friendly ? 100 : 200;
    switch (event.kind) {
      case 'kill':
        return event.friendly ? KILL_ICON : DEATH_ICON_RED;
      case 'tower':
        return objectiveIcon('tower', side);
      case 'inhibitor':
        return objectiveIcon('inhibitor', side);
      case 'baron':
        return objectiveIcon('baron', side);
      case 'herald':
        return objectiveIcon('herald', side);
      default:
        return objectiveIcon('dragon', side, event.monsterSubType);
    }
  }

  formatTime(ms: number): string {
    const total = Math.floor(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }
}
