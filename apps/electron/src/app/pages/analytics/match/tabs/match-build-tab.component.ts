import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  CompactTimeline,
  MatchCacheRow,
  MatchDetail,
  MatchDetailParticipant,
} from '../../../../../types/electron';
import { RiotApiService } from '../../../../services/riot-api.service';
import { EmptyStateComponent } from '../../widgets/empty-state.component';

/** One minute-bucket of item purchases. */
interface BuildStep {
  minute: number;
  items: { itemId: number; sold: boolean }[];
}

const SKILL_KEYS = ['Q', 'W', 'E', 'R'];

@Component({
  selector: 'app-match-build-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, EmptyStateComponent],
  templateUrl: './match-build-tab.component.html',
  styleUrl: './match-build-tab.component.scss',
})
export class MatchBuildTabComponent {
  private riotApi = inject(RiotApiService);

  match = input.required<MatchCacheRow>();
  detail = input.required<MatchDetail>();
  timeline = input.required<CompactTimeline | null>();

  /** Player whose build is shown; defaults to the account holder. */
  readonly selectedPid = signal<number | null>(null);

  readonly skillKeys = SKILL_KEYS;

  readonly activePid = computed(() => this.selectedPid() ?? this.match().participant_id ?? 1);

  readonly players = computed(() => {
    const detail = this.detail();
    const myTeam = this.match().team_id;
    return {
      allies: detail.participants.filter((p) => p.teamId === myTeam),
      enemies: detail.participants.filter((p) => p.teamId !== myTeam),
    };
  });

  readonly activePlayer = computed<MatchDetailParticipant | null>(
    () => this.detail().participants.find((p) => p.participantId === this.activePid()) ?? null
  );

  /**
   * Purchases grouped by minute.
   *
   * ITEM_UNDO events are applied by removing the matching purchase, and sold
   * items are marked rather than dropped — showing an honest build path instead
   * of a naive purchase log.
   */
  readonly buildSteps = computed<BuildStep[]>(() => {
    const tl = this.timeline();
    const pid = this.activePid();
    if (!tl?.events?.length || !pid) return [];

    const purchases: { minute: number; itemId: number; sold: boolean }[] = [];

    for (const ev of tl.events) {
      if (ev.participantId !== pid) continue;
      const minute = Math.floor(ev.t / 60_000);

      if (ev.type === 'ITEM_PURCHASED' && ev.itemId) {
        purchases.push({ minute, itemId: ev.itemId, sold: false });
      } else if (ev.type === 'ITEM_UNDO' && ev.beforeId) {
        // Undo cancels the most recent purchase of that item.
        for (let i = purchases.length - 1; i >= 0; i--) {
          if (purchases[i].itemId === ev.beforeId) {
            purchases.splice(i, 1);
            break;
          }
        }
      } else if (ev.type === 'ITEM_SOLD' && ev.itemId) {
        for (let i = purchases.length - 1; i >= 0; i--) {
          if (purchases[i].itemId === ev.itemId && !purchases[i].sold) {
            purchases[i].sold = true;
            break;
          }
        }
      }
    }

    const byMinute = new Map<number, { itemId: number; sold: boolean }[]>();
    for (const p of purchases) {
      const list = byMinute.get(p.minute) ?? [];
      list.push({ itemId: p.itemId, sold: p.sold });
      byMinute.set(p.minute, list);
    }

    return [...byMinute.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([minute, items]) => ({ minute, items }));
  });

  /**
   * Skill order as a level-by-level grid.
   * `levels[slot][level]` is true when that skill was levelled at that point.
   */
  readonly skillOrder = computed(() => {
    const tl = this.timeline();
    const pid = this.activePid();
    if (!tl?.events?.length || !pid) return null;

    const ups = tl.events
      .filter((ev) => ev.type === 'SKILL_LEVEL_UP' && ev.participantId === pid && ev.skillSlot)
      .sort((a, b) => a.t - b.t);

    if (!ups.length) return null;

    const sequence = ups.map((ev) => ev.skillSlot as number);
    const maxLevel = Math.min(sequence.length, 18);

    // grid[slotIndex][levelIndex] — slot is 1..4 (Q/W/E/R).
    const grid: boolean[][] = SKILL_KEYS.map(() => new Array(maxLevel).fill(false));
    for (let level = 0; level < maxLevel; level++) {
      const slot = sequence[level];
      if (slot >= 1 && slot <= 4) grid[slot - 1][level] = true;
    }

    return { grid, levels: maxLevel, sequence };
  });

  /** Final items from the match record, for players without timeline data. */
  readonly finalItems = computed(() => this.activePlayer()?.items?.filter((i) => i > 0) ?? []);

  selectPlayer(pid: number): void {
    this.selectedPid.set(pid);
  }

  championIcon(name: string): string {
    return this.riotApi.getChampionIconUrl(name);
  }

  itemIcon(id: number): string {
    return this.riotApi.getItemIconUrl(id);
  }

  isActive(p: MatchDetailParticipant): boolean {
    return p.participantId === this.activePid();
  }
}
