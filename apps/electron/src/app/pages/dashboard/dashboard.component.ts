/* eslint-disable @typescript-eslint/no-unused-vars */
import { Component, inject, HostListener, ElementRef, ViewChild, OnDestroy } from '@angular/core';
import { signal, computed, effect } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import type { User } from 'firebase/auth';
import { Unsubscribe, doc, getDoc, onSnapshot, serverTimestamp, setDoc } from 'firebase/firestore';
import { AccCardComponent } from '../../components/acc-card/acc-card.component';
import { AdSlotComponent } from '../../components/ad-slot/ad-slot.component';
import { AddAccountModalComponent } from '../../components/modals/add-account-modal/add-account-modal.component';
import { EditAccountModalComponent } from '../../components/modals/edit-account-modal/edit-account-modal.component';
import { DeleteAccountModalComponent } from '../../components/modals/delete-account-modal/delete-account-modal.component';
import { UpdateBannerComponent } from '../../components/update-banner/update-banner.component';
import { SettingsPageComponent } from '../settings/settings.component';
import { AuthService } from '../../services/auth.service';
import { Account } from '../../models/interfaces/Account';
import { Board } from '../../models/interfaces/Board';
import { RiotApiService } from '../../services/riot-api.service';
import { CardLayout, SettingsService } from '../../services/settings.service';
import { BoardService } from '../../services/board.service';
import { LOL_DATA } from '../../models/constants';
import { VERSION, BUILD_LABEL } from '../../../environments/version';
import { ThemeService } from '../../services/theme.service';
import { FirebaseService } from '../../services/firebase.service';
import { LcuService } from '../../services/lcu.service';
import { ChampionCatalogService } from '../../services/champion-catalog.service';

interface CloudSyncBoard {
  id: string;
  name: string;
  color: string;
  createdAt: number;
}

interface CloudSyncAccount {
  syncId: string;
  boardId: string | null;
  name: string;
  server?: string;
  game?: string;
  rank?: string;
  wins?: number;
  losses?: number;
  leaguePoints?: number;
  profileIconId?: number;
  summonerLevel?: number;
  hotStreak?: boolean;
  topChampionId?: string;
  lastRefreshed?: number;
}

interface CloudSyncSettings {
  theme: 'light' | 'dark';
  themeVariant: string;
  showMasteryBackground: boolean;
}

interface CloudSyncDocumentData {
  boards?: unknown;
  accounts?: unknown;
  settings?: unknown;
}

interface CloudSyncPayload {
  boards: CloudSyncBoard[];
  accounts: CloudSyncAccount[];
  settings: CloudSyncSettings;
}

interface PendingSyncConflictSnapshot {
  userId: string;
  boards: Board[];
  accounts: CloudSyncAccount[];
  settings: CloudSyncSettings;
}

/** A dashboard list row — an account card, or an ad slot when `account` is absent. */
interface FeedRow {
  id: string;
  index: number;
  account?: Account;
}

const CLOUD_SYNC_COLLECTION = 'dashboardAccounts';
const CLOUD_SYNC_SCHEMA_VERSION = 3;
/** How many account cards to render before dropping an ad slot into the feed. */
const AD_EVERY_N_CARDS = 4;

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    AccCardComponent,
    AdSlotComponent,
    AddAccountModalComponent,
    EditAccountModalComponent,
    DeleteAccountModalComponent,
    UpdateBannerComponent,
    SettingsPageComponent,
  ],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss',
})
export class DashboardComponent implements OnDestroy {
  @ViewChild('newBoardInput') newBoardInput!: ElementRef<HTMLInputElement>;

  version = [VERSION, BUILD_LABEL];

  // Core state
  public accounts = signal<Account[]>([]);
  public isModalOpen = signal(false);
  public isSettingsOpen = signal(false);
  public isEditModalOpen = signal(false);
  public isDeleteModalOpen = signal(false);
  public editingAccount = signal<Account | undefined>(undefined);
  public deletingAccount = signal<Account | undefined>(undefined);
  public searchQuery = '';
  private _searchQuery = signal('');
  public isSortMenuOpen = signal(false);
  public isProfileMenuOpen = signal(false);
  public currentSort = signal<'all' | 'highest' | 'lowest' | 'unranked'>('all');
  public isSyncToggleBusy = signal(false);
  public isSyncConflictModalOpen = signal(false);
  public syncConflictResolution = signal<'electron' | 'web'>('electron');
  public syncConflictLocalOnly = signal<string[]>([]);
  public syncConflictWebOnly = signal<string[]>([]);

  // Board state
  public isCreatingBoard = signal(false);
  public newBoardName = signal('');
  public newBoardColor = signal('default');
  public editingBoardId = signal<string | null>(null);
  public editingBoardName = signal('');
  public dragOverBoardId = signal<string | null>(null);

  // Drag state
  public draggingAccountId = signal<string | null>(null);
  public draggingFolderId = signal<string | null>(null);
  private tempBoards = signal<Board[]>([]);
  private tempAccounts = signal<Account[]>([]);
  private isDraggingFolder = signal(false);
  private isDraggingAccount = signal(false);
  private wasDragging = false;
  private lastReorderTime = 0;
  private readonly REORDER_THROTTLE_MS = 100;
  private isConfirmingBoard = false;
  private localDataReady = signal(false);
  private cloudSyncUnsubscribe: Unsubscribe | null = null;
  private cloudSyncUserId: string | null = null;
  private cloudWriteDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private isApplyingCloudSnapshot = false;
  private lastCloudDataHash = '';
  private pendingSyncConflictSnapshot: PendingSyncConflictSnapshot | null = null;

  // Hover state
  public hoveredAccountId = signal<string | null>(null);
  public hoveredFolderId = signal<string | null>(null);

