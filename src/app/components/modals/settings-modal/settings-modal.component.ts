import { Component, input, output, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ThemeService } from '../../../services/theme.service';
import { SettingsService } from '../../../services/settings.service';
import { Account } from '../../../models/interfaces/Account';

@Component({
  selector: 'app-settings-modal',
  imports: [CommonModule, FormsModule],
  templateUrl: './settings-modal.component.html',
  styleUrl: './settings-modal.component.scss',
})
export class SettingsModalComponent {
  isOpen = input<boolean>(false);
  accounts = input<Account[]>([]);
  closeModal = output<void>();
  themeService = inject(ThemeService);
  settingsService = inject(SettingsService);

  close() {
    this.closeModal.emit();
  }

  setLightTheme() {
    this.themeService.setTheme('light');
  }

  setDarkTheme() {
    this.themeService.setTheme('dark');
  }

  onThemeVariantChange(event: Event) {
    const select = event.target as HTMLSelectElement;
    this.themeService.setThemeVariant(select.value);
  }

  resetToDefault() {
    this.settingsService.resetToDefaults();
  }

  async browseForRiotClient() {
    try {
      console.log('browseForRiotClient called');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api = (window as any).electronAPI;

      const result = await api.openFilePicker({ title: 'Select RiotClientServices.exe' });
      if (result && !result.canceled && result.filePaths && result.filePaths.length > 0) {
        const selected: string = result.filePaths[0];
        this.settingsService.updateRiotClientPath(selected);
      }
    } catch (error) {
      console.error('Error picking file:', error);
    }
  }

  exportAccounts() {
    const accounts = this.accounts();

    // Convert accounts to the bulk import format using ':' as separator
    const exportData = accounts
      .map((account) => {
        const parts = [
          account.username || '',
          account.password || '',
          account.name || account.username || '',
          account.server || '',
          account.rank || '',
        ];
        return parts.join(':');
      })
      .join('\n');

    // Create and download the file
    const blob = new Blob([exportData], { type: 'text/plain' });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'accounts-export.txt';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);
  }
}
