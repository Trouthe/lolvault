import { Injectable, signal } from '@angular/core';
import { ThemeVariant } from '../models/interfaces/Theme';
import { THEME_VARIANTS } from '../models/constants';

@Injectable({
  providedIn: 'root',
})
export class ThemeService {
  private _theme = signal<'light' | 'dark'>('light');
  private _themeVariant = signal<string>('default');

  // Available theme variants
  readonly themeVariants: ThemeVariant[] = THEME_VARIANTS;

  get theme() {
    return this._theme.asReadonly();
  }

  get themeVariant() {
    return this._themeVariant.asReadonly();
  }

  constructor() {
    this.initTheme();
  }

  getTheme() {
    return this._theme();
  }

  getOppositeTheme() {
    return this._theme() === 'light' ? 'dark' : 'light';
  }

  private initTheme() {
    const savedTheme = localStorage.getItem('theme') as 'light' | 'dark' | null;
    const savedVariant = localStorage.getItem('themeVariant') || 'default';

    if (savedTheme) {
      this.setTheme(savedTheme);
    } else {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const systemTheme: 'light' | 'dark' = prefersDark ? 'dark' : 'light';
      this.setTheme(systemTheme);
      localStorage.setItem('theme', systemTheme);
    }

    this.setThemeVariant(savedVariant);
  }

  setTheme(theme: 'light' | 'dark') {
    this._theme.set(theme);
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }

  setThemeVariant(variant: string) {
    this._themeVariant.set(variant);
    document.documentElement.setAttribute('data-theme-variant', variant);
    localStorage.setItem('themeVariant', variant);
  }

  toggleTheme() {
    const newTheme: 'light' | 'dark' = this._theme() === 'light' ? 'dark' : 'light';
    this.setTheme(newTheme);
  }
}