  // Services
  private riotApiService = inject(RiotApiService);
  private authService = inject(AuthService);
  private router = inject(Router);
  public settingsService = inject(SettingsService);
  public boardService = inject(BoardService);
  public themeService = inject(ThemeService);
  private firebaseService = inject(FirebaseService);
  private lcuService = inject(LcuService);
  private championCatalog = inject(ChampionCatalogService);

  public currentUser = toSignal<User | null>(this.authService.currentUser$, {
    initialValue: null,
  });

  public profileImageUrl = computed(
    () => this.currentUser()?.photoURL || this.getLocalProfileFallback()
  );

  /**
   * DDragon id of the champion whose splash backs the dashboard.
   *
   * Derived rather than set once at load: the mastery ids arrive asynchronously
   * (a card refresh, a cloud snapshot, the initial Riot enrichment), so a signal
   * written only during `loadAccounts()` stayed empty and the Settings toggle
   * looked broken. `topChampionId` is not persisted, hence the fallback to the
   * stored top-3 list.
   */
  public championId = computed(() => {
    const withMastery = this.accounts().find(
      (acc) => acc.topChampionId || acc.topChampionIds?.length
    );
    return this.championCatalog.getChampionId(
      withMastery?.topChampionId || withMastery?.topChampionIds?.[0]
    );
  });

  // Computed properties
  public displayedBoards = computed(() =>
    this.isDraggingFolder() ? this.tempBoards() : this.boardService.getBoards()()
  );

  public displayedAccounts = computed(() =>
    this.isDraggingAccount() ? this.tempAccounts() : this.filteredAccounts()
  );

  public filteredAccounts = computed(() => {
    const query = this._searchQuery().toLowerCase().trim();
    const selectedBoardId = this.boardService.getSelectedBoardId()();
    let filtered = this.accounts();

    if (selectedBoardId !== null) {
      filtered = filtered.filter((acc) => acc.boardId === selectedBoardId);
    }

    if (query) {
      filtered = filtered.filter((acc) =>
        [acc.name, acc.username, acc.server, acc.rank, acc.game].some((field) =>
          field?.toLowerCase().includes(query)
        )
      );
    }

    const sortType = this.currentSort();
    if (sortType === 'unranked') return filtered.filter((acc) => !acc.rank);
    if (sortType === 'highest' || sortType === 'lowest') {
      return [...filtered].sort((a, b) => {
        const diff = this.getRankValue(b.rank) - this.getRankValue(a.rank);
        return sortType === 'highest' ? diff : -diff;
      });
    }
    return filtered;
  });

  public totalAccountCount = computed(() => this.accounts().length);

  // ── Layout + ad feed ────────────────────────────────────────────────────────

  public cardLayout = computed<CardLayout>(() => this.settingsService.settings().cardLayout);
  public isGridLayout = computed(() => this.cardLayout() === 'grid');

  /**
   * Accounts with ad slots interleaved, so the list renders in a single pass.
   * `index` is the account's position among accounts only — the drag/reorder
   * handlers depend on that, not on the row position.
   */
  public accountFeed = computed<FeedRow[]>(() => {
    const accounts = this.displayedAccounts();
    const rows: FeedRow[] = [];

    accounts.forEach((account, index) => {
      rows.push({ id: `account-${account.id}`, account, index });

      const isLast = index === accounts.length - 1;
      if (!isLast && (index + 1) % AD_EVERY_N_CARDS === 0) {
        rows.push({ id: `ad-${index}`, index });
      }
    });

    return rows;
  });

  toggleCardLayout(): void {
    this.settingsService.toggleCardLayout();
  }

  public getAccountCountForBoard(boardId: string | null): number {
    return boardId === null
      ? this.accounts().length
      : this.accounts().filter((acc) => acc.boardId === boardId).length;
  }

  constructor() {
    void this.initializeLocalData();

    effect((onCleanup) => {
      const user = this.currentUser();
      const isLocalDataReady = this.localDataReady();
      const syncWithWeb = this.settingsService.settings().syncWithWeb;

      if (!user || !isLocalDataReady || !syncWithWeb) {
        this.stopCloudSyncListener();
        return;
      }

      this.startCloudSyncListener(user.uid);
      onCleanup(() => this.stopCloudSyncListener());
    });

    effect(() => {
      const user = this.currentUser();
      const isLocalDataReady = this.localDataReady();
      const accounts = this.accounts();
      const boards = this.boardService.getBoards()();
      const syncWithWeb = this.settingsService.settings().syncWithWeb;
      const theme = this.themeService.theme();
      const themeVariant = this.themeService.themeVariant();
      const showMasteryBackground = this.settingsService.settings().showMasteryBackground;

      void theme;
      void themeVariant;
      void showMasteryBackground;

      if (!user || !isLocalDataReady || !syncWithWeb || this.isApplyingCloudSnapshot) {
        return;
      }

      this.scheduleCloudSnapshotPublish(user.uid, boards, accounts);
    });

    window.addEventListener('dragend', this.onGlobalDragEnd, true);
    document.addEventListener('dragstart', this.onGlobalDragStart, true);

    // LoL Vault's own "last active" signal: the LCU telling us which account is
    // currently signed in. Riot's own login history is deliberately not used.
    this.lcuService.accountIdentified$.pipe(takeUntilDestroyed()).subscribe((event) => {
      void this.stampLastActive(event.vaultId);
    });

    // When a game ends, update the account's displayed rank in memory.
    // Do NOT persist — the user can refresh manually to sync back to Riot API.
    this.lcuService.gameEnded$.pipe(takeUntilDestroyed()).subscribe((event) => {
      this.accounts.update((accs) =>
        accs.map((acc) => {
          const vaultId = acc.syncId || String(acc.id);
          if (vaultId !== event.vaultId) return acc;
          return {
            ...acc,
            rank: `${event.newTier} ${event.newDivision}`,
            leaguePoints: event.newLP,
          };
        })
      );
    });
  }

