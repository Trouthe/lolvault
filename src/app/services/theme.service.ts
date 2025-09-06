import { Injectable, signal } from '@angular/core';

@Injectable({
  providedIn: 'root',
})
export class ThemeService {
  private _theme = signal<'light' | 'dark'>('light');

  get theme() {
    return this._theme.asReadonly();
  }

  constructor() {
    this.initTheme();
  }

  private initTheme() {
    const savedTheme = localStorage.getItem('theme') as 'light' | 'dark' | null;
    if (savedTheme) {
      this.setTheme(savedTheme);
    } else {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const systemTheme: 'light' | 'dark' = prefersDark ? 'dark' : 'light';
      this.setTheme(systemTheme);
      localStorage.setItem('theme', systemTheme);
    }
  }

  setTheme(theme: 'light' | 'dark') {
    this._theme.set(theme);
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }

  toggleTheme() {
    const newTheme: 'light' | 'dark' = this._theme() === 'light' ? 'dark' : 'light';
    this.setTheme(newTheme);
  }
}
