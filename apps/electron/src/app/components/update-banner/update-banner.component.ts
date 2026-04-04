import { Component, signal, OnInit, inject, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ElectronAPI } from '../../../types/electron';

type UpdateState = 'hidden' | 'available' | 'downloading' | 'downloaded' | 'error';

@Component({
  selector: 'app-update-banner',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './update-banner.component.html',
  styleUrl: './update-banner.component.scss',
})
export class UpdateBannerComponent implements OnInit {
  state = signal<UpdateState>('hidden');
  newVersion = signal('');
  downloadPercent = signal(0);
  errorMessage = signal('');

  private ngZone = inject(NgZone);
  private get api(): ElectronAPI {
    return window.electronAPI as unknown as ElectronAPI;
  }

  ngOnInit(): void {
    if (!window.electronAPI) return;

    this.api.onUpdateAvailable((version: string) => {
      this.ngZone.run(() => {
        this.newVersion.set(version);
        this.state.set('available');
      });
    });

    this.api.onUpdateProgress((percent: number) => {
      this.ngZone.run(() => {
        this.downloadPercent.set(Math.round(percent));
      });
    });

    this.api.onUpdateDownloaded(() => {
      this.ngZone.run(() => {
        this.downloadPercent.set(100);
        this.state.set('downloaded');
      });
    });

    this.api.onUpdateError((message: string) => {
      this.ngZone.run(() => {
        this.errorMessage.set(message);
        this.state.set('error');
        console.log(`Update failed${this.errorMessage() ? ': ' + this.errorMessage() : ''}`);
      });
    });
  }

  startDownload(): void {
    this.state.set('downloading');
    this.downloadPercent.set(0);
    this.api.startUpdateDownload();
  }

  installUpdate(): void {
    this.api.installUpdate();
  }

  dismiss(): void {
    this.state.set('hidden');
  }

  retry(): void {
    this.state.set('hidden');
    this.errorMessage.set('');
    this.api.checkForUpdates();
  }
}