  ngOnDestroy(): void {
    window.removeEventListener('dragend', this.onGlobalDragEnd, true);
    document.removeEventListener('dragstart', this.onGlobalDragStart, true);
    this.stopCloudSyncListener();

    if (this.cloudWriteDebounceTimer !== null) {
      clearTimeout(this.cloudWriteDebounceTimer);
      this.cloudWriteDebounceTimer = null;
    }
  }

  private async initializeLocalData(): Promise<void> {
    await Promise.all([this.loadBoards(), this.loadAccounts()]);
    this.localDataReady.set(true);
  }

  private getRankValue(rank: string | undefined): number {
    if (!rank) return -1;
    const [tier, division] = rank.split(' ');
    const normalizedTier = tier.charAt(0).toUpperCase() + tier.slice(1).toLowerCase();
    const tierIndex = LOL_DATA.RANKS.indexOf(normalizedTier);
    if (tierIndex === -1) return -1;
    const divisionValues: Record<string, number> = { IV: 0, III: 1, II: 2, I: 3 };
    return tierIndex * 4 + (divisionValues[division] || 3);
  }

  private async saveAccounts(accounts: Account[]): Promise<void> {
    const clean = accounts.map(({ topChampionId, ...rest }) => rest);
    await window.electronAPI.saveAccounts(clean);
  }

  private async updateAccountsAndSave(updater: (accounts: Account[]) => Account[]): Promise<void> {
    const updated = this.ensureAccountSyncIds(updater(this.accounts()));
    this.accounts.set(updated);
    await this.saveAccounts(updated);
  }

  private isSameAccount(a: Account, b: Account): boolean {
    const aSyncId = a.syncId?.trim();
    const bSyncId = b.syncId?.trim();

    if (aSyncId && bSyncId) {
      return aSyncId === bSyncId;
    }

    return String(a.id) === String(b.id);
  }

  private resetDragState(): void {
    this.dragOverBoardId.set(null);
    this.draggingAccountId.set(null);
    this.draggingFolderId.set(null);
    this.isDraggingFolder.set(false);
    this.isDraggingAccount.set(false);
  }

  onAccountMouseEnter(accountId: string): void {
    this.hoveredAccountId.set(accountId);
  }

  onAccountMouseLeave(): void {
    this.hoveredAccountId.set(null);
  }

  onFolderMouseEnter(folderId: string): void {
    this.hoveredFolderId.set(folderId);
  }

  onFolderMouseLeave(): void {
    this.hoveredFolderId.set(null);
  }

  clearHoverState(): void {
    this.hoveredAccountId.set(null);
    this.hoveredFolderId.set(null);
  }

  getFolderColor(colorName: string): string {
    return `var(--folder-color-${colorName}, var(--folder-color-default))`;
  }

  getCurrentBoardName(): string {
    const boardId = this.boardService.getSelectedBoardId()();
    if (boardId === null) return 'All Accounts';
    return this.boardService.getBoardById(boardId)?.name || 'Unknown Board';
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;

    if (target && !target.closest('.sort-menu-container') && this.isSortMenuOpen()) {
      this.isSortMenuOpen.set(false);
    }

    if (target && !target.closest('.profile-menu') && this.isProfileMenuOpen()) {
      this.isProfileMenuOpen.set(false);
    }
  }

  toggleProfileMenu(event: Event): void {
    event.stopPropagation();
    this.isProfileMenuOpen.update((open) => !open);
  }

  getLocalProfileFallback(): string {
    return `assets/branding/LV-bg_${this.themeService.getOppositeTheme()}.svg`;
  }

  onProfileImageError(event: Event): void {
    const target = event.target as HTMLImageElement;
    const fallback = this.getLocalProfileFallback();

    if (target.dataset['fallbackApplied'] === 'true' && target.src.endsWith(fallback)) return;

    target.dataset['fallbackApplied'] = 'true';
    target.src = fallback;
  }

  async signOutUser(): Promise<void> {
    try {
      this.isProfileMenuOpen.set(false);
      await this.authService.signOut();
      await this.router.navigateByUrl('/auth', { replaceUrl: true });
    } catch (error) {
      console.error('Failed to sign out:', error);
    }
  }

  toggleSortMenu(): void {
    this.isSortMenuOpen.set(!this.isSortMenuOpen());
  }

  setSortOption(option: 'all' | 'highest' | 'lowest' | 'unranked'): void {
    this.currentSort.set(option);
    this.isSortMenuOpen.set(false);
  }

  async onSyncWithWebToggleRequested(enabled: boolean): Promise<void> {
    if (this.isSyncToggleBusy()) {
      return;
    }

    if (!enabled) {
      this.settingsService.toggleSyncWithWeb(false);
      this.stopCloudSyncListener();
      this.resetSyncConflictState();
      return;
    }

    const user = this.currentUser();
    if (!user) {
      console.warn('Sync with web requires an authenticated user.');
      this.settingsService.toggleSyncWithWeb(false);
      return;
    }

    if (!this.localDataReady()) {
      console.warn('Local data is not ready yet; try enabling sync again in a moment.');
      this.settingsService.toggleSyncWithWeb(false);
      return;
    }

    this.isSyncToggleBusy.set(true);

    try {
      const localAccountsWithSyncIds = this.ensureAccountSyncIds(this.accounts());
      if (localAccountsWithSyncIds !== this.accounts()) {
        this.accounts.set(localAccountsWithSyncIds);
        await this.saveAccounts(localAccountsWithSyncIds);
      }

      const snapshot = await getDoc(this.getCloudSyncDocument(user.uid));
      if (!snapshot.exists()) {
        this.settingsService.toggleSyncWithWeb(true);
        return;
      }

      const cloudData = snapshot.data() as CloudSyncDocumentData;
      const cloudBoards = this.deserializeCloudBoards(cloudData.boards);
      const cloudAccounts = this.deserializeCloudAccounts(cloudData.accounts, cloudBoards);
      const cloudSettings = this.deserializeCloudSettings(cloudData.settings);

      const localOnly = this.getLocalOnlyAccounts(localAccountsWithSyncIds, cloudAccounts);
      const webOnly = this.getWebOnlyAccounts(localAccountsWithSyncIds, cloudAccounts);

      if (!localOnly.length && !webOnly.length) {
        this.settingsService.toggleSyncWithWeb(true);
        return;
      }

      this.pendingSyncConflictSnapshot = {
        userId: user.uid,
        boards: cloudBoards,
        accounts: cloudAccounts,
        settings: cloudSettings,
      };
      this.syncConflictResolution.set('electron');
      this.syncConflictLocalOnly.set(localOnly);
      this.syncConflictWebOnly.set(webOnly);
      this.isSyncConflictModalOpen.set(true);
    } catch (error) {
      console.error('Failed to initialize sync-with-web toggle:', error);
      this.settingsService.toggleSyncWithWeb(false);
    } finally {
      this.isSyncToggleBusy.set(false);
    }
  }

