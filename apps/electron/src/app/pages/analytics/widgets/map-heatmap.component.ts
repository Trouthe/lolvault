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
import {
  CompactTimeline,
  MatchCacheRow,
  MatchDetail,
} from '../../../../types/electron';
import { HeatmapService, MapMarker } from '../services/heatmap.service';
import { RiotApiService } from '../../../services/riot-api.service';
import { EmptyStateComponent } from './empty-state.component';
import { SegmentOption, SegmentedToggleComponent } from './segmented-toggle.component';

type WindowPreset = 'all' | 'early' | 'mid' | 'late';

const MINIMAP_SRC = 'assets/game-images/minimap_summoners-rift.png';

/** Backing-store size; drawn at min(dpr, 2) to avoid pointless cost on hi-DPI. */
const BASE_SIZE = 512;

@Component({
  selector: 'app-map-heatmap',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, EmptyStateComponent, SegmentedToggleComponent],
  templateUrl: './map-heatmap.component.html',
  styleUrl: './map-heatmap.component.scss',
})
export class MapHeatmapComponent implements AfterViewInit, OnDestroy {
  private heatmap = inject(HeatmapService);
  private riotApi = inject(RiotApiService);

  match = input.required<MatchCacheRow>();
  detail = input.required<MatchDetail>();
  timeline = input.required<CompactTimeline | null>();

  private baseCanvas = viewChild<ElementRef<HTMLCanvasElement>>('baseLayer');
  private heatCanvas = viewChild<ElementRef<HTMLCanvasElement>>('heatLayer');
  private markerCanvas = viewChild<ElementRef<HTMLCanvasElement>>('markerLayer');

  /** Whose positions are plotted: the account holder, or the whole team. */
  readonly scope = signal<'self' | 'team'>('self');
  readonly startMinute = signal(0);
  readonly endMinute = signal(0);
  readonly showMarkers = signal(true);

  readonly scopeOptions: SegmentOption<'self' | 'team'>[] = [
    { value: 'self', label: 'You' },
    { value: 'team', label: 'Your team' },
  ];

  readonly presetOptions: SegmentOption<WindowPreset>[] = [
    { value: 'all', label: 'Full game' },
    { value: 'early', label: '0-15' },
    { value: 'mid', label: '15-25' },
    { value: 'late', label: '25+' },
  ];

  readonly activePreset = signal<WindowPreset>('all');

  private minimap: HTMLImageElement | null = null;
  private blob: HTMLCanvasElement | null = null;
  private rafHandle = 0;
  private ready = signal(false);

  readonly hasTimeline = computed(() => !!this.timeline()?.frames?.length);

  /** participantIds plotted for the current scope. */
  private readonly focusIds = computed<number[]>(() => {
    const detail = this.detail();
    const myTeam = this.match().team_id;
    const myPid = this.match().participant_id;

    if (this.scope() === 'self') return myPid ? [myPid] : [];
    return detail.participants.filter((p) => p.teamId === myTeam).map((p) => p.participantId);
  });

  private readonly allyIds = computed(() => {
    const myTeam = this.match().team_id;
    return new Set(
      this.detail()
        .participants.filter((p) => p.teamId === myTeam)
        .map((p) => p.participantId)
    );
  });

  private readonly buckets = computed(() => {
    const tl = this.timeline();
    const ids = this.focusIds();
    if (!tl || !ids.length) return null;
    return this.heatmap.bucketPositions(tl, ids);
  });

  private readonly markers = computed<MapMarker[]>(() => {
    const tl = this.timeline();
    if (!tl) return [];
    const focusPid = this.scope() === 'self' ? (this.match().participant_id ?? null) : null;
    return this.heatmap.buildMarkers(tl, focusPid, this.allyIds());
  });

  readonly maxMinute = computed(() => this.buckets()?.maxMinute ?? 0);

  readonly visibleMarkers = computed(() =>
    this.showMarkers()
      ? this.heatmap.markersInRange(this.markers(), this.startMinute(), this.endMinute())
      : []
  );

  readonly markerCounts = computed(() => {
    const counts = { kill: 0, death: 0, objective: 0 };
    for (const m of this.visibleMarkers()) {
      if (m.kind === 'kill') counts.kill++;
      else if (m.kind === 'death') counts.death++;
      else counts.objective++;
    }
    return counts;
  });

  readonly pointCount = computed(() => {
    const buckets = this.buckets();
    if (!buckets) return 0;
    return this.heatmap.pointsInRange(buckets, this.startMinute(), this.endMinute()).length;
  });

