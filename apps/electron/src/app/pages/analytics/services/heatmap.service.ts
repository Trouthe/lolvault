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
   * that actually shows where time was spent. Interpolated points are weighted
   * below real samples so genuine positions still dominate.
   *
   * Pre-bucketing once at load keeps slider interaction O(window) rather than
   * rescanning every frame on each tick.
   */
  bucketPositions(
    timeline: CompactTimeline,
    participantIds: number[],
    interpolationSteps = 6
  ): BucketedPositions {
    const byMinute: MapPoint[][] = timeline.frames.map(() => []);
    let total = 0;

    // (0,0) is the pre-game/undefined position, not a real map location.
    const valid = (x: number, y: number) => !(x <= 0 && y <= 0);

    for (const pid of participantIds) {
      let prev: { x: number; y: number; minute: number } | null = null;

      for (let frameIndex = 0; frameIndex < timeline.frames.length; frameIndex++) {
        const row = timeline.frames[frameIndex][pid - 1];
        if (!row) continue;

        const x = row[TF.X];
        const y = row[TF.Y];
        if (!valid(x, y)) {
          prev = null;
          continue;
        }

        byMinute[frameIndex].push({ x, y, minute: frameIndex, weight: 1 });
        total++;

        if (prev) {
          // A teleport or death-respawn produces an implausibly long jump;
          // interpolating across it would paint a line through terrain the
          // player never walked, so those segments are skipped.
          const dx = x - prev.x;
          const dy = y - prev.y;
          const distance = Math.hypot(dx, dy);

          if (distance < MAP_MAX * 0.42) {
            for (let step = 1; step < interpolationSteps; step++) {
              const t = step / interpolationSteps;
              byMinute[frameIndex].push({
                x: prev.x + dx * t,
                y: prev.y + dy * t,
                minute: frameIndex,
                weight: 0.55,
              });
              total++;
            }
          }
        }

        prev = { x, y, minute: frameIndex };
      }
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
