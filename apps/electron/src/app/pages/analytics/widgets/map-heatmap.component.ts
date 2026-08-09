import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { CompactTimeline, MatchCacheRow, MatchDetail } from '../../../../types/electron';
import { HeatmapService, MapMarker } from '../services/heatmap.service';
import {
  DEATH_ICON_RED,
  KILL_ICON,
  dragonLabel,
  objectiveIcon,
} from '../services/game-assets';
import { EmptyStateComponent } from './empty-state.component';
import { SegmentOption, SegmentedToggleComponent } from './segmented-toggle.component';

type WindowPreset = 'all' | 'early' | 'mid' | 'late';

const MINIMAP_SRC = 'assets/game-images/minimap_summoners-rift.png';

/** Backing-store size; drawn at min(dpr, 2) to avoid pointless cost on hi-DPI. */
const BASE_SIZE = 512;

/**
 * Density grid resolution and kernel radius, in cells. 160 cells across the
 * 512px map is ~3.2px per cell; the Gaussian already smooths the field, so the
 * grid is painted at its own size and scaled up bilinearly rather than being
 * computed per screen pixel.
 */
const GRID_SIZE = 160;
const GRID_RADIUS = 7;

interface PlacedMarker extends MapMarker {
  /** Percentage position within the map box. */
  left: number;
  top: number;
  icon: string;
  tooltip: string;
}

@Component({
  selector: 'app-map-heatmap',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, EmptyStateComponent, SegmentedToggleComponent],
  templateUrl: './map-heatmap.component.html',
  styleUrl: './map-heatmap.component.scss',
})
export class MapHeatmapComponent implements AfterViewInit, OnDestroy {
  private heatmap = inject(HeatmapService);

  match = input.required<MatchCacheRow>();
  detail = input.required<MatchDetail>();
  timeline = input.required<CompactTimeline | null>();

  private baseCanvas = viewChild<ElementRef<HTMLCanvasElement>>('baseLayer');
  private heatCanvas = viewChild<ElementRef<HTMLCanvasElement>>('heatLayer');

  /** Whose positions are plotted. */
  readonly scope = signal<'self' | 'team' | 'enemy'>('self');
  readonly startMinute = signal(0);
  readonly endMinute = signal(0);
  readonly showMarkers = signal(true);
  readonly activePreset = signal<WindowPreset>('all');

  readonly scopeOptions: SegmentOption<'self' | 'team' | 'enemy'>[] = [
    { value: 'self', label: 'You' },
    { value: 'team', label: 'Your team' },
    { value: 'enemy', label: 'Enemy team' },
  ];

  private minimap: HTMLImageElement | null = null;
  private gridBuffer: HTMLCanvasElement | null = null;
  private rafHandle = 0;
  private ready = signal(false);

  readonly hasTimeline = computed(() => !!this.timeline()?.frames?.length);

  private readonly allyTeamId = computed(() => this.match().team_id);

  private readonly focusIds = computed<number[]>(() => {
    const detail = this.detail();
    const myTeam = this.allyTeamId();
    const myPid = this.match().participant_id;

    switch (this.scope()) {
      case 'self':
        return myPid ? [myPid] : [];
      case 'team':
        return detail.participants.filter((p) => p.teamId === myTeam).map((p) => p.participantId);
      default:
        return detail.participants.filter((p) => p.teamId !== myTeam).map((p) => p.participantId);
    }
  });

  private readonly allyIds = computed(
    () =>
      new Set(
        this.detail()
          .participants.filter((p) => p.teamId === this.allyTeamId())
          .map((p) => p.participantId)
      )
  );

  private readonly buckets = computed(() => {
    const tl = this.timeline();
    const ids = this.focusIds();
    if (!tl || !ids.length) return null;
    // One path resolution for every scope. The field is normalised before it is
    // coloured, so a team map is no hotter than a solo one just for having ten
    // times the samples — varying the step count per scope only made the same
    // route look different depending on who else was selected.
    return this.heatmap.bucketPositions(tl, ids, 8);
  });

  private readonly markers = computed<MapMarker[]>(() => {
    const tl = this.timeline();
    if (!tl) return [];
    const focusPid = this.scope() === 'self' ? (this.match().participant_id ?? null) : null;
    return this.heatmap.buildMarkers(tl, focusPid, this.allyIds());
  });

  readonly maxMinute = computed(() => this.buckets()?.maxMinute ?? 0);

