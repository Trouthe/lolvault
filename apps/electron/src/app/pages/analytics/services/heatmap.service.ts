import { Injectable } from '@angular/core';
import { CompactTimeline, TimelineEvent } from '../../../../types/electron';
import { MAP_MAX, TF } from '../models/analytics.types';

export interface MapPoint {
  x: number;
  y: number;
  minute: number;
  /** 1 for a real sample, lower for interpolated path points. */
  weight: number;
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

export type FeedKind = 'kill' | 'tower' | 'inhibitor' | 'dragon' | 'baron' | 'herald';

/** One row in the match timeline panel. */
export interface FeedEvent {
  /** Milliseconds from game start. */
  at: number;
  kind: FeedKind;
  /** True when the account holder's team benefited. */
  friendly: boolean;
  title: string;
  subtitle: string;
  actorChampion: string;
  targetChampion?: string;
  assists?: string[];
  multiKill?: number;
  monsterSubType?: string | null;
}

/** Positions bucketed by minute so a time slider slices instead of rescanning. */
export interface BucketedPositions {
  /** `byMinute[minute]` → points recorded during that minute. */
  byMinute: MapPoint[][];
  maxMinute: number;
  total: number;
}

/** A square density grid in canvas orientation (row-major, origin top-left). */
export interface DensityField {
  values: Float32Array;
  size: number;
  /**
   * Normalisation ceiling. A high percentile rather than the raw peak, so one
   * extreme cell cannot flatten the rest of the ramp.
   */
  ceiling: number;
}

/**
 * Team spawn points on Summoner's Rift, in Riot's timeline coordinates, and the
 * radius around them treated as "in base".
 *
 * Riot keeps reporting a position while a champion is dead or recalled, parked
 * on the fountain. Left in, those samples become the single densest cell on
 * every map — every player's hottest spot is their own fountain, which says
 * nothing about where the game was played.
 */
const FOUNTAINS = [
  { x: 396, y: 462 },
  { x: 14340, y: 14390 },
];
const FOUNTAIN_RADIUS = 1250;

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
   *
   * Riot samples position only once per minute, which on its own is far too
   * sparse to read as a heatmap — a 30-minute game gives 30 dots for one player.
   * Consecutive samples are therefore interpolated along the straight line
   * between them, approximating the path walked and producing a density field
   * that actually shows where time was spent.
   *
   * Every point along a segment carries the same weight, including the real
   * endpoint: the grid is meant to measure *time spent*, and a minute standing
   * still (where all the interpolated points collapse onto one spot) genuinely
   * is a minute in that place. Weighting the endpoints higher would have made
   * the once-a-minute sampling instants visible as beads along each path.
   *
   * Pre-bucketing once at load keeps slider interaction O(window) rather than
   * rescanning every frame on each tick.
   */
  bucketPositions(
    timeline: CompactTimeline,
    participantIds: number[],
    interpolationSteps = 8
  ): BucketedPositions {
    const byMinute: MapPoint[][] = timeline.frames.map(() => []);
    const respawnFrames = this.respawnFrames(timeline);
    let total = 0;

    for (const pid of participantIds) {
      let prev: { x: number; y: number } | null = null;
      const respawns = respawnFrames.get(pid);

      for (let frameIndex = 0; frameIndex < timeline.frames.length; frameIndex++) {
        const row = timeline.frames[frameIndex][pid - 1];
        if (!row) continue;

        const x = row[TF.X];
        const y = row[TF.Y];
        if (!this.isOnMap(x, y)) {
          prev = null;
          continue;
        }

        byMinute[frameIndex].push({ x, y, minute: frameIndex, weight: 1 });
        total++;

        // A death between the two samples means this position was reached by
        // respawning, not by walking; so does an implausibly long jump
        // (a teleport). Interpolating either paints a path through terrain the
        // player never crossed.
        const respawned = respawns?.has(frameIndex) ?? false;

        if (prev && !respawned) {
          const dx = x - prev.x;
          const dy = y - prev.y;

          if (Math.hypot(dx, dy) < MAP_MAX * 0.42) {
            for (let step = 1; step < interpolationSteps; step++) {
              const t = step / interpolationSteps;
              byMinute[frameIndex].push({
                x: prev.x + dx * t,
                y: prev.y + dy * t,
                minute: frameIndex,
                weight: 1,
              });
              total++;
            }
          }
        }

        prev = { x, y };
      }
    }

    return { byMinute, maxMinute: Math.max(0, byMinute.length - 1), total };
  }

