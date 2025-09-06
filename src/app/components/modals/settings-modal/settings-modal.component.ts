import { Component, input, output, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ThemeService } from '../../../services/theme.service';
import { Account } from '../../../models/interfaces/Account';

@Component({
  selector: 'app-settings-modal',
  imports: [CommonModule],
  templateUrl: './settings-modal.component.html',
  styleUrl: './settings-modal.component.scss',
})
export class SettingsModalComponent {
  isOpen = input<boolean>(false);
  accounts = input<Account[]>([]);
  closeModal = output<void>();

  themeService = inject(ThemeService);

  close() {
    this.closeModal.emit();
  }

  setLightTheme() {
    this.themeService.setTheme('light');
  }

  setDarkTheme() {
    this.themeService.setTheme('dark');
  }

  exportAccounts() {
    const accounts = this.accounts();

    // Convert accounts to the bulk import format
    const exportData = accounts
      .map((account) => {
        const parts = [
          `${account.username}:${account.password}`,
          account.name || account.username,
          account.server || '',
          account.rank || '',
        ];
        return parts.join(',');
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
