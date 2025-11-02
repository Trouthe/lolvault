import { Injectable, signal } from '@angular/core';

export interface AppSettings {
  riotClientPath: string;
  showMasteryBackground: boolean;
}

const DEFAULT_SETTINGS: AppSettings = {
  riotClientPath: 'C:\\Riot Games\\Riot Client\\RiotClientServices.exe',
  showMasteryBackground: false,
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

  updateRiotClientPath(path: string): void {
    const newSettings = { ...this.settings(), riotClientPath: path };
    this.settings.set(newSettings);
    this.saveSettings(newSettings);
  }

  getRiotClientPath(): string {
    return this.settings().riotClientPath;
  }

  toggleMasteryBackground(show: boolean): void {
    const newSettings = { ...this.settings(), showMasteryBackground: show };
    this.settings.set(newSettings);
    this.saveSettings(newSettings);
  }

  getShowMasteryBackground(): boolean {
    return this.settings().showMasteryBackground;
  }

  resetToDefaults(): void {
    this.settings.set({ ...DEFAULT_SETTINGS });
    this.saveSettings(DEFAULT_SETTINGS);
  }
}