  /**
   * Phase shortcuts, offered only where they mean something. On a 16-minute
   * game "15-25" and "25+" select a sliver and nothing at all respectively, so
   * a window appears only once the game is long enough for it to differ from
   * the full game, and the mid label names the range it actually covers.
   */
  readonly presetOptions = computed<SegmentOption<WindowPreset>[]>(() => {
    const max = this.maxMinute();
    const options: SegmentOption<WindowPreset>[] = [{ value: 'all', label: 'Full game' }];

    if (max >= 18) {
      options.push({ value: 'early', label: '0-15' });
      options.push({ value: 'mid', label: `15-${Math.min(25, max)}` });
    }
    if (max >= 28) {
      options.push({ value: 'late', label: '25+' });
    }

    return options;
  });

  /** Markers in the current window, positioned as percentages for DOM overlay. */
  readonly placedMarkers = computed<PlacedMarker[]>(() => {
    if (!this.showMarkers()) return [];
    const inRange = this.heatmap.markersInRange(
      this.markers(),
      this.startMinute(),
      this.endMinute()
    );

    return inRange.map((m) => {
      const p = this.heatmap.toCanvas(m.x, m.y, 100);
      return {
        ...m,
        left: p.x,
        top: p.y,
        icon: this.iconFor(m),
        tooltip: this.tooltipFor(m),
      };
    });
  });

  readonly markerCounts = computed(() => {
    const counts = { kill: 0, death: 0, objective: 0 };
    for (const m of this.placedMarkers()) {
      if (m.kind === 'kill') counts.kill++;
      else if (m.kind === 'death') counts.death++;
      else counts.objective++;
    }
    return counts;
  });

  constructor() {
    // Default the window to the whole game once a timeline arrives.
    effect(() => {
      const max = this.maxMinute();
      if (max > 0 && this.endMinute() === 0) this.endMinute.set(max);
    });

    // Any change to window/scope schedules exactly one repaint per frame, so
    // dragging the slider coalesces instead of redrawing per input event.
    effect(() => {
      this.startMinute();
      this.endMinute();
      this.scope();
      this.buckets();
      if (this.ready()) this.scheduleRender();
    });
  }

  async ngAfterViewInit(): Promise<void> {
    try {
      this.minimap = await this.loadImage(MINIMAP_SRC);
    } catch {
      this.minimap = null; // Heat layer still renders without the backdrop.
    }
    this.ready.set(true);
    this.drawBase();
    this.scheduleRender();
  }

  ngOnDestroy(): void {
    if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
  }

  // ── Marker presentation ────────────────────────────────────────────────────

  private iconFor(m: MapMarker): string {
    const side = m.friendly ? 100 : 200;
    switch (m.kind) {
      case 'kill':
        return KILL_ICON;
      case 'death':
        return DEATH_ICON_RED;
      case 'tower':
        return objectiveIcon('tower', side);
      case 'inhibitor':
        return objectiveIcon('inhibitor', side);
      case 'baron':
        return objectiveIcon('baron', side);
      case 'herald':
        return objectiveIcon('herald', side);
      default:
        return objectiveIcon('dragon', side, m.label);
    }
  }

  private tooltipFor(m: MapMarker): string {
    const at = `${m.minute}:00`;
    switch (m.kind) {
      case 'kill':
        return `Kill · ${at}`;
      case 'death':
        return `Death · ${at}`;
      case 'tower':
        return `${m.friendly ? 'Turret taken' : 'Turret lost'} · ${at}`;
      case 'inhibitor':
        return `${m.friendly ? 'Inhibitor taken' : 'Inhibitor lost'} · ${at}`;
      case 'baron':
        return `Baron Nashor · ${at}`;
      case 'herald':
        return `Rift Herald · ${at}`;
      default:
        return `${dragonLabel(m.label)} · ${at}`;
    }
  }

  // ── Interaction ────────────────────────────────────────────────────────────

  applyPreset(preset: WindowPreset): void {
    this.activePreset.set(preset);
    const max = this.maxMinute();
    switch (preset) {
      case 'early':
        this.startMinute.set(0);
        this.endMinute.set(Math.min(15, max));
        break;
      case 'mid':
        this.startMinute.set(Math.min(15, max));
        this.endMinute.set(Math.min(25, max));
        break;
      case 'late':
        this.startMinute.set(Math.min(25, max));
        this.endMinute.set(max);
        break;
      default:
        this.startMinute.set(0);
        this.endMinute.set(max);
    }
  }

  onStartInput(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.startMinute.set(Math.min(value, this.endMinute()));
    this.activePreset.set('all');
  }