  closeSyncConflictModal(): void {
    this.isSyncConflictModalOpen.set(false);
    this.settingsService.toggleSyncWithWeb(false);
    this.resetSyncConflictState();
  }

  async applySyncConflictResolution(): Promise<void> {
    const pendingSnapshot = this.pendingSyncConflictSnapshot;
    if (!pendingSnapshot) {
      this.closeSyncConflictModal();
      return;
    }

    this.isSyncToggleBusy.set(true);

    try {
      if (this.syncConflictResolution() === 'electron') {
        await this.publishCloudSnapshot(
          pendingSnapshot.userId,
          this.boardService.getBoards()(),
          this.accounts()
        );
        this.settingsService.toggleSyncWithWeb(true);
      } else {
        this.lastCloudDataHash = this.getCloudStateHash(
          this.serializeCloudBoards(pendingSnapshot.boards),
          pendingSnapshot.accounts,
          pendingSnapshot.settings
        );
        this.isApplyingCloudSnapshot = true;
        const mergedAccounts = this.materializeElectronAccounts(pendingSnapshot.accounts);
        await this.applyCloudSnapshot(
          pendingSnapshot.boards,
          mergedAccounts,
          pendingSnapshot.settings
        );
        this.settingsService.toggleSyncWithWeb(true);
      }

      this.isSyncConflictModalOpen.set(false);
      this.resetSyncConflictState();
    } catch (error) {
      console.error('Failed to apply sync conflict resolution:', error);
      this.settingsService.toggleSyncWithWeb(false);
    } finally {
      this.isSyncToggleBusy.set(false);
    }
  }

  private resetSyncConflictState(): void {
    this.pendingSyncConflictSnapshot = null;
    this.syncConflictLocalOnly.set([]);
    this.syncConflictWebOnly.set([]);
    this.syncConflictResolution.set('electron');
  }

  private getLocalOnlyAccounts(
    localAccounts: Account[],
    cloudAccounts: CloudSyncAccount[]
  ): string[] {
    const cloudSyncIds = new Set(cloudAccounts.map((account) => account.syncId));

    return localAccounts
      .filter((account) => {
        const syncId = account.syncId || this.buildLegacySyncId(account.name, account.server);
        return !cloudSyncIds.has(syncId);
      })
      .map((account) => this.buildAccountLabel(account.name, account.server));
  }

  private getWebOnlyAccounts(
    localAccounts: Account[],
    cloudAccounts: CloudSyncAccount[]
  ): string[] {
    const localSyncIds = new Set(
      localAccounts.map(
        (account) => account.syncId || this.buildLegacySyncId(account.name, account.server)
      )
    );

    return cloudAccounts
      .filter((account) => !localSyncIds.has(account.syncId))
      .map((account) => this.buildAccountLabel(account.name, account.server));
  }

  private buildAccountLabel(name: string, server?: string): string {
    return server ? `${name} (${server})` : name;
  }

  onSearchChange(query: string): void {
    this._searchQuery.set(query);
  }

  private onGlobalDragEnd = async (): Promise<void> => {
    if (this.isDraggingFolder() && this.draggingFolderId()) {
      await this.boardService.setBoards(this.tempBoards());
    }

    if (this.isDraggingAccount() && this.draggingAccountId()) {
      await this.commitAccountReorder();
    }

    this.resetDragState();
    this.wasDragging = true;
    setTimeout(() => {
      this.wasDragging = false;
    }, 100);
  };

  private onGlobalDragStart = (event: DragEvent): void => {
    const handle = (event.target as HTMLElement).closest('.account-drag-handle');
    if (!handle || !event.dataTransfer) return;

    const accountId = handle.getAttribute('data-account-id');
    if (!accountId) return;

    event.dataTransfer.setData('text/plain', accountId);
    event.dataTransfer.effectAllowed = 'move';

    this.draggingAccountId.set(accountId);
    this.wasDragging = true;
    this.tempAccounts.set([...this.filteredAccounts()]);
    this.isDraggingAccount.set(true);
  };

  private async commitAccountReorder(): Promise<void> {
    const reorderedFiltered = this.tempAccounts();
    const allAccounts = this.accounts();
    const selectedBoardId = this.boardService.getSelectedBoardId()();

    const reorderedIds = new Set(reorderedFiltered.map((a) => a.id));
    const otherAccounts = allAccounts.filter((a) => !reorderedIds.has(a.id));

    let newAccounts: Account[];
    if (selectedBoardId !== null) {
      const firstBoardAccountIndex = allAccounts.findIndex((a) => a.boardId === selectedBoardId);
      if (firstBoardAccountIndex === -1) {
        newAccounts = [...otherAccounts, ...reorderedFiltered];
      } else {
        const before = otherAccounts.filter((_, i) => {
          const origIndex = allAccounts.findIndex((a) => a.id === otherAccounts[i]?.id);
          return origIndex < firstBoardAccountIndex;
        });
        const after = otherAccounts.filter((a) => !before.includes(a));
        newAccounts = [...before, ...reorderedFiltered, ...after];
      }
    } else {
      newAccounts = reorderedFiltered;
    }

    this.accounts.set(newAccounts);
    await this.saveAccounts(newAccounts);
  }

