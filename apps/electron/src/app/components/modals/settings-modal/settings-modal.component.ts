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

  onMasteryBackgroundToggle(event: Event) {
    const checkbox = event.target as HTMLInputElement;
    this.settingsService.toggleMasteryBackground(checkbox.checked);
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

    // Export as CSV format with header (decrypted data)
    const header = 'username,password,name,server';

    const csvRows = accounts.map((account) => {
      const escapeCSV = (field: string) => {
        if (!field) return '';
        if (field.includes(',') || field.includes('"') || field.includes('\n')) {
          return `"${field.replace(/"/g, '""')}"`;
        }
        return field;
      };

      return [
        escapeCSV(account.username || ''),
        escapeCSV(account.password || ''),
        escapeCSV(account.name || account.username || ''),
        escapeCSV(account.server || ''),
      ].join(',');
    });

    const csvData = [header, ...csvRows].join('\n');

    // Create and download the CSV file
    const blob = new Blob([csvData], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'accounts-export.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);
  }
}
