import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { VERSION, REVISION } from '../environments/version';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent {
  version = [VERSION, REVISION];
  title = 'lolvault';
  theme: 'light' | 'dark' = 'light';

  constructor() {
    this.initTheme();
  }

  initTheme() {
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
    this.theme = theme;
    document.documentElement.setAttribute('data-theme', theme);
  }

  toggleTheme() {
    const newTheme: 'light' | 'dark' = this.theme === 'light' ? 'dark' : 'light';
    this.setTheme(newTheme);
    localStorage.setItem('theme', newTheme);
  }
}