  constructor() {
    // Default the window to the whole game once a timeline arrives.
    effect(() => {
      const max = this.maxMinute();
      if (max > 0 && this.endMinute() === 0) this.endMinute.set(max);
    });

    // Any change to window/scope schedules exactly one repaint per frame,
    // so dragging the slider coalesces instead of redrawing per input event.
    effect(() => {
      this.startMinute();
      this.endMinute();
      this.scope();
      this.showMarkers();
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
      this.drawMarkers();
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
   * Density pass: stamp a cached radial-alpha blob per point onto a greyscale
   * buffer, then map accumulated alpha through a colour ramp in one pixel pass.
   * That is one cheap drawImage per point plus a single getImageData — fast
   * enough for the ~1,500-point worst case inside a frame budget.
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

    ctx.globalAlpha = 0.32;
    for (const p of points) {
      const { x, y } = this.heatmap.toCanvas(p.x, p.y, BASE_SIZE);
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
      const t = alpha / 255;
      const [r, g, b] = this.ramp(t);
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = Math.min(255, alpha * 1.5);
    }

    ctx.putImageData(image, 0, 0);
  }

  /** Cool blue (sparse) → green → amber → red (dense). */
  private ramp(t: number): [number, number, number] {
    const stops: { at: number; rgb: [number, number, number] }[] = [
      { at: 0.0, rgb: [40, 90, 200] },
      { at: 0.35, rgb: [35, 165, 130] },
      { at: 0.65, rgb: [225, 175, 55] },
      { at: 1.0, rgb: [220, 55, 60] },
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

  /** Markers are vector paths — no assets to load and they recolour per team. */
  private drawMarkers(): void {
    const canvas = this.markerCanvas()?.nativeElement;
    if (!canvas) return;
    const ctx = this.setupCanvas(canvas);
    if (!ctx) return;

    for (const marker of this.visibleMarkers()) {
      const { x, y } = this.heatmap.toCanvas(marker.x, marker.y, BASE_SIZE);
      switch (marker.kind) {
        case 'kill':
          this.drawCross(ctx, x, y, '#5ad18f');
          break;
        case 'death':
          this.drawSkull(ctx, x, y, '#ff6b7d');
          break;
        case 'tower':
        case 'inhibitor':
          this.drawSquare(ctx, x, y, marker.friendly ? '#6fa8ff' : '#ff9d6b');
          break;
        default:
          this.drawDiamond(ctx, x, y, marker.friendly ? '#c9a227' : '#b06fd6');
      }
    }
  }

  private drawCross(ctx: CanvasRenderingContext2D, x: number, y: number, color: string): void {
    const r = 4.5;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.shadowColor = 'rgba(0,0,0,0.85)';
    ctx.shadowBlur = 3;
    ctx.beginPath();
    ctx.moveTo(x - r, y - r);
    ctx.lineTo(x + r, y + r);
    ctx.moveTo(x + r, y - r);
    ctx.lineTo(x - r, y + r);
    ctx.stroke();
    ctx.restore();
  }

  private drawSkull(ctx: CanvasRenderingContext2D, x: number, y: number, color: string): void {
    ctx.save();
    ctx.fillStyle = color;
    ctx.shadowColor = 'rgba(0,0,0,0.85)';
    ctx.shadowBlur = 3;
    // Cranium
    ctx.beginPath();
    ctx.arc(x, y - 1, 4.2, Math.PI, 0);
    ctx.lineTo(x + 4.2, y + 1.6);
    ctx.lineTo(x - 4.2, y + 1.6);
    ctx.closePath();
    ctx.fill();
    // Jaw
    ctx.fillRect(x - 2.6, y + 1.6, 5.2, 2.4);
    // Eyes
    ctx.fillStyle = 'rgba(0,0,0,0.85)';
    ctx.beginPath();
    ctx.arc(x - 1.7, y - 0.8, 1.15, 0, Math.PI * 2);
    ctx.arc(x + 1.7, y - 0.8, 1.15, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawSquare(ctx: CanvasRenderingContext2D, x: number, y: number, color: string): void {
    ctx.save();
    ctx.fillStyle = color;
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.lineWidth = 1.2;
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 3;
    ctx.beginPath();
    ctx.rect(x - 3.6, y - 3.6, 7.2, 7.2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  private drawDiamond(ctx: CanvasRenderingContext2D, x: number, y: number, color: string): void {
    ctx.save();
    ctx.fillStyle = color;
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.lineWidth = 1.2;
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 3;
    ctx.beginPath();
    ctx.moveTo(x, y - 5);
    ctx.lineTo(x + 4.4, y);
    ctx.lineTo(x, y + 5);
    ctx.lineTo(x - 4.4, y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  /** Radial alpha gradient, built once and reused for every point. */
  private createBlob(): HTMLCanvasElement {
    const radius = 17;
    const size = radius * 2;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;

    const ctx = canvas.getContext('2d');
    if (ctx) {
      const gradient = ctx.createRadialGradient(radius, radius, 0, radius, radius, radius);
      gradient.addColorStop(0, 'rgba(0,0,0,1)');
      gradient.addColorStop(0.5, 'rgba(0,0,0,0.42)');
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

  championIcon(name: string): string {
    return this.riotApi.getChampionIconUrl(name);
  }
}
