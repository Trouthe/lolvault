import { Component, OnInit } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { environment } from '../environments/environment';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent implements OnInit {
  title = 'lolvault';

  async ngOnInit() {
    if (environment.riotApiKey && window.electronAPI) {
      const result = await window.electronAPI.getApiKey();
      if (!result?.value) {
        await window.electronAPI.setApiKey(environment.riotApiKey);
      }
    }
  }
}
