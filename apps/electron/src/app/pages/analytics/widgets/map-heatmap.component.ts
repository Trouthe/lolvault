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

  readonly presetOptions: SegmentOption<WindowPreset>[] = [
    { value: 'all', label: 'Full game' },
    { value: 'early', label: '0-15' },
    { value: 'mid', label: '15-25' },
    { value: 'late', label: '25+' },
  ];

  private minimap: HTMLImageElement | null = null;
  private blob: HTMLCanvasElement | null = null;
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
    // Fewer players tracked ⇒ denser interpolation, so a single-player map is
    // as readable as a whole-team one.
    const steps = ids.length > 3 ? 4 : 8;
    return this.heatmap.bucketPositions(tl, ids, steps);
  });

  private readonly markers = computed<MapMarker[]>(() => {
    const tl = this.timeline();
    if (!tl) return [];
    const focusPid = this.scope() === 'self' ? (this.match().participant_id ?? null) : null;
    return this.heatmap.buildMarkers(tl, focusPid, this.allyIds());
  });

  readonly maxMinute = computed(() => this.buckets()?.maxMinute ?? 0);

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

  readonly pointCount = computed(() => {
    const buckets = this.buckets();
    if (!buckets) return 0;
    return this.heatmap
      .pointsInRange(buckets, this.startMinute(), this.endMinute())
      .filter((p) => p.weight === 1).length;
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
    this.blob = this.createBlob();
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
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
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
   * Density pass: stamp a cached radial-alpha blob per point onto a greyscale
   * buffer, then map accumulated alpha through a colour ramp in one pixel pass.
   * One cheap drawImage per point plus a single getImageData keeps this inside a
   * frame budget even for the whole-team, fully-interpolated case.
   */
  private drawHeat(): void {
    const canvas = this.heatCanvas()?.nativeElement;
    const buckets = this.buckets();
    if (!canvas || !this.blob) return;

    const ctx = this.setupCanvas(canvas);
    if (!ctx || !buckets) return;

    const points = this.heatmap.pointsInRange(buckets, this.startMinute(), this.endMinute());
    if (!points.length) return;

    const blobSize = this.blob.width;
    const half = blobSize / 2;

    for (const p of points) {
      const { x, y } = this.heatmap.toCanvas(p.x, p.y, BASE_SIZE);
      ctx.globalAlpha = 0.5 * p.weight;
      ctx.drawImage(this.blob, x - half, y - half);
    }
    ctx.globalAlpha = 1;

    // Colourise accumulated alpha.
    const scale = this.dpr();
    const px = BASE_SIZE * scale;
    const image = ctx.getImageData(0, 0, px, px);
    const data = image.data;

    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3];
      if (alpha === 0) continue;
      // Gamma lift so sparse areas remain visible instead of fading to nothing.
      const t = Math.min(1, Math.pow(alpha / 255, 0.62));
      const [r, g, b] = this.ramp(t);
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = Math.min(235, 70 + t * 185);
    }

    ctx.putImageData(image, 0, 0);
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

  /** Radial alpha gradient, built once and reused for every point. */
  private createBlob(): HTMLCanvasElement {
    const radius = 26;
    const size = radius * 2;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;

    const ctx = canvas.getContext('2d');
    if (ctx) {
      const gradient = ctx.createRadialGradient(radius, radius, 0, radius, radius, radius);
      gradient.addColorStop(0, 'rgba(0,0,0,1)');
      gradient.addColorStop(0.45, 'rgba(0,0,0,0.55)');
      gradient.addColorStop(0.75, 'rgba(0,0,0,0.2)');
      gradient.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, size, size);
    }
    return canvas;
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
