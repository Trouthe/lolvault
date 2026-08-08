import { Injectable } from '@angular/core';
import { CompactTimeline, TimelineEvent } from '../../../../types/electron';
import { MAP_MAX, TF } from '../models/analytics.types';

export interface MapPoint {
  x: number;
  y: number;
  minute: number;
}

export interface MapMarker {
  x: number;
  y: number;
  minute: number;
  kind: 'kill' | 'death' | 'tower' | 'inhibitor' | 'dragon' | 'baron' | 'herald';
  /** True when the marker belongs to the account holder's team. */
  friendly: boolean;
  label: string;
}

/** Positions bucketed by minute so a time slider slices instead of rescanning. */
export interface BucketedPositions {
  /** `byMinute[minute]` → points recorded during that minute. */
  byMinute: MapPoint[][];
  maxMinute: number;
  total: number;
}

/**
 * Converts timeline data into map-space geometry.
 *
 * Riot's map origin is bottom-left while canvas is top-left, so Y is flipped
 * exactly once — here. Getting this wrong yields a plausible-looking but
 * mirrored map, so `toCanvas` is the single place the transform lives.
 */
@Injectable({ providedIn: 'root' })
export class HeatmapService {
  /**
   * Maps Summoner's Rift coordinates (0..14870, origin bottom-left) onto a
   * square canvas of `size` pixels (origin top-left).
   */
  toCanvas(x: number, y: number, size: number): { x: number; y: number } {
    return {
      x: (x / MAP_MAX) * size,
      y: (1 - y / MAP_MAX) * size,
    };
  }

  /**
   * Buckets participant positions by minute.
   * Pre-bucketing once at load keeps slider interaction O(window) rather than
   * rescanning every frame on each tick.
   */
  bucketPositions(timeline: CompactTimeline, participantIds: number[]): BucketedPositions {
    const byMinute: MapPoint[][] = [];
    let total = 0;

    for (let frameIndex = 0; frameIndex < timeline.frames.length; frameIndex++) {
      const frame = timeline.frames[frameIndex];
      const bucket: MapPoint[] = [];

      for (const pid of participantIds) {
        const row = frame[pid - 1];
        if (!row) continue;
        const x = row[TF.X];
        const y = row[TF.Y];
        // (0,0) is the pre-game/undefined position, not a real map location.
        if (x <= 0 && y <= 0) continue;
        bucket.push({ x, y, minute: frameIndex });
        total++;
      }

      byMinute.push(bucket);
    }

    return { byMinute, maxMinute: Math.max(0, byMinute.length - 1), total };
  }

  /** Points within an inclusive minute range. */
  pointsInRange(buckets: BucketedPositions, startMinute: number, endMinute: number): MapPoint[] {
    const out: MapPoint[] = [];
    const from = Math.max(0, startMinute);
    const to = Math.min(buckets.byMinute.length - 1, endMinute);
    for (let m = from; m <= to; m++) {
      const bucket = buckets.byMinute[m];
      if (bucket) out.push(...bucket);
    }
    return out;
  }

  /**
   * Kills, deaths and objective takes as positioned markers.
   *
   * `focusPid` decides which champion kills read as kills (they killed someone)
   * versus deaths (they were the victim).
   */
  buildMarkers(
    timeline: CompactTimeline,
    focusPid: number | null,
    allyParticipantIds: Set<number>
  ): MapMarker[] {
    const markers: MapMarker[] = [];

    for (const ev of timeline.events) {
      if (ev.x === undefined || ev.y === undefined) continue;
      const minute = Math.floor(ev.t / 60_000);

      switch (ev.type) {
        case 'CHAMPION_KILL': {
          const killerIsAlly = ev.killerId ? allyParticipantIds.has(ev.killerId) : false;
          if (focusPid !== null) {
            // Only the focused player's own kills and deaths, to keep the map readable.
            if (ev.killerId === focusPid) {
              markers.push({ ...this.pos(ev), minute, kind: 'kill', friendly: true, label: 'Kill' });
            } else if (ev.victimId === focusPid) {
              markers.push({ ...this.pos(ev), minute, kind: 'death', friendly: false, label: 'Death' });
            }
          } else {
            markers.push({
              ...this.pos(ev),
              minute,
              kind: killerIsAlly ? 'kill' : 'death',
              friendly: killerIsAlly,
              label: killerIsAlly ? 'Ally kill' : 'Enemy kill',
            });
          }
          break;
        }

        case 'BUILDING_KILL': {
          // teamId on this event is the team that OWNED the destroyed building,
          // so an ally-owned building falling is a loss for us.
          const destroyedOurs = ev.teamId ? this.teamIdToAlly(ev.teamId, allyParticipantIds) : false;
          markers.push({
            ...this.pos(ev),
            minute,
            kind: ev.buildingType === 'INHIBITOR_BUILDING' ? 'inhibitor' : 'tower',
            friendly: !destroyedOurs,
            label: ev.buildingType === 'INHIBITOR_BUILDING' ? 'Inhibitor' : 'Tower',
          });
          break;
        }

        case 'ELITE_MONSTER_KILL': {
          const type = (ev.monsterType || '').toUpperCase();
          const kind = type.includes('BARON')
            ? 'baron'
            : type.includes('HERALD')
              ? 'herald'
              : 'dragon';
          const friendly = ev.killerId ? allyParticipantIds.has(ev.killerId) : false;
          markers.push({
            ...this.pos(ev),
            minute,
            kind,
            friendly,
            label: this.titleCase(ev.monsterSubType || ev.monsterType || 'Objective'),
          });
          break;
        }

        default:
          break;
      }
    }

    return markers;
  }

  /** Markers within an inclusive minute range. */
  markersInRange(markers: MapMarker[], startMinute: number, endMinute: number): MapMarker[] {
    return markers.filter((m) => m.minute >= startMinute && m.minute <= endMinute);
  }

  private pos(ev: TimelineEvent): { x: number; y: number } {
    return { x: ev.x ?? 0, y: ev.y ?? 0 };
  }

  /** Team 100 owns participant ids 1-5, team 200 owns 6-10. */
  private teamIdToAlly(teamId: number, allyParticipantIds: Set<number>): boolean {
    const probe = teamId === 100 ? 1 : 6;
    return allyParticipantIds.has(probe);
  }

  private titleCase(value: string): string {
    return value
      .toLowerCase()
      .split('_')
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }
}
