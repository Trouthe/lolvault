import {
  Component,
  HostListener,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import type { User } from 'firebase/auth';
import { ThemeService } from '../../services/theme.service';
import { SettingsService } from '../../services/settings.service';
import { AuthService } from '../../services/auth.service';
import { Account } from '../../models/interfaces/Account';
import { VERSION, BUILD_LABEL } from '../../../environments/version';

export type SettingsSection =
  | 'account'
  | 'security'
  | 'appearance'
  | 'riot-client'
  | 'game-settings'
  | 'data'
  | 'about';

interface SettingsNavItem {
  id: SettingsSection;
  label: string;
  icon: string;
}

interface SettingsNavGroup {
  label: string | null;
  items: SettingsNavItem[];
}

@Component({
  selector: 'app-settings-page',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './settings.component.html',
  styleUrl: './settings.component.scss',
})
export class SettingsPageComponent {
  isOpen = input<boolean>(false);
  isSyncToggleBusy = input<boolean>(false);
  accounts = input<Account[]>([]);
  closePage = output<void>();
  syncWithWebToggleRequested = output<boolean>();

  themeService = inject(ThemeService);
  settingsService = inject(SettingsService);
  private authService = inject(AuthService);
  private router = inject(Router);

  isMac = navigator.userAgent.toLowerCase().includes('mac');
  version = [VERSION, BUILD_LABEL];

  activeSection = signal<SettingsSection>('account');

  readonly navGroups: SettingsNavGroup[] = [
    {
      label: 'User Settings',
      items: [
        { id: 'account', label: 'My Account', icon: 'user' },
        { id: 'security', label: 'Password & Security', icon: 'lock' },
      ],
    },
    {
      label: 'App Settings',
      items: [
        { id: 'appearance', label: 'Appearance', icon: 'theme' },
        { id: 'riot-client', label: 'Riot Client', icon: 'play' },
        { id: 'game-settings', label: 'Game Settings', icon: 'settings' },
        { id: 'data', label: 'Data & Sync', icon: 'database' },
      ],
    },
    {
      label: 'Info',
      items: [{ id: 'about', label: 'About', icon: 'info' }],
    },
  ];

  // ── Account ─────────────────────────────────────────────────────────────────

  currentUser = toSignal<User | null>(this.authService.currentUser$, { initialValue: null });

  connections = computed(() => this.authService.getConnections(this.currentUser()));
  hasPasswordProvider = computed(() => this.authService.hasPasswordProvider(this.currentUser()));

  isEmailRevealed = signal(false);

  maskedEmail = computed(() => {
    const email = this.currentUser()?.email;
    if (!email) return 'No email available';
    if (this.isEmailRevealed()) return email;

    const [local, domain] = email.split('@');
    if (!domain) return '•'.repeat(email.length);
    return `${'•'.repeat(Math.max(local.length, 3))}@${domain}`;
  });

  displayName = computed(() => {
    const user = this.currentUser();
    return user?.displayName || user?.email?.split('@')[0] || 'LoL Vault user';
  });

  avatarUrl = computed(
    () => this.currentUser()?.photoURL || `assets/branding/LV-bg_${this.themeService.getOppositeTheme()}.svg`
  );

  isSendingReset = signal(false);
  resetFeedback = signal('');
  resetFeedbackError = signal(false);

  isDeleteDialogOpen = signal(false);
  deleteConfirmation = signal('');
  isDeletingAccount = signal(false);
  deleteError = signal('');

  canConfirmDelete = computed(
    () => this.deleteConfirmation().trim().toUpperCase() === 'DELETE' && !this.isDeletingAccount()
  );

  // ── Persistent game settings ────────────────────────────────────────────────

  isPersistenceBusy = signal(false);
  persistenceError = signal('');
  persistenceNotice = signal('');
  /** Files the main process reports as currently locked. */
  lockedFiles = signal<string[]>([]);
  configFolderExists = signal(true);

  leagueConfigPath = computed(() => {
    // Recomputes when either the explicit path or the Riot Client path changes.
    this.settingsService.settings();
    return this.settingsService.getLeagueConfigPath();
  });

  isLeagueConfigDerived = computed(() => {
    this.settingsService.settings();
    return this.settingsService.isLeagueConfigPathDerived();
  });

  constructor() {
    // Re-sync the on-disk truth every time the page is opened, so a folder that
    // Riot reset outside the app does not show a stale "locked" toggle.
    effect(() => {
      if (!this.isOpen()) return;
      // untracked: the inspection both reads and writes settings, and should
      // only ever be driven by the page opening.
      untracked(() => void this.inspectLeagueConfig());
    });
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (!this.isOpen()) return;
    if (this.isDeleteDialogOpen()) {
      this.closeDeleteDialog();
      return;
    }
    this.close();
  }

  close(): void {
    this.closePage.emit();
  }

  selectSection(section: SettingsSection): void {
    this.activeSection.set(section);
  }

  // ── Appearance ──────────────────────────────────────────────────────────────

  setLightTheme(): void {
    this.themeService.setTheme('light');
  }

  setDarkTheme(): void {
    this.themeService.setTheme('dark');
  }

  onMasteryBackgroundToggle(event: Event): void {
    const checkbox = event.target as HTMLInputElement;
    this.settingsService.toggleMasteryBackground(checkbox.checked);
  }

  onCardLayoutChange(layout: 'list' | 'grid'): void {
    this.settingsService.setCardLayout(layout);
  }

  // ── Riot client path ────────────────────────────────────────────────────────

  async browseForRiotClient(): Promise<void> {
    try {
      const title = this.isMac ? 'Select Riot Client.app' : 'Select RiotClientServices.exe';
      const result = await window.electronAPI.openFilePicker({ title });

      if (result && !result.canceled && result.filePaths?.length) {
        this.settingsService.updateRiotClientPath(result.filePaths[0]);
        await this.inspectLeagueConfig();
      }
    } catch (error) {
      console.error('Error picking Riot Client path:', error);
    }
  }

  // ── Persistent game settings ────────────────────────────────────────────────

  /** Reads the current read-only state of the League config files from disk. */
  private async inspectLeagueConfig(): Promise<void> {
    try {
      const result = await window.electronAPI.inspectLeagueConfig({
        configPath: this.leagueConfigPath(),
      });

      if (!result.success) {
        this.configFolderExists.set(false);
        this.lockedFiles.set([]);
        return;
      }

      this.configFolderExists.set(!!result.exists);
      this.lockedFiles.set(
        (result.files ?? []).filter((file) => file.readOnly).map((file) => file.name)
      );

      // Keep the stored preference honest if the files were unlocked elsewhere.
      if (this.settingsService.getPersistentGameSettings() && !result.readOnly) {
        this.settingsService.setPersistentGameSettings(false);
      }
    } catch (error) {
      console.error('Error inspecting League config:', error);
    }
  }

  async onPersistentSettingsToggle(event: Event): Promise<void> {
    const checkbox = event.target as HTMLInputElement;
    const enabled = checkbox.checked;

    this.isPersistenceBusy.set(true);
    this.persistenceError.set('');
    this.persistenceNotice.set('');

    try {
      const result = await window.electronAPI.setLeagueConfigReadOnly({
        configPath: this.leagueConfigPath(),
        readOnly: enabled,
      });

      if (!result.success) {
        // Snap the checkbox back — nothing on disk changed.
        checkbox.checked = !enabled;
        this.persistenceError.set(result.error || 'Could not update the League config files.');
        return;
      }

      this.settingsService.setPersistentGameSettings(enabled);
      this.persistenceNotice.set(
        enabled
          ? `Locked ${result.files?.join(', ')} — Riot can no longer overwrite them.`
          : `Unlocked ${result.files?.join(', ')} — Riot can write to them again.`
      );

      if (result.warning) {
        this.persistenceError.set(result.warning);
      }

      await this.inspectLeagueConfig();
    } catch (error) {
      checkbox.checked = !enabled;
      console.error('Error toggling persistent game settings:', error);
      this.persistenceError.set('Unexpected error while updating the League config files.');
    } finally {
      this.isPersistenceBusy.set(false);
    }
  }

  async browseForLeagueConfig(): Promise<void> {
    try {
      const result = await window.electronAPI.openDirectoryPicker({
        title: 'Select your League of Legends Config folder',
        defaultPath: this.leagueConfigPath(),
      });

      if (!result || result.canceled || !result.filePaths?.length) return;

      this.settingsService.setLeagueConfigPath(result.filePaths[0]);
      this.persistenceError.set('');
      this.persistenceNotice.set('');
      await this.inspectLeagueConfig();
    } catch (error) {
      console.error('Error picking League config folder:', error);
    }
  }

  resetLeagueConfigPath(): void {
    this.settingsService.setLeagueConfigPath('');
    void this.inspectLeagueConfig();
  }

  // ── Data ────────────────────────────────────────────────────────────────────

  onSyncWithWebToggle(event: Event): void {
    const checkbox = event.target as HTMLInputElement;
    this.syncWithWebToggleRequested.emit(checkbox.checked);
  }

  exportAccounts(): void {
    const accounts = this.accounts();
    const header = 'username,password,name,server';

    const escapeCSV = (field: string) => {
      if (!field) return '';
      if (field.includes(',') || field.includes('"') || field.includes('\n')) {
        return `"${field.replace(/"/g, '""')}"`;
      }
      return field;
    };

    const csvRows = accounts.map((account) =>
      [
        escapeCSV(account.username || ''),
        escapeCSV(account.password || ''),
        escapeCSV(account.name || account.username || ''),
        escapeCSV(account.server || ''),
      ].join(',')
    );

    const csvData = [header, ...csvRows].join('\n');

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

  resetToDefault(): void {
    this.settingsService.resetToDefaults();
  }

  // ── Account actions ─────────────────────────────────────────────────────────

  toggleEmailReveal(): void {
    this.isEmailRevealed.update((revealed) => !revealed);
  }

  async sendPasswordReset(): Promise<void> {
    if (this.isSendingReset()) return;

    this.isSendingReset.set(true);
    this.resetFeedback.set('');
    this.resetFeedbackError.set(false);

    try {
      await this.authService.sendPasswordReset();
      this.resetFeedback.set(`Password reset email sent to ${this.currentUser()?.email}.`);
    } catch (error) {
      console.error('Failed to send password reset email:', error);
      this.resetFeedbackError.set(true);
      this.resetFeedback.set(
        error instanceof Error ? error.message : 'Could not send the password reset email.'
      );
    } finally {
      this.isSendingReset.set(false);
    }
  }

  async signOut(): Promise<void> {
    try {
      await this.authService.signOut();
      this.close();
      await this.router.navigateByUrl('/auth', { replaceUrl: true });
    } catch (error) {
      console.error('Failed to sign out:', error);
    }
  }

  openDeleteDialog(): void {
    this.deleteConfirmation.set('');
    this.deleteError.set('');
    this.isDeleteDialogOpen.set(true);
  }

  closeDeleteDialog(): void {
    if (this.isDeletingAccount()) return;
    this.isDeleteDialogOpen.set(false);
    this.deleteConfirmation.set('');
    this.deleteError.set('');
  }

  async confirmDeleteAccount(): Promise<void> {
    if (!this.canConfirmDelete()) return;

    this.isDeletingAccount.set(true);
    this.deleteError.set('');

    try {
      await this.authService.deleteAccount();
      this.isDeleteDialogOpen.set(false);
      this.close();
      await this.router.navigateByUrl('/auth', { replaceUrl: true });
    } catch (error) {
      console.error('Failed to delete account:', error);
      this.deleteError.set(
        error instanceof Error ? error.message : 'Could not delete the account. Try again.'
      );
    } finally {
      this.isDeletingAccount.set(false);
    }
  }
}
