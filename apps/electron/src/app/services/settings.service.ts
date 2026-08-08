import { Injectable, signal } from '@angular/core';

export type CardLayout = 'list' | 'grid';

export interface AppSettings {
  riotClientPath: string;
  showMasteryBackground: boolean;
  syncWithWeb: boolean;
  /** Account card presentation on the dashboard. */
  cardLayout: CardLayout;
  /** When true, the League config files are held read-only so Riot cannot rewrite them. */
  persistentGameSettings: boolean;
  /** Folder holding League's config files. Empty means "derive from the Riot Client path". */
  leagueConfigPath: string;
}

function isMacPlatform(): boolean {
  return navigator.userAgent.toLowerCase().includes('mac');
}

function getDefaultRiotClientPath(): string {
  if (isMacPlatform()) return '/Applications/Riot Client.app';
  return 'C:\\Riot Games\\Riot Client\\RiotClientServices.exe';
}

const DEFAULT_SETTINGS: AppSettings = {
  riotClientPath: getDefaultRiotClientPath(),
  showMasteryBackground: false,
  syncWithWeb: false,
  cardLayout: 'list',
  persistentGameSettings: false,
  leagueConfigPath: '',
};

@Injectable({
  providedIn: 'root',
})
export class SettingsService {
  private readonly STORAGE_KEY = 'lolvault-settings';
  settings = signal<AppSettings>(this.loadSettings());

  constructor() {
    this.settings.set(this.loadSettings());
  }

  private loadSettings(): AppSettings {
    try {
      const stored = localStorage.getItem(this.STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        return { ...DEFAULT_SETTINGS, ...parsed };
      }
    } catch (error) {
      console.error('Error loading settings:', error);
    }
    return { ...DEFAULT_SETTINGS };
  }

  private saveSettings(settings: AppSettings): void {
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(settings));
    } catch (error) {
      console.error('Error saving settings:', error);
    }
  }

  private update(patch: Partial<AppSettings>): void {
    const newSettings = { ...this.settings(), ...patch };
    this.settings.set(newSettings);
    this.saveSettings(newSettings);
  }

  updateRiotClientPath(path: string): void {
    this.update({ riotClientPath: path });
  }

  getRiotClientPath(): string {
    return this.settings().riotClientPath;
  }

  toggleMasteryBackground(show: boolean): void {
    this.update({ showMasteryBackground: show });
  }

  toggleSyncWithWeb(enabled: boolean): void {
    this.update({ syncWithWeb: enabled });
  }

  getSyncWithWeb(): boolean {
    return this.settings().syncWithWeb;
  }

  getShowMasteryBackground(): boolean {
    return this.settings().showMasteryBackground;
  }

  // ── Card layout ─────────────────────────────────────────────────────────────

  getCardLayout(): CardLayout {
    return this.settings().cardLayout;
  }

  setCardLayout(layout: CardLayout): void {
    this.update({ cardLayout: layout });
  }

  toggleCardLayout(): CardLayout {
    const next: CardLayout = this.getCardLayout() === 'grid' ? 'list' : 'grid';
    this.setCardLayout(next);
    return next;
  }

  // ── Persistent game settings ────────────────────────────────────────────────

  getPersistentGameSettings(): boolean {
    return this.settings().persistentGameSettings;
  }

  setPersistentGameSettings(enabled: boolean): void {
    this.update({ persistentGameSettings: enabled });
  }

  setLeagueConfigPath(path: string): void {
    this.update({ leagueConfigPath: path });
  }

  /**
   * Configured League config folder, falling back to the location derived from
   * the Riot Client path (…/Riot Games/League of Legends/Config).
   */
  getLeagueConfigPath(): string {
    const configured = this.settings().leagueConfigPath?.trim();
    if (configured) return configured;
    return this.deriveLeagueConfigPath();
  }

  /** True when the folder in use is derived rather than explicitly chosen. */
  isLeagueConfigPathDerived(): boolean {
    return !this.settings().leagueConfigPath?.trim();
  }

  private deriveLeagueConfigPath(): string {
    const clientPath = this.settings().riotClientPath?.trim();

    if (isMacPlatform()) {
      return '/Applications/League of Legends.app/Contents/LoL/Config';
    }

    if (!clientPath) return 'C:\\Riot Games\\League of Legends\\Config';

    // C:\Riot Games\Riot Client\RiotClientServices.exe → C:\Riot Games
    const segments = clientPath.replace(/\//g, '\\').split('\\').filter(Boolean);
    if (segments.length >= 3) {
      const gamesRoot = segments.slice(0, segments.length - 2).join('\\');
      return `${gamesRoot}\\League of Legends\\Config`;
    }

    return 'C:\\Riot Games\\League of Legends\\Config';
  }

  resetToDefaults(): void {
    this.settings.set({ ...DEFAULT_SETTINGS });
    this.saveSettings(DEFAULT_SETTINGS);
  }
}