  onFolderDragStart(event: DragEvent, board: Board, _index: number): void {
    if (!event.dataTransfer) return;
    this.wasDragging = true;
    event.dataTransfer.setData('application/x-folder-id', board.id);
    event.dataTransfer.effectAllowed = 'move';
    this.draggingFolderId.set(board.id);
    this.tempBoards.set([...this.boardService.getBoards()()]);
    this.isDraggingFolder.set(true);
  }

  onFolderDragOver(event: DragEvent, hoverIndex: number): void {
    event.preventDefault();
    event.stopPropagation();
    if (!this.draggingFolderId()) return;

    const now = Date.now();
    if (now - this.lastReorderTime < this.REORDER_THROTTLE_MS) return;

    const boards = this.tempBoards();
    const draggedId = this.draggingFolderId();
    const currentIndex = boards.findIndex((b) => b.id === draggedId);
    if (currentIndex === -1 || currentIndex === hoverIndex) return;

    this.lastReorderTime = now;
    const newBoards = [...boards];
    const [removed] = newBoards.splice(currentIndex, 1);
    newBoards.splice(hoverIndex, 0, removed);
    this.tempBoards.set(newBoards);
  }

  onAccountDragOver(event: DragEvent, hoverIndex: number): void {
    event.preventDefault();
    event.stopPropagation();
    if (!this.draggingAccountId()) return;

    const now = Date.now();
    if (now - this.lastReorderTime < this.REORDER_THROTTLE_MS) return;

    const accounts = this.tempAccounts();
    const draggedId = this.draggingAccountId();
    const currentIndex = accounts.findIndex((a) => a.id.toString() === draggedId);
    if (currentIndex === -1 || currentIndex === hoverIndex) return;

    this.lastReorderTime = now;
    const newAccounts = [...accounts];
    const [removed] = newAccounts.splice(currentIndex, 1);
    newAccounts.splice(hoverIndex, 0, removed);
    this.tempAccounts.set(newAccounts);
  }

  onAccountDrop(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
  }

  onAccountsListDragOver(event: DragEvent): void {
    event.preventDefault();
  }

  onAccountsListDrop(event: DragEvent): void {
    event.preventDefault();
  }

  onDragOver(event: DragEvent, boardId: string | null): void {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    this.dragOverBoardId.set(boardId);
  }

  onDragLeave(): void {
    this.dragOverBoardId.set(null);
  }

