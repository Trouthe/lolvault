import { Injectable, signal } from '@angular/core';

/**
 * Resolved chart palette, read from the live CSS custom properties.
 *
 * ApexCharts needs concrete colour strings — it cannot consume `var(--x)` — so
 * the theme variables are resolved from the document at call time. Re-resolved
 * whenever the theme changes so all 10 themes (and light/dark) stay correct.
 */
export interface ChartPalette {
  text: string;
  secondaryText: string;
  border: string;
  card: string;
  muted: string;
  win: string;
  loss: string;
  gold: string;
  blueTeam: string;
  redTeam: string;
  isDark: boolean;
}

/** Fallbacks used before the DOM is ready or if a variable is missing. */
const FALLBACK: ChartPalette = {
  text: '#e6e6e6',
  secondaryText: '#9a9a9a',
  border: '#2f2f2f',
  card: '#1c1c1c',
  muted: '#262626',
  win: '#2f9e6f',
  loss: '#d6455d',
  gold: '#c89b3c',
  blueTeam: '#3b82f6',
  redTeam: '#ef4444',
  isDark: true,
};

@Injectable({ providedIn: 'root' })
export class ChartThemeService {
  /** Bumped whenever the theme changes so chart options recompute. */
  readonly revision = signal(0);

  private cached: ChartPalette | null = null;
  private observer: MutationObserver | null = null;

  constructor() {
    // The theme is applied as data-attributes on <html>; watching them keeps
    // chart colours in sync without each chart subscribing separately.
    if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
      this.observer = new MutationObserver(() => {
        this.cached = null;
        this.revision.update((v) => v + 1);
      });
      this.observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme', 'data-theme-variant'],
      });
    }
  }

  /** Current palette, resolved from CSS custom properties. */
  palette(): ChartPalette {
    if (this.cached) return this.cached;
    if (typeof window === 'undefined' || typeof document === 'undefined') return FALLBACK;

    const styles = getComputedStyle(document.documentElement);
    const read = (name: string, fallback: string): string => {
      const value = styles.getPropertyValue(name).trim();
      return value || fallback;
    };

    const isDark = document.documentElement.getAttribute('data-theme') !== 'light';

    this.cached = {
      text: read('--primary-text', FALLBACK.text),
      secondaryText: read('--secondary-text', FALLBACK.secondaryText),
      border: read('--border-color', FALLBACK.border),
      card: read('--card', FALLBACK.card),
      muted: read('--muted', FALLBACK.muted),
      win: FALLBACK.win,
      loss: FALLBACK.loss,
      gold: FALLBACK.gold,
      blueTeam: FALLBACK.blueTeam,
      redTeam: FALLBACK.redTeam,
      isDark,
    };
    return this.cached;
  }

  /**
   * Base ApexCharts options every analytics chart starts from — transparent
   * background, no toolbar, themed grid/axis colours.
   */
  baseOptions(height = 200) {
    const p = this.palette();
    return {
      chart: {
        height,
        background: 'transparent',
        toolbar: { show: false },
        zoom: { enabled: false },
        fontFamily: 'inherit',
        animations: { enabled: false },
        parentHeightOffset: 0,
      },
      theme: { mode: (p.isDark ? 'dark' : 'light') as 'dark' | 'light' },
      grid: {
        borderColor: p.border,
        strokeDashArray: 3,
        padding: { left: 8, right: 8, top: 0, bottom: 0 },
      },
      tooltip: {
        theme: (p.isDark ? 'dark' : 'light') as 'dark' | 'light',
        style: { fontSize: '11px' },
      },
      dataLabels: { enabled: false },
      legend: {
        labels: { colors: p.secondaryText },
        fontSize: '11px',
        // Flat colour chips, not outlined dots: a square swatch reads as "this
        // colour is that series" more directly than a bordered circle.
        // ApexCharts v5 replaced the legend marker width/height with `size`.
        markers: {
          size: 6,
          shape: 'square' as const,
          radius: 2,
          strokeWidth: 0,
        },
      },
      stroke: { curve: 'smooth' as const, width: 2 },
    };
  }

  /** Axis label styling shared by every chart. */
  axisLabelStyle() {
    const p = this.palette();
    return { colors: p.secondaryText, fontSize: '10px' };
  }

  /** Forces a re-read on the next `palette()` call. */
  invalidate(): void {
    this.cached = null;
    this.revision.update((v) => v + 1);
  }

  /** Formats seconds of game time as m:ss. */
  static formatGameTime(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }
}
