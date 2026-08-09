import { Component, OnInit, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { environment } from '../environments/environment';
import { ThemeService } from './services/theme.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent implements OnInit {
  title = 'lolvault';

  /**
   * Instantiated at the root so `data-theme` / `data-theme-variant` land on
   * `<html>` no matter which route the app boots into. Previously only the
   * dashboard and settings screens injected it, so a reload straight onto
   * `/analytics/:vaultId` (which the dev server does on every non-hot change)
   * left every theme custom property undefined — a blank white window.
   */
  private readonly themeService = inject(ThemeService);

  async ngOnInit() {
    if (environment.riotApiKey && window.electronAPI) {
      const result = await window.electronAPI.getApiKey();
      if (!result?.value) {
        await window.electronAPI.setApiKey(environment.riotApiKey);
      }
    }
  }
}