  async onDrop(event: DragEvent, boardId: string | null): Promise<void> {
    event.preventDefault();
    this.dragOverBoardId.set(null);

    if (event.dataTransfer?.types.includes('application/x-folder-id')) return;

    const accountId = event.dataTransfer?.getData('text/plain');
    if (!accountId) return;

    const account = this.accounts().find((acc) => String(acc.id) === accountId);
    if (!account) return;

    const currentAccountBoardId = account.boardId ?? null;
    if (currentAccountBoardId === boardId) return;

    this.isDraggingAccount.set(false);
    this.draggingAccountId.set(null);

    // If dropping to All Accounts (boardId === null) or dragging from All Accounts (currentAccountBoardId === null),
    // treat it as a move (update existing account's boardId) to avoid duplicates in the "All Accounts" view.
    // Only create a new copied account when dragging between two specific boards.
    if (currentAccountBoardId === null || boardId === null) {
      await this.updateAccountsAndSave((accounts) =>
        accounts.map((acc) =>
          acc.id === account.id ? { ...acc, boardId: boardId === null ? undefined : boardId } : acc
        )
      );
    } else {
      const newId =
        (typeof window !== 'undefined' && window.crypto?.randomUUID?.()) ||
        `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

      const copiedAccount: Account = {
        ...account,
        id: newId,
        syncId: this.createSyncId(),
        boardId: boardId === null ? undefined : boardId,
      };

      await this.updateAccountsAndSave((accounts) => [...accounts, copiedAccount]);
    }
  }

  selectBoard(boardId: string | null): void {
    if (this.wasDragging) return;
    this.boardService.selectBoard(boardId);
  }

  startCreatingBoard(): void {
    this.newBoardColor.set(this.boardService.getRandomFolderColor());
    this.isCreatingBoard.set(true);
    setTimeout(() => this.newBoardInput?.nativeElement?.focus(), 0);
  }

  async confirmNewBoard(): Promise<void> {
    if (this.isConfirmingBoard) return;
    this.isConfirmingBoard = true;
    const name = this.newBoardName().trim();
    const color = this.newBoardColor();
    this.isCreatingBoard.set(false);
    this.newBoardName.set('');
    if (name) await this.boardService.createBoardWithColor(name, color);
    this.isConfirmingBoard = false;
  }

  cancelNewBoard(): void {
    if (this.isConfirmingBoard) return;
    this.isCreatingBoard.set(false);
    this.newBoardName.set('');
  }

  onNewBoardKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.confirmNewBoard();
    } else if (event.key === 'Escape') this.cancelNewBoard();
  }

  onNewBoardBlur(): void {
    setTimeout(() => {
      if (!this.isConfirmingBoard && this.isCreatingBoard()) this.confirmNewBoard();
    }, 100);
  }

  startEditingBoard(board: Board, event: MouseEvent): void {
    event.stopPropagation();
    this.editingBoardId.set(board.id);
    this.editingBoardName.set(board.name);
    setTimeout(() => {
      const input = document.querySelector('.board-name-input') as HTMLInputElement;
      input?.focus();
      input?.select();
    }, 0);
  }

  async confirmEditBoard(): Promise<void> {
    const boardId = this.editingBoardId();
    const name = this.editingBoardName().trim();
    if (boardId && name) await this.boardService.updateBoard(boardId, { name });
    this.editingBoardId.set(null);
    this.editingBoardName.set('');
  }

  onEditBoardKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') this.confirmEditBoard();
    else if (event.key === 'Escape') {
      this.editingBoardId.set(null);
      this.editingBoardName.set('');
    }
  }

  async deleteBoard(boardId: string, event: MouseEvent): Promise<void> {
    event.stopPropagation();
    await this.updateAccountsAndSave((accounts) =>
      accounts.map((acc) => (acc.boardId === boardId ? { ...acc, boardId: undefined } : acc))
    );
    await this.boardService.deleteBoard(boardId);
  }

  async loadBoards(): Promise<void> {
    await this.boardService.loadBoards();
  }

  async loadAccounts(): Promise<void> {
    try {
      const loaded = await window.electronAPI.loadAccounts();
      const withSyncIds = this.ensureAccountSyncIds(loaded);
      this.accounts.set(withSyncIds);

      if (withSyncIds !== loaded) {
        await this.saveAccounts(withSyncIds);
      }
    } catch (error) {
      console.error('Error loading accounts:', error);
    }
  }

  private startCloudSyncListener(userId: string): void {
    if (this.cloudSyncUserId === userId && this.cloudSyncUnsubscribe) {
      return;
    }

    this.stopCloudSyncListener();
    this.cloudSyncUserId = userId;
    this.cloudSyncUnsubscribe = onSnapshot(
      this.getCloudSyncDocument(userId),
      (snapshot) => {
        if (!snapshot.exists()) {
          this.lastCloudDataHash = '';

          if (
            this.localDataReady() &&
            (this.accounts().length || this.boardService.getBoards()().length)
          ) {
            void this.publishCloudSnapshot(
              userId,
              this.boardService.getBoards()(),
              this.accounts()
            );
          }

          return;
        }

        const data = snapshot.data() as CloudSyncDocumentData;
        const cloudBoards = this.deserializeCloudBoards(data.boards);
        const cloudAccounts = this.deserializeCloudAccounts(data.accounts, cloudBoards);
        const cloudSettings = this.deserializeCloudSettings(data.settings);

        this.lastCloudDataHash = this.getCloudStateHash(
          this.serializeCloudBoards(cloudBoards),
          cloudAccounts,
          cloudSettings
        );
        this.isApplyingCloudSnapshot = true;

        const mergedAccounts = this.materializeElectronAccounts(cloudAccounts);
        void this.applyCloudSnapshot(cloudBoards, mergedAccounts, cloudSettings);
      },
      (error) => {
        console.error('Electron realtime cloud sync listener failed:', error);
      }
    );
  }

  private stopCloudSyncListener(): void {
    if (this.cloudSyncUnsubscribe) {
      this.cloudSyncUnsubscribe();
      this.cloudSyncUnsubscribe = null;
    }

    this.cloudSyncUserId = null;
  }

  private scheduleCloudSnapshotPublish(userId: string, boards: Board[], accounts: Account[]): void {
    const normalizedAccounts = this.ensureAccountSyncIds(accounts);
    const payload = this.buildCloudSyncPayload(boards, normalizedAccounts);
    const hash = this.getCloudStateHash(payload.boards, payload.accounts, payload.settings);

    if (hash === this.lastCloudDataHash) {
      return;
    }

    if (this.cloudWriteDebounceTimer !== null) {
      clearTimeout(this.cloudWriteDebounceTimer);
    }

    this.cloudWriteDebounceTimer = setTimeout(() => {
      this.cloudWriteDebounceTimer = null;
      void this.publishCloudSnapshot(userId, this.boardService.getBoards()(), this.accounts());
    }, 350);
  }

  private async publishCloudSnapshot(
    userId: string,
    boards: Board[],
    accounts: Account[]
  ): Promise<void> {
    const normalizedAccounts = this.ensureAccountSyncIds(accounts);
    const payload = this.buildCloudSyncPayload(boards, normalizedAccounts);
    const hash = this.getCloudStateHash(payload.boards, payload.accounts, payload.settings);

    if (hash === this.lastCloudDataHash) {
      return;
    }

    await setDoc(
      this.getCloudSyncDocument(userId),
      {
        userId,
        schemaVersion: CLOUD_SYNC_SCHEMA_VERSION,
        boards: payload.boards,
        accounts: payload.accounts,
        settings: payload.settings,
        updatedAt: serverTimestamp(),
        updatedFrom: 'electron',
      },
      { merge: true }
    );

    this.lastCloudDataHash = hash;
  }

  private async applyCloudSnapshot(
    cloudBoards: Board[],
    mergedAccounts: Account[],
    cloudSettings: CloudSyncSettings
  ): Promise<void> {
    try {
      this.boardService.selectBoard(
        this.boardService.getSelectedBoardId()() &&
          !cloudBoards.some((board) => board.id === this.boardService.getSelectedBoardId()())
          ? null
          : this.boardService.getSelectedBoardId()()
      );

      this.applyCloudSettings(cloudSettings);
      await this.boardService.setBoards(cloudBoards);
      this.accounts.set(mergedAccounts);
      await this.saveAccounts(mergedAccounts);
    } catch (error) {
      console.error('Failed to apply cloud snapshot locally:', error);
    } finally {
      this.isApplyingCloudSnapshot = false;
    }
  }

  private getCloudSyncDocument(userId: string) {
    return doc(this.firebaseService.db, CLOUD_SYNC_COLLECTION, userId);
  }

  private buildCloudSyncPayload(boards: Board[], accounts: Account[]): CloudSyncPayload {
    return {
      boards: this.serializeCloudBoards(boards),
      accounts: this.serializeCloudAccounts(accounts),
      settings: this.serializeCloudSettings(),
    };
  }

  private serializeCloudBoards(boards: Board[]): CloudSyncBoard[] {
    return boards.map((board) => ({
      id: board.id,
      name: board.name,
      color: board.color,
      createdAt: board.createdAt,
    }));
  }

  private serializeCloudAccounts(accounts: Account[]): CloudSyncAccount[] {
    return accounts.map((account) =>
      this.omitUndefinedFields<CloudSyncAccount>({
        syncId: account.syncId || this.buildLegacySyncId(account.name, account.server),
        boardId: account.boardId || null,
        name: account.name,
        server: account.server,
        game: account.game,
        rank: account.rank,
        wins: account.wins,
        losses: account.losses,
        leaguePoints: account.leaguePoints,
        profileIconId: account.profileIconId,
        summonerLevel: account.summonerLevel,
        hotStreak: account.hotStreak,
        topChampionId: account.topChampionId,
        lastRefreshed: account.lastRefreshed,
      })
    );
  }

  private omitUndefinedFields<T extends object>(value: T): T {
    return Object.fromEntries(
      Object.entries(value).filter(([, fieldValue]) => fieldValue !== undefined)
    ) as T;
  }

  private serializeCloudSettings(): CloudSyncSettings {
    return {
      theme: this.themeService.getTheme(),
      themeVariant: this.themeService.themeVariant(),
      showMasteryBackground: this.settingsService.getShowMasteryBackground(),
    };
  }

  private deserializeCloudSettings(rawSettings: unknown): CloudSyncSettings {
    const parsed = rawSettings && typeof rawSettings === 'object' ? rawSettings : {};
    const candidate = parsed as Partial<CloudSyncSettings>;

    return {
      theme:
        candidate.theme === 'light' || candidate.theme === 'dark'
          ? candidate.theme
          : this.themeService.getTheme(),
      themeVariant:
        typeof candidate.themeVariant === 'string' && candidate.themeVariant.trim()
          ? candidate.themeVariant
          : this.themeService.themeVariant(),
      showMasteryBackground:
        typeof candidate.showMasteryBackground === 'boolean'
          ? candidate.showMasteryBackground
          : this.settingsService.getShowMasteryBackground(),
    };
  }

  private applyCloudSettings(settings: CloudSyncSettings): void {
    if (this.themeService.getTheme() !== settings.theme) {
      this.themeService.setTheme(settings.theme);
    }

    if (this.themeService.themeVariant() !== settings.themeVariant) {
      this.themeService.setThemeVariant(settings.themeVariant);
    }

    if (this.settingsService.getShowMasteryBackground() !== settings.showMasteryBackground) {
      this.settingsService.toggleMasteryBackground(settings.showMasteryBackground);
    }
  }

  private deserializeCloudBoards(rawBoards: unknown): Board[] {
    if (!Array.isArray(rawBoards)) {
      return [];
    }

    const parsedBoards: Board[] = [];

    for (const rawBoard of rawBoards) {
      if (!rawBoard || typeof rawBoard !== 'object') {
        continue;
      }

      const board = rawBoard as Partial<CloudSyncBoard>;
      if (typeof board.id !== 'string' || !board.id.trim()) {
        continue;
      }

      if (typeof board.name !== 'string' || !board.name.trim()) {
        continue;
      }

      parsedBoards.push({
        id: board.id,
        name: board.name,
        color: typeof board.color === 'string' && board.color.trim() ? board.color : 'default',
        createdAt: typeof board.createdAt === 'number' ? board.createdAt : Date.now(),
      });
    }

    return parsedBoards;
  }

  private deserializeCloudAccounts(rawAccounts: unknown, boards: Board[]): CloudSyncAccount[] {
    if (!Array.isArray(rawAccounts)) {
      return [];
    }

    const validBoardIds = new Set(boards.map((board) => board.id));
    const parsedAccounts: CloudSyncAccount[] = [];

    for (const rawAccount of rawAccounts) {
      if (!rawAccount || typeof rawAccount !== 'object') {
        continue;
      }

      const account = rawAccount as Partial<CloudSyncAccount>;
      const syncId =
        typeof account.syncId === 'string' && account.syncId.trim()
          ? account.syncId
          : this.buildLegacySyncId(account.name || '', account.server);

      if (!syncId || typeof account.name !== 'string' || !account.name.trim()) {
        continue;
      }

      const boardId =
        typeof account.boardId === 'string' && validBoardIds.has(account.boardId)
          ? account.boardId
          : null;

      parsedAccounts.push({
        syncId,
        boardId,
        name: account.name,
        server: typeof account.server === 'string' ? account.server : undefined,
        game: typeof account.game === 'string' ? account.game : 'League of Legends',
        rank: typeof account.rank === 'string' ? account.rank : undefined,
        wins: typeof account.wins === 'number' ? account.wins : undefined,
        losses: typeof account.losses === 'number' ? account.losses : undefined,
        leaguePoints: typeof account.leaguePoints === 'number' ? account.leaguePoints : undefined,
        profileIconId:
          typeof account.profileIconId === 'number' ? account.profileIconId : undefined,
        summonerLevel:
          typeof account.summonerLevel === 'number' ? account.summonerLevel : undefined,
        hotStreak: typeof account.hotStreak === 'boolean' ? account.hotStreak : undefined,
        topChampionId:
          typeof account.topChampionId === 'string' ? account.topChampionId : undefined,
        lastRefreshed:
          typeof account.lastRefreshed === 'number' ? account.lastRefreshed : undefined,
      });
    }

    return parsedAccounts;
  }

  private materializeElectronAccounts(cloudAccounts: CloudSyncAccount[]): Account[] {
    const localBySyncId = new Map<string, Account>();

    for (const account of this.accounts()) {
      const syncId = account.syncId || this.buildLegacySyncId(account.name, account.server);
      localBySyncId.set(syncId, account);
    }

    return cloudAccounts.map((cloudAccount) => {
      const existing = localBySyncId.get(cloudAccount.syncId);

      return {
        id: existing?.id ?? cloudAccount.syncId,
        syncId: cloudAccount.syncId,
        name: cloudAccount.name,
        username: existing?.username,
        password: existing?.password,
        // Locally-derived data is never synced, so carry it across from the
        // record we already hold rather than dropping it on every snapshot.
        puuid: existing?.puuid,
        topChampionIds: existing?.topChampionIds,
        recentResults: existing?.recentResults,
        lpTrend: existing?.lpTrend,
        mainLane: existing?.mainLane,
        lastActiveAt: existing?.lastActiveAt,
        game: cloudAccount.game || 'League of Legends',
        server: cloudAccount.server,
        rank: cloudAccount.rank,
        profileIconId: cloudAccount.profileIconId,
        summonerLevel: cloudAccount.summonerLevel,
        leaguePoints: cloudAccount.leaguePoints,
        wins: cloudAccount.wins,
        losses: cloudAccount.losses,
        hotStreak: cloudAccount.hotStreak,
        topChampionId: cloudAccount.topChampionId,
        boardId: cloudAccount.boardId || undefined,
        lastRefreshed: cloudAccount.lastRefreshed,
      };
    });
  }

  private ensureAccountSyncIds(accounts: Account[]): Account[] {
    let changed = false;

    const normalized = accounts.map((account) => {
      if (account.syncId && account.syncId.trim()) {
        return account;
      }

      changed = true;
      return {
        ...account,
        syncId: this.createSyncId(),
      };
    });

    return changed ? normalized : accounts;
  }

  private getCloudStateHash(
    boards: CloudSyncBoard[],
    accounts: CloudSyncAccount[],
    settings: CloudSyncSettings
  ): string {
    return JSON.stringify({ boards, accounts, settings });
  }

  private buildLegacySyncId(name: string, server?: string): string {
    const safeName = name.toLowerCase().trim() || 'unknown';
    const safeServer = server?.toLowerCase().trim() || 'unknown';
    return `${safeName}::${safeServer}`;
  }

  private createSyncId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }

    return `sync-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  private async enrichAccountsWithRiotData(accounts: Account[]): Promise<Account[]> {
    return Promise.all(
      accounts.map(async (account) => {
        if (!account.name?.includes('#') || !account.server) return account;

        try {
          const [summonerId, tagline] = account.name.split('#');

          if (!this.riotApiService.isLikelyPuuid(account.id)) {
            account.id = await this.riotApiService.getPUUID(summonerId, tagline, account.server);
          }

          const puuid = account.id as string;

          const basicInfo = await this.riotApiService.getBasicAccountInfo(puuid, account.server);
          account.profileIconId = basicInfo.profileIconId;

          const masteryData = await this.riotApiService.getTopMasteryChampions(
            puuid,
            account.server
          );
          if (masteryData?.length) {
            const top = masteryData.reduce((a, b) => (b.championLevel > a.championLevel ? b : a));
            account.topChampionId = top.championId.toString();
          }

          const rankedInfo = await this.riotApiService.getRankedInfo(puuid, account.server);
          const soloQueue = rankedInfo?.find(
            (q: { queueType: string }) => q.queueType === 'RANKED_SOLO_5x5'
          );
          account.rank = soloQueue ? `${soloQueue.tier} ${soloQueue.rank}` : undefined;
        } catch (error) {
          console.error(`Error fetching Riot data for ${account.name}:`, error);
        }
        return account;
      })
    );
  }

  addAccount(): void {
    this.isModalOpen.set(true);
  }

  closeModal(): void {
    this.isModalOpen.set(false);
  }
  openSettings(): void {
    this.isSettingsOpen.set(true);
  }
  closeSettings(): void {
    this.isSettingsOpen.set(false);
  }

  openEditModal(account: Account): void {
    this.hoveredAccountId.set(null);
    this.editingAccount.set(account);
    this.isEditModalOpen.set(true);
  }

  closeEditModal(): void {
    this.isEditModalOpen.set(false);
    this.editingAccount.set(undefined);
  }

  openDeleteModal(account: Account): void {
    this.hoveredAccountId.set(null);
    this.deletingAccount.set(account);
    this.isDeleteModalOpen.set(true);
  }

  closeDeleteModal(): void {
    this.isDeleteModalOpen.set(false);
    this.deletingAccount.set(undefined);
  }

  async onAccountsAdded(newAccounts: Account[]): Promise<void> {
    const processed = await this.enrichAccountsWithRiotData(newAccounts);
    await this.updateAccountsAndSave((accounts) => [...accounts, ...processed]);
  }

  async onAccountUpdated(updatedAccount: Account): Promise<void> {
    await this.updateAccountsAndSave((accounts) =>
      accounts.map((acc) => (this.isSameAccount(acc, updatedAccount) ? updatedAccount : acc))
    );
  }

  async onAccountDeleted(deletedAccount: Account): Promise<void> {
    await this.updateAccountsAndSave((accounts) =>
      accounts.filter((acc) => !this.isSameAccount(acc, deletedAccount))
    );
  }

  async onRemoveFromFolder(account: Account): Promise<void> {
    await this.updateAccountsAndSave((accounts) =>
      accounts.map((acc) =>
        this.isSameAccount(acc, account) ? { ...acc, boardId: undefined } : acc
      )
    );
  }

  /** Card told us the user just drove this account (launch / session capture). */
  async onAccountActivity(account: Account): Promise<void> {
    await this.stampLastActive(account.syncId || String(account.id));
  }

  /** Records that LoL Vault itself saw this account in use, and persists it. */
  private async stampLastActive(vaultId: string): Promise<void> {
    if (!vaultId) return;

    const known = this.accounts().some((acc) => (acc.syncId || String(acc.id)) === vaultId);
    if (!known) return;

    const now = Date.now();
    await this.updateAccountsAndSave((accounts) =>
      accounts.map((acc) =>
        (acc.syncId || String(acc.id)) === vaultId ? { ...acc, lastActiveAt: now } : acc
      )
    );
  }

  async onAccountRefreshed(updatedAccount: Account): Promise<void> {
    await this.updateAccountsAndSave((accounts) =>
      accounts.map((acc) => (this.isSameAccount(acc, updatedAccount) ? updatedAccount : acc))
    );
  }
}