  /**
   * Accumulates points into a Gaussian density grid.
   *
   * Density is summed as floating point rather than as canvas alpha. Alpha
   * compositing saturates after four or five overlapping stamps — a threshold a
   * laner crosses within the first few minutes — after which every busy area
   * paints the identical maximum colour and the map stops distinguishing a lane
   * from a camp. Summing first and mapping to colour afterwards keeps the full
   * dynamic range.
   */
  densityField(points: MapPoint[], size = 160, radiusCells = 7): DensityField {
    const values = new Float32Array(size * size);
    if (!points.length) return { values, size, ceiling: 0 };

    const span = radiusCells * 2 + 1;
    const kernel = new Float32Array(span * span);
    const twoSigmaSq = 2 * (radiusCells / 2) ** 2;
    const radiusSq = radiusCells * radiusCells;

    for (let ky = 0; ky < span; ky++) {
      for (let kx = 0; kx < span; kx++) {
        const dx = kx - radiusCells;
        const dy = ky - radiusCells;
        const distanceSq = dx * dx + dy * dy;
        kernel[ky * span + kx] =
          distanceSq > radiusSq ? 0 : Math.exp(-distanceSq / twoSigmaSq);
      }
    }

    for (const point of points) {
      // Same Y flip as `toCanvas` — the grid is already in canvas orientation.
      const gx = Math.round((point.x / MAP_MAX) * (size - 1));
      const gy = Math.round((1 - point.y / MAP_MAX) * (size - 1));
      if (gx < 0 || gy < 0 || gx >= size || gy >= size) continue;

      const xFrom = Math.max(0, gx - radiusCells);
      const xTo = Math.min(size - 1, gx + radiusCells);
      const yFrom = Math.max(0, gy - radiusCells);
      const yTo = Math.min(size - 1, gy + radiusCells);

      for (let y = yFrom; y <= yTo; y++) {
        const kernelRow = (y - gy + radiusCells) * span;
        const valueRow = y * size;
        for (let x = xFrom; x <= xTo; x++) {
          values[valueRow + x] += kernel[kernelRow + (x - gx + radiusCells)] * point.weight;
        }
      }
    }

    return { values, size, ceiling: this.percentile(values, 0.995) };
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

  /**
   * Chronological feed of notable events for the timeline panel.
   *
   * Participant ids are resolved to champion/player names so each row reads as
   * "who did what to whom", rather than raw numeric ids.
   */
  buildEventFeed(
    timeline: CompactTimeline,
    participants: {
      participantId: number;
      championName: string;
      riotIdGameName: string;
      teamId: number;
    }[],
    allyTeamId: number | null
  ): FeedEvent[] {
    const byId = new Map(participants.map((p) => [p.participantId, p]));
    const feed: FeedEvent[] = [];

    for (const ev of timeline.events) {
      const at = ev.t;
      const friendlyOf = (pid?: number) => {
        const p = pid ? byId.get(pid) : undefined;
        return p && allyTeamId !== null ? p.teamId === allyTeamId : false;
      };

      switch (ev.type) {
        case 'CHAMPION_KILL': {
          const killer = ev.killerId ? byId.get(ev.killerId) : undefined;
          const victim = ev.victimId ? byId.get(ev.victimId) : undefined;
          if (!victim) break;
          feed.push({
            at,
            kind: 'kill',
            friendly: friendlyOf(ev.killerId),
            // An unattributed killer is an execution by minions/turret.
            title: killer ? `${killer.championName} killed ${victim.championName}` : `${victim.championName} was executed`,
            subtitle: killer?.riotIdGameName ?? '',
            actorChampion: killer?.championName ?? '',
            targetChampion: victim.championName,
            assists: (ev.assists ?? [])
              .map((id) => byId.get(id)?.championName)
              .filter((n): n is string => !!n),
            multiKill: ev.multiKill && ev.multiKill > 1 ? ev.multiKill : undefined,
          });
          break;
        }

        case 'ELITE_MONSTER_KILL': {
          const killer = ev.killerId ? byId.get(ev.killerId) : undefined;
          const type = (ev.monsterType || '').toUpperCase();
          const kind = type.includes('BARON')
            ? 'baron'
            : type.includes('HERALD')
              ? 'herald'
              : 'dragon';
          feed.push({
            at,
            kind,
            friendly:
              allyTeamId !== null && ev.killerTeamId ? ev.killerTeamId === allyTeamId : friendlyOf(ev.killerId),
            title: this.monsterTitle(ev.monsterType, ev.monsterSubType),
            subtitle: killer ? `${killer.championName} · ${killer.riotIdGameName}` : '',
            actorChampion: killer?.championName ?? '',
            monsterSubType: ev.monsterSubType ?? null,
          });
          break;
        }

        case 'BUILDING_KILL': {
          const killer = ev.killerId ? byId.get(ev.killerId) : undefined;
          const inhibitor = ev.buildingType === 'INHIBITOR_BUILDING';
          // `teamId` is the team that OWNED the destroyed building.
          const destroyedOurs = allyTeamId !== null && ev.teamId === allyTeamId;
          feed.push({
            at,
            kind: inhibitor ? 'inhibitor' : 'tower',
            friendly: !destroyedOurs,
            title: inhibitor ? 'Inhibitor destroyed' : `${this.laneLabel(ev.laneType)} turret destroyed`,
            subtitle: killer ? `${killer.championName} · ${killer.riotIdGameName}` : '',
            actorChampion: killer?.championName ?? '',
          });
          break;
        }

        default:
          break;
      }
    }

    return feed.sort((a, b) => a.at - b.at);
  }

  private monsterTitle(monsterType?: string, subType?: string | null): string {
    const type = (monsterType || '').toUpperCase();
    if (type.includes('BARON')) return 'Baron Nashor slain';
    if (type.includes('HERALD')) return 'Rift Herald slain';
    if (subType) return `${this.titleCase(subType)} slain`;
    return 'Dragon slain';
  }

  private laneLabel(lane?: string): string {
    switch ((lane || '').toUpperCase()) {
      case 'TOP_LANE':
        return 'Top';
      case 'MID_LANE':
        return 'Mid';
      case 'BOT_LANE':
        return 'Bot';
      default:
        return 'Lane';
    }
  }

  private pos(ev: TimelineEvent): { x: number; y: number } {
    return { x: ev.x ?? 0, y: ev.y ?? 0 };
  }

  /**
   * True when a sample represents real presence on the map. (0,0) is the
   * pre-game / undefined position; the fountain is base time — dead, recalled
   * or shopping — which is not somewhere the player was playing.
   */
  private isOnMap(x: number, y: number): boolean {
    if (x <= 0 && y <= 0) return false;
    return !FOUNTAINS.some((f) => Math.hypot(x - f.x, y - f.y) <= FOUNTAIN_RADIUS);
  }

  /**
   * Frame index of the first sample after each death, per participant — the
   * point at which a champion's position jumps to the fountain and back out
   * without walking the distance.
   */
  private respawnFrames(timeline: CompactTimeline): Map<number, Set<number>> {
    const interval = timeline.frameInterval || 60_000;
    const byVictim = new Map<number, Set<number>>();

    for (const ev of timeline.events) {
      if (ev.type !== 'CHAMPION_KILL' || !ev.victimId) continue;
      const frame = Math.ceil(ev.t / interval);
      let frames = byVictim.get(ev.victimId);
      if (!frames) byVictim.set(ev.victimId, (frames = new Set()));
      frames.add(frame);
    }

    return byVictim;
  }

  /** Value at `q` through the non-empty cells, used as the ramp's ceiling. */
  private percentile(values: Float32Array, q: number): number {
    const filled: number[] = [];
    for (const value of values) {
      if (value > 0) filled.push(value);
    }
    if (!filled.length) return 0;

    filled.sort((a, b) => a - b);
    const index = Math.min(filled.length - 1, Math.floor(filled.length * q));
    return filled[index];
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