  onEndInput(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.endMinute.set(Math.max(value, this.startMinute()));
    this.activePreset.set('all');
  }

  toggleMarkers(): void {
    this.showMarkers.update((v) => !v);
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  private scheduleRender(): void {
    if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = requestAnimationFrame(() => {
      this.rafHandle = 0;
      this.drawHeat();
    });
  }

  private dpr(): number {
    return Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2);
  }

  private setupCanvas(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
    const scale = this.dpr();
    const px = BASE_SIZE * scale;
    if (canvas.width !== px) {
      canvas.width = px;
      canvas.height = px;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, BASE_SIZE, BASE_SIZE);
    return ctx;
  }

  private drawBase(): void {
    const canvas = this.baseCanvas()?.nativeElement;
    if (!canvas) return;
    const ctx = this.setupCanvas(canvas);
    if (!ctx) return;

    if (this.minimap) {
      ctx.drawImage(this.minimap, 0, 0, BASE_SIZE, BASE_SIZE);
    } else {
      ctx.fillStyle = '#0d1117';
      ctx.fillRect(0, 0, BASE_SIZE, BASE_SIZE);
    }
  }

  /**
   * Density pass: sum the window's points into a normalised Gaussian grid, map
   * it through the colour ramp at grid resolution, then let the canvas scale
   * the result up. Both halves matter — summing in floating point instead of in
   * canvas alpha is what stops every busy area saturating to the same red, and
   * painting 160² pixels instead of a full-resolution read-modify-write is what
   * keeps a slider drag inside a frame.
   */
  private drawHeat(): void {
    const canvas = this.heatCanvas()?.nativeElement;
    const buckets = this.buckets();
    if (!canvas) return;

    const ctx = this.setupCanvas(canvas);
    if (!ctx || !buckets) return;

    const points = this.heatmap.pointsInRange(buckets, this.startMinute(), this.endMinute());
    if (!points.length) return;

    const field = this.heatmap.densityField(points, GRID_SIZE, GRID_RADIUS);
    if (!field.ceiling) return;

    const buffer = (this.gridBuffer ??= document.createElement('canvas'));
    buffer.width = GRID_SIZE;
    buffer.height = GRID_SIZE;

    const gridCtx = buffer.getContext('2d');
    if (!gridCtx) return;

    const image = gridCtx.createImageData(GRID_SIZE, GRID_SIZE);
    const data = image.data;

    for (let i = 0; i < field.values.length; i++) {
      const value = field.values[i];
      if (value <= 0) continue;

      // Gamma lift so the thin end of the range stays legible rather than
      // collapsing into the floor.
      const t = Math.min(1, Math.pow(value / field.ceiling, 0.55));
      if (t < 0.02) continue;

      const [r, g, b] = this.ramp(t);
      const offset = i * 4;
      data[offset] = r;
      data[offset + 1] = g;
      data[offset + 2] = b;
      // Fades out to fully transparent at the fringe. The old floor of 70/255
      // meant anywhere a player merely walked past got a permanent blue wash
      // that hid the map underneath.
      data[offset + 3] = Math.round(Math.min(1, t * 1.3) * 214);
    }

    gridCtx.putImageData(image, 0, 0);

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(buffer, 0, 0, BASE_SIZE, BASE_SIZE);
  }

  /** Cool blue (sparse) → cyan → green → amber → red (dense). */
  private ramp(t: number): [number, number, number] {
    const stops: { at: number; rgb: [number, number, number] }[] = [
      { at: 0.0, rgb: [26, 86, 219] },
      { at: 0.28, rgb: [22, 176, 199] },
      { at: 0.52, rgb: [46, 204, 113] },
      { at: 0.74, rgb: [241, 196, 15] },
      { at: 1.0, rgb: [231, 46, 51] },
    ];

    for (let i = 1; i < stops.length; i++) {
      if (t <= stops[i].at) {
        const prev = stops[i - 1];
        const next = stops[i];
        const span = next.at - prev.at || 1;
        const k = (t - prev.at) / span;
        return [
          Math.round(prev.rgb[0] + (next.rgb[0] - prev.rgb[0]) * k),
          Math.round(prev.rgb[1] + (next.rgb[1] - prev.rgb[1]) * k),
          Math.round(prev.rgb[2] + (next.rgb[2] - prev.rgb[2]) * k),
        ];
      }
    }
    return stops[stops.length - 1].rgb;
  }

  private loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Failed to load ${src}`));
      img.src = src;
    });
  }
}
