import {
  Component,
  HostListener,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import type { User } from 'firebase/auth';
import { Unsubscribe, doc, onSnapshot, serverTimestamp, setDoc } from 'firebase/firestore';
import { BUILD_LABEL, VERSION } from '../../../environments/version';
import { AuthService } from '../../services/auth.service';
import { FirebaseService } from '../../services/firebase.service';

type SortOption = 'all' | 'highest' | 'lowest' | 'unranked';
type BoardColor =
  | 'default'
  | 'coral'
  | 'orange'
  | 'yellow'
  | 'lime'
  | 'teal'
  | 'cyan'
  | 'blue'
  | 'indigo'
  | 'violet'
  | 'pink'
  | 'rose'
  | 'mint';

type AddTab = 'single' | 'bulk';
type ThemeMode = 'light' | 'dark';
type PremiumEntitlementStatus = 'active' | 'expired' | 'none';

interface ThemeVariantOption {
  id: string;
  name: string;
}

interface PremiumEntitlementState {
  status: PremiumEntitlementStatus;
  hadPremiumBefore: boolean;
}

interface DashboardBoard {
  id: string;
  name: string;
  color: BoardColor;
  createdAt?: number;
}

interface DashboardAccount {
  id: number;
  syncId?: string;
  boardId: string | null;
  name: string;
  server: string;
  game?: string;
  rank?: string;
  wins?: number;
  losses?: number;
  leaguePoints?: number;
  profileIconId?: number;
  hotStreak?: boolean;
}

interface CloudSyncBoard {
  id: string;
  name: string;
  color: BoardColor;
  createdAt: number;
}

interface CloudSyncAccount {
  syncId: string;
  boardId: string | null;
  name: string;
  server: string;
  game?: string;
  rank?: string;
  wins?: number;
  losses?: number;
  leaguePoints?: number;
  profileIconId?: number;
  hotStreak?: boolean;
}

interface CloudSyncSettings {
  theme: ThemeMode;
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

const BOARD_COLORS: BoardColor[] = [
  'coral',
  'orange',
  'yellow',
  'lime',
  'teal',
  'cyan',
  'blue',
  'indigo',
  'violet',
  'pink',
  'rose',
  'mint',
];

const SERVERS = ['EUW', 'EUNE', 'NA', 'KR', 'OCE'];

const THEME_VARIANTS: ThemeVariantOption[] = [
  { id: 'default', name: 'Default Theme' },
  { id: 'lol-classic', name: 'LoL Classic' },
  { id: 'ionia', name: 'Ionia' },
  { id: 'targon', name: 'Targon' },
  { id: 'shurima', name: 'Shurima' },
  { id: 'bilgewater', name: 'Bilgewater' },
  { id: 'shadow-isles', name: 'Shadow Isles' },
  { id: 'freljord', name: 'Freljord' },
  { id: 'noxus', name: 'Noxus' },
  { id: 'demacia', name: 'Demacia' },
];

const SETTINGS_STORAGE_KEY = 'lolvault-web-dashboard-settings';
const PREMIUM_STATE_STORAGE_KEY = 'lolvault-web-premium-state';
const CLOUD_SYNC_COLLECTION = 'dashboardAccounts';
const CLOUD_SYNC_SCHEMA_VERSION = 3;

const DASHBOARD_BOARDS: DashboardBoard[] = [];

const DASHBOARD_ACCOUNTS: DashboardAccount[] = [];

@Component({
  selector: 'app-dashboard',
  imports: [FormsModule],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss',
})
export class DashboardComponent implements OnInit, OnDestroy {
  readonly version = [VERSION, BUILD_LABEL];
  private readonly authService = inject(AuthService);
  private readonly router = inject(Router);
  private readonly firebaseService = inject(FirebaseService);

  readonly boards = signal<DashboardBoard[]>(DASHBOARD_BOARDS);
  readonly accounts = signal<DashboardAccount[]>(DASHBOARD_ACCOUNTS);

  readonly selectedBoardId = signal<string | null>(null);
  readonly isSortMenuOpen = signal(false);
  readonly isProfileMenuOpen = signal(false);
  readonly currentSort = signal<SortOption>('all');

  readonly isCreatingBoard = signal(false);
  readonly newBoardName = signal('');
  readonly newBoardColor = signal<BoardColor>('default');

  readonly hoveredFolderId = signal<string | null>(null);
  readonly hoveredAccountId = signal<string | null>(null);

  readonly isModalOpen = signal(false);
  readonly isSettingsOpen = signal(false);
  readonly isEditModalOpen = signal(false);
  readonly isDeleteModalOpen = signal(false);

  readonly activeAddTab = signal<AddTab>('single');

  readonly editingAccount = signal<DashboardAccount | undefined>(undefined);
  readonly deletingAccount = signal<DashboardAccount | undefined>(undefined);

  readonly refreshingAccountId = signal<number | null>(null);
  readonly showMasteryBackground = signal(false);

  readonly theme = signal<ThemeMode>('dark');
  readonly themeVariant = signal<string>('default');
  readonly themeVariants = THEME_VARIANTS;
  readonly servers = SERVERS;

  readonly premiumState = signal<PremiumEntitlementState>(this.loadPremiumState());
  readonly isPremiumActive = computed(() => this.premiumState().status === 'active');

  readonly logoThemeSuffix = computed(() => (this.theme() === 'light' ? 'dark' : 'light'));
  readonly currentUser = toSignal<User | null>(this.authService.currentUser$, {
    initialValue: null,
  });
  readonly profileImageUrl = computed(
    () => this.currentUser()?.photoURL || this.getLocalProfileFallback()
  );

  readonly draggingAccountId = signal<string | null>(null);
  readonly draggingFolderId = signal<string | null>(null);
  readonly dragOverBoardId = signal<string | null>(null);
  private readonly tempBoards = signal<DashboardBoard[]>([]);
  private readonly tempAccounts = signal<DashboardAccount[]>([]);
  private readonly isDraggingFolder = signal(false);
  private readonly isDraggingAccount = signal(false);

  readonly displayedBoards = computed(() =>
    this.isDraggingFolder() ? this.tempBoards() : this.boards()
  );
  readonly totalAccountCount = computed(() => this.accounts().length);

  readonly currentBoardTitle = computed(() => this.getCurrentBoardName());

  readonly filteredAccounts = computed(() => {
    const selectedBoardId = this.selectedBoardId();
    const query = this._searchQuery().toLowerCase().trim();

    let filtered = this.accounts();

    if (selectedBoardId !== null) {
      filtered = filtered.filter((account) => account.boardId === selectedBoardId);
    }

    if (query) {
      filtered = filtered.filter((account) =>
        [account.name, account.server, account.rank]
          .filter((field): field is string => Boolean(field))
          .some((field) => field.toLowerCase().includes(query))
      );
    }

    const sortType = this.currentSort();
    if (sortType === 'unranked') {
      return filtered.filter((account) => !account.rank);
    }
    if (sortType === 'highest' || sortType === 'lowest') {
      return [...filtered].sort((left, right) => {
        const diff = this.getRankScore(right.rank) - this.getRankScore(left.rank);
        return sortType === 'highest' ? diff : -diff;
      });
    }
    return filtered;
  });

  readonly displayedAccounts = computed(() =>
    this.isDraggingAccount() ? this.tempAccounts() : this.filteredAccounts()
  );

  searchQuery = '';
  bulkAccountsText = '';

  singleRiotId = '';
  singleServer = '';

  editName = signal('');
  editServer = signal('EUW');

  private _searchQuery = signal('');
  private previousBodyOverflow = '';
  private cloudSyncUnsubscribe: Unsubscribe | null = null;
  private cloudSyncUserId: string | null = null;
  private cloudWriteDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private isApplyingCloudSnapshot = false;
  private lastCloudDataHash = '';
  private wasDragging = false;
  private lastReorderTime = 0;
  private readonly REORDER_THROTTLE_MS = 100;

  constructor() {
    this.initializeAppearance();
    this.initializeSettings();

    effect((onCleanup) => {
      const user = this.currentUser();

      if (!user) {
        this.stopCloudSyncListener();
        return;
      }

      this.startCloudSyncListener(user.uid);
      onCleanup(() => this.stopCloudSyncListener());
    });

    effect(() => {
      const user = this.currentUser();
      const boards = this.boards();
      const accounts = this.accounts();
      const theme = this.theme();
      const themeVariant = this.themeVariant();
      const showMasteryBackground = this.showMasteryBackground();

      void theme;
      void themeVariant;
      void showMasteryBackground;

      if (!user || this.isApplyingCloudSnapshot) {
        return;
      }

      this.scheduleCloudSnapshotPublish(user.uid, boards, accounts);
    });

    window.addEventListener('dragend', this.onGlobalDragEnd, true);
    document.addEventListener('dragstart', this.onGlobalDragStart, true);
  }

  ngOnInit(): void {
    this.previousBodyOverflow = document.body.style.overflow;
    this.applyBodyOverflowForViewport();
  }

  ngOnDestroy(): void {
    window.removeEventListener('dragend', this.onGlobalDragEnd, true);
    document.removeEventListener('dragstart', this.onGlobalDragStart, true);
    document.body.style.overflow = this.previousBodyOverflow;
    this.stopCloudSyncListener();

    if (this.cloudWriteDebounceTimer !== null) {
      clearTimeout(this.cloudWriteDebounceTimer);
      this.cloudWriteDebounceTimer = null;
    }
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

  @HostListener('window:resize')
  onWindowResize(): void {
    this.applyBodyOverflowForViewport();
  }

  toggleProfileMenu(event: Event): void {
    event.stopPropagation();
    this.isProfileMenuOpen.update((open) => !open);
  }

  getAccountProfileIconUrl(profileIconId?: number): string {
    return `https://ddragon.leagueoflegends.com/cdn/15.21.1/img/profileicon/${profileIconId || 29}.png`;
  }

  getLocalProfileFallback(): string {
    return 'fallback.png';
  }

  onProfileImageError(event: Event): void {
    const target = event.target as HTMLImageElement;
    const fallback = this.getLocalProfileFallback();

    if (target.dataset['fallbackApplied'] === 'true' && target.src.endsWith(fallback)) {
      return;
    }

    target.dataset['fallbackApplied'] = 'true';
    target.src = fallback;
  }

  onAccountImageError(event: Event): void {
    const target = event.target as HTMLImageElement;
    const fallback = this.getLocalProfileFallback();

    if (target.dataset['fallbackApplied'] === 'true' && target.src.endsWith(fallback)) {
      return;
    }

    target.dataset['fallbackApplied'] = 'true';
    target.src = fallback;
  }

  async signOutUser(): Promise<void> {
    try {
      this.isProfileMenuOpen.set(false);
      await this.authService.signOut();
      await this.router.navigateByUrl('/', { replaceUrl: true });
    } catch (error) {
      console.error('Failed to sign out:', error);
    }
  }

  selectBoard(boardId: string | null): void {
    if (this.wasDragging) {
      return;
    }

    this.selectedBoardId.set(boardId);
  }

  getBoardAccountCount(boardId: string | null): number {
    if (boardId === null) {
      return this.accounts().length;
    }
    return this.accounts().filter((account) => account.boardId === boardId).length;
  }

  getFolderColor(colorName: string): string {
    return `var(--folder-color-${colorName}, var(--folder-color-default))`;
  }

  getCurrentBoardName(): string {
    const boardId = this.selectedBoardId();
    if (boardId === null) {
      return 'All Accounts';
    }
    return this.boards().find((board) => board.id === boardId)?.name ?? 'Unknown Board';
  }

  onSearchChange(query: string): void {
    this.searchQuery = query;
    this._searchQuery.set(query);
  }

  toggleSortMenu(): void {
    this.isSortMenuOpen.set(!this.isSortMenuOpen());
  }

  setSortOption(option: SortOption): void {
    this.currentSort.set(option);
    this.isSortMenuOpen.set(false);
  }

  private resetDragState(): void {
    this.dragOverBoardId.set(null);
    this.draggingAccountId.set(null);
    this.draggingFolderId.set(null);
    this.isDraggingFolder.set(false);
    this.isDraggingAccount.set(false);
  }

  private onGlobalDragEnd = (): void => {
    if (this.isDraggingFolder() && this.draggingFolderId()) {
      this.boards.set(this.tempBoards());
    }

    if (this.isDraggingAccount() && this.draggingAccountId()) {
      this.commitAccountReorder();
    }

    this.resetDragState();
    this.wasDragging = true;
    setTimeout(() => {
      this.wasDragging = false;
    }, 100);
  };

  private onGlobalDragStart = (event: DragEvent): void => {
    const handle = (event.target as HTMLElement).closest('.account-drag-handle');
    if (!handle || !event.dataTransfer) {
      return;
    }

    const accountId = handle.getAttribute('data-account-id');
    if (!accountId) {
      return;
    }

    event.dataTransfer.setData('text/plain', accountId);
    event.dataTransfer.effectAllowed = 'move';

    this.draggingAccountId.set(accountId);
    this.wasDragging = true;
    this.tempAccounts.set([...this.filteredAccounts()]);
    this.isDraggingAccount.set(true);
  };

  private commitAccountReorder(): void {
    const reorderedFiltered = this.tempAccounts();
    const allAccounts = this.accounts();
    const selectedBoardId = this.selectedBoardId();

    const reorderedIds = new Set(reorderedFiltered.map((account) => account.id));
    const otherAccounts = allAccounts.filter((account) => !reorderedIds.has(account.id));

    let reorderedAll: DashboardAccount[];
    if (selectedBoardId !== null) {
      const firstBoardAccountIndex = allAccounts.findIndex(
        (account) => account.boardId === selectedBoardId
      );

      if (firstBoardAccountIndex === -1) {
        reorderedAll = [...otherAccounts, ...reorderedFiltered];
      } else {
        const before = otherAccounts.filter((_, index) => {
          const originalIndex = allAccounts.findIndex(
            (account) => account.id === otherAccounts[index]?.id
          );
          return originalIndex < firstBoardAccountIndex;
        });
        const after = otherAccounts.filter((account) => !before.includes(account));
        reorderedAll = [...before, ...reorderedFiltered, ...after];
      }
    } else {
      reorderedAll = reorderedFiltered;
    }

    this.accounts.set(reorderedAll);
  }

  onFolderDragStart(event: DragEvent, board: DashboardBoard): void {
    if (!event.dataTransfer) {
      return;
    }

    this.wasDragging = true;
    event.dataTransfer.setData('application/x-folder-id', board.id);
    event.dataTransfer.effectAllowed = 'move';
    this.draggingFolderId.set(board.id);
    this.tempBoards.set([...this.boards()]);
    this.isDraggingFolder.set(true);
  }

  onFolderDragOver(event: DragEvent, hoverIndex: number): void {
    event.preventDefault();
    event.stopPropagation();

    if (!this.draggingFolderId()) {
      return;
    }

    const now = Date.now();
    if (now - this.lastReorderTime < this.REORDER_THROTTLE_MS) {
      return;
    }

    const boards = this.tempBoards();
    const draggedId = this.draggingFolderId();
    const currentIndex = boards.findIndex((board) => board.id === draggedId);
    if (currentIndex === -1 || currentIndex === hoverIndex) {
      return;
    }

    this.lastReorderTime = now;
    const reordered = [...boards];
    const [removed] = reordered.splice(currentIndex, 1);
    reordered.splice(hoverIndex, 0, removed);
    this.tempBoards.set(reordered);
  }

  onAccountDragOver(event: DragEvent, hoverIndex: number): void {
    event.preventDefault();
    event.stopPropagation();

    if (!this.draggingAccountId()) {
      return;
    }

    const now = Date.now();
    if (now - this.lastReorderTime < this.REORDER_THROTTLE_MS) {
      return;
    }

    const accounts = this.tempAccounts();
    const draggedId = this.draggingAccountId();
    const currentIndex = accounts.findIndex((account) => account.id.toString() === draggedId);
    if (currentIndex === -1 || currentIndex === hoverIndex) {
      return;
    }

    this.lastReorderTime = now;
    const reordered = [...accounts];
    const [removed] = reordered.splice(currentIndex, 1);
    reordered.splice(hoverIndex, 0, removed);
    this.tempAccounts.set(reordered);
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
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }

    this.dragOverBoardId.set(boardId === null ? 'all' : boardId);
  }

  onDragLeave(): void {
    this.dragOverBoardId.set(null);
  }

  onDrop(event: DragEvent, boardId: string | null): void {
    event.preventDefault();
    this.dragOverBoardId.set(null);

    if (event.dataTransfer?.types.includes('application/x-folder-id')) {
      return;
    }

    const accountId = event.dataTransfer?.getData('text/plain');
    if (!accountId) {
      return;
    }

    const account = this.accounts().find((item) => item.id.toString() === accountId);
    if (!account) {
      return;
    }

    const currentBoardId = account.boardId ?? null;
    if (currentBoardId === boardId) {
      return;
    }

    this.isDraggingAccount.set(false);
    this.draggingAccountId.set(null);

    this.accounts.update((accounts) =>
      accounts.map((item) => (item.id === account.id ? { ...item, boardId } : item))
    );
  }

  startCreatingBoard(): void {
    this.newBoardName.set('');
    this.newBoardColor.set(BOARD_COLORS[Math.floor(Math.random() * BOARD_COLORS.length)]);
    this.isCreatingBoard.set(true);
  }

  onNewBoardKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      this.confirmNewBoard();
      return;
    }
    if (event.key === 'Escape') {
      this.cancelNewBoard();
    }
  }

  onNewBoardBlur(): void {
    this.confirmNewBoard();
  }

  private confirmNewBoard(): void {
    if (!this.isCreatingBoard()) {
      return;
    }

    const trimmedName = this.newBoardName().trim();
    if (!trimmedName) {
      this.cancelNewBoard();
      return;
    }

    const id = `${this.slugify(trimmedName)}-${Date.now().toString(36)}`;
    this.boards.update((boards) => [
      ...boards,
      {
        id,
        name: trimmedName,
        color: this.newBoardColor(),
        createdAt: Date.now(),
      },
    ]);

    this.isCreatingBoard.set(false);
    this.newBoardName.set('');
    this.selectBoard(id);
  }

  private cancelNewBoard(): void {
    this.newBoardName.set('');
    this.isCreatingBoard.set(false);
  }

  deleteBoard(boardId: string, event: Event): void {
    event.stopPropagation();
    this.boards.update((boards) => boards.filter((board) => board.id !== boardId));
    this.accounts.update((accounts) =>
      accounts.map((account) =>
        account.boardId === boardId
          ? {
              ...account,
              boardId: null,
            }
          : account
      )
    );

    if (this.selectedBoardId() === boardId) {
      this.selectedBoardId.set(null);
    }
  }

  onFolderMouseEnter(boardId: string): void {
    this.hoveredFolderId.set(boardId);
  }

  onFolderMouseLeave(): void {
    this.hoveredFolderId.set(null);
  }

  onAccountMouseEnter(accountId: string): void {
    this.hoveredAccountId.set(accountId);
  }

  onAccountMouseLeave(): void {
    this.hoveredAccountId.set(null);
  }

  addAccount(): void {
    this.resetAddAccountForm();
    this.activeAddTab.set('single');
    this.isModalOpen.set(true);
  }

  closeModal(): void {
    this.resetAddAccountForm();
    this.isModalOpen.set(false);
  }

  setActiveTab(tab: AddTab): void {
    this.activeAddTab.set(tab);
  }

  addSingleAccount(): void {
    const parsedRiotId = this.parseRiotId(this.singleRiotId);
    const server = this.singleServer.trim();

    if (!parsedRiotId || !server) {
      return;
    }

    const nextId = Math.max(0, ...this.accounts().map((account) => account.id)) + 1;
    const nextAccount: DashboardAccount = {
      id: nextId,
      syncId: this.createSyncId(),
      boardId: this.selectedBoardId(),
      name: `${parsedRiotId.displayName}#${parsedRiotId.tag}`,
      server,
      game: 'League of Legends',
      profileIconId: 29,
    };

    this.accounts.update((accounts) => [nextAccount, ...accounts]);
    this.closeModal();
  }

  importBulkAccounts(): void {
    const lines = this.bulkAccountsText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (!lines.length) {
      return;
    }

    let nextId = Math.max(0, ...this.accounts().map((account) => account.id)) + 1;
    const imported: DashboardAccount[] = [];

    for (const line of lines) {
      const parts = line.split(':').map((part) => part.trim());
      if (!parts.length) {
        continue;
      }

      const riotId = parts[0];
      const parsedRiotId = this.parseRiotId(riotId);
      if (!parsedRiotId) {
        continue;
      }

      const resolvedServer = parts[1] || 'EUW';
      const resolvedRank = this.normalizeRank(parts[2]);

      imported.push({
        id: nextId,
        syncId: this.createSyncId(),
        boardId: this.selectedBoardId(),
        name: `${parsedRiotId.displayName}#${parsedRiotId.tag}`,
        server: resolvedServer,
        game: 'League of Legends',
        rank: resolvedRank,
        profileIconId: 29,
      });

      nextId += 1;
    }

    if (!imported.length) {
      return;
    }

    this.accounts.update((accounts) => [...imported, ...accounts]);
    this.closeModal();
  }

  openSettings(): void {
    this.isSettingsOpen.set(true);
  }

  closeSettings(): void {
    this.isSettingsOpen.set(false);
  }

  setLightTheme(): void {
    this.theme.set('light');
    this.persistAppearance();
    this.applyAppearance();
  }

  setDarkTheme(): void {
    this.theme.set('dark');
    this.persistAppearance();
    this.applyAppearance();
  }

  setThemeVariant(variant: string): void {
    this.themeVariant.set(variant);
    this.persistAppearance();
    this.applyAppearance();
  }

  onMasteryBackgroundToggle(event: Event): void {
    const checkbox = event.target as HTMLInputElement;
    this.showMasteryBackground.set(checkbox.checked);
    this.persistSettings();
  }

  exportAccounts(): void {
    const header = 'riotId,server,rank';
    const rows = this.accounts().map((account) =>
      [account.name, account.server, account.rank || ''].join(',')
    );

    const csvData = [header, ...rows].join('\n');
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

  openEditModal(account: DashboardAccount): void {
    this.editingAccount.set(account);
    this.editName.set(account.name);
    this.editServer.set(account.server);
    this.isEditModalOpen.set(true);
  }

  closeEditModal(): void {
    this.isEditModalOpen.set(false);
    this.editingAccount.set(undefined);
  }

  saveEditedAccount(): void {
    const account = this.editingAccount();
    if (!account) {
      return;
    }

    const parsed = this.parseRiotId(this.editName());
    if (!parsed) {
      return;
    }

    this.accounts.update((accounts) =>
      accounts.map((item) =>
        item.id === account.id
          ? {
              ...item,
              name: `${parsed.displayName}#${parsed.tag}`,
              server: this.editServer(),
            }
          : item
      )
    );

    this.closeEditModal();
  }

  openDeleteModal(account: DashboardAccount): void {
    this.deletingAccount.set(account);
    this.isDeleteModalOpen.set(true);
  }

  closeDeleteModal(): void {
    this.isDeleteModalOpen.set(false);
    this.deletingAccount.set(undefined);
  }

  confirmDeleteAccount(): void {
    const account = this.deletingAccount();
    if (!account) {
      return;
    }

    this.accounts.update((accounts) => accounts.filter((item) => item.id !== account.id));
    this.closeDeleteModal();
  }

  onRemoveFromFolder(account: DashboardAccount): void {
    this.accounts.update((accounts) =>
      accounts.map((item) =>
        item.id === account.id
          ? {
              ...item,
              boardId: null,
            }
          : item
      )
    );
  }

  isRefreshing(accountId: number): boolean {
    return this.refreshingAccountId() === accountId;
  }

  refreshAccount(account: DashboardAccount): void {
    if (this.refreshingAccountId() === account.id) {
      return;
    }

    this.refreshingAccountId.set(account.id);
    setTimeout(() => {
      this.accounts.update((accounts) =>
        accounts.map((item) => {
          if (item.id !== account.id || !item.rank) {
            return item;
          }

          return {
            ...item,
            leaguePoints: Math.max(0, (item.leaguePoints ?? 0) + this.randomBetween(-8, 11)),
            wins: Math.max(0, (item.wins ?? 0) + this.randomBetween(0, 2)),
            losses: Math.max(0, (item.losses ?? 0) + this.randomBetween(0, 2)),
          };
        })
      );
      this.refreshingAccountId.set(null);
    }, 700);
  }

  openOpGG(event: Event, account: DashboardAccount): void {
    event.stopPropagation();

    const parsedRiotId = this.parseRiotId(account.name);
    if (!parsedRiotId || !account.server) {
      return;
    }

    const region = account.server.toLowerCase();
    const playerPath = `${encodeURIComponent(parsedRiotId.displayName)}-${encodeURIComponent(parsedRiotId.tag)}`;
    window.open(
      `https://www.op.gg/summoners/${region}/${playerPath}`,
      '_blank',
      'noopener,noreferrer'
    );
  }

  getRankName(rank: string | undefined): string {
    if (!rank) {
      return '';
    }

    const base = rank.split(' ')[0]?.trim();
    if (!base) {
      return '';
    }
    return base.charAt(0).toUpperCase() + base.slice(1).toLowerCase();
  }

  getAbbreviatedRank(rank: string | undefined): string {
    if (!rank) {
      return '';
    }

    const parts = rank.split(' ');
    const tier = parts[0]?.toUpperCase();
    const division = parts[1];

    if (tier === 'MASTER') {
      return 'M';
    }
    if (tier === 'GRANDMASTER') {
      return 'GM';
    }
    if (tier === 'CHALLENGER') {
      return 'C';
    }

    const tierAbbrev = tier?.charAt(0) || '';
    const divisionNum = this.romanToNumber(division);
    return `${tierAbbrev}${divisionNum}`;
  }

  getWinrate(account: DashboardAccount): number {
    const wins = account.wins ?? 0;
    const losses = account.losses ?? 0;
    const total = wins + losses;
    if (total === 0) {
      return 0;
    }
    return Math.round((wins / total) * 100);
  }

  private getRankScore(rank?: string): number {
    if (!rank) {
      return -1;
    }

    const [tier, division] = rank.split(' ');
    const tierWeight: Record<string, number> = {
      IRON: 0,
      BRONZE: 1,
      SILVER: 2,
      GOLD: 3,
      PLATINUM: 4,
      EMERALD: 5,
      DIAMOND: 6,
      MASTER: 7,
      GRANDMASTER: 8,
      CHALLENGER: 9,
    };

    const divisionWeight: Record<string, number> = {
      IV: 0,
      III: 1,
      II: 2,
      I: 3,
    };

    const normalizedTier = tier?.toUpperCase() ?? 'IRON';
    return (tierWeight[normalizedTier] ?? 0) * 10 + (divisionWeight[division] ?? 0);
  }

  private parseRiotId(input: string): { displayName: string; tag: string } | null {
    const trimmed = input.trim();
    const separatorIndex = trimmed.lastIndexOf('#');
    if (separatorIndex <= 0 || separatorIndex >= trimmed.length - 1) {
      return null;
    }

    const displayName = trimmed.slice(0, separatorIndex).trim();
    const tag = trimmed.slice(separatorIndex + 1).trim();
    if (!displayName || !tag) {
      return null;
    }

    return { displayName, tag };
  }

  private romanToNumber(roman: string | undefined): string {
    if (!roman) {
      return '';
    }
    const romanMap: Record<string, string> = {
      I: '1',
      II: '2',
      III: '3',
      IV: '4',
    };
    return romanMap[roman] || roman;
  }

  private randomBetween(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
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

          if (this.boards().length || this.accounts().length) {
            void this.publishCloudSnapshot(userId, this.boards(), this.accounts());
          }

          return;
        }

        const data = snapshot.data() as CloudSyncDocumentData;
        const cloudBoards = this.deserializeCloudBoards(data.boards);
        const cloudAccounts = this.deserializeCloudAccounts(data.accounts, cloudBoards);
        const cloudSettings = this.deserializeCloudSettings(data.settings);

        this.lastCloudDataHash = this.getCloudStateHash(cloudBoards, cloudAccounts, cloudSettings);
        this.isApplyingCloudSnapshot = true;

        try {
          this.boards.set(cloudBoards);
          this.accounts.set(this.materializeWebAccounts(cloudAccounts));
          this.applyCloudSettings(cloudSettings);

          const selectedBoard = this.selectedBoardId();
          if (selectedBoard && !cloudBoards.some((board) => board.id === selectedBoard)) {
            this.selectedBoardId.set(null);
          }
        } finally {
          this.isApplyingCloudSnapshot = false;
        }
      },
      (error) => {
        console.error('Realtime cloud sync listener failed:', error);
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

  private scheduleCloudSnapshotPublish(
    userId: string,
    boards: DashboardBoard[],
    accounts: DashboardAccount[]
  ): void {
    const payload = this.buildCloudSyncPayload(boards, accounts);
    const hash = this.getCloudStateHash(payload.boards, payload.accounts, payload.settings);

    if (hash === this.lastCloudDataHash) {
      return;
    }

    if (this.cloudWriteDebounceTimer !== null) {
      clearTimeout(this.cloudWriteDebounceTimer);
    }

    this.cloudWriteDebounceTimer = setTimeout(() => {
      this.cloudWriteDebounceTimer = null;
      void this.publishCloudSnapshot(userId, this.boards(), this.accounts());
    }, 350);
  }

  private async publishCloudSnapshot(
    userId: string,
    boards: DashboardBoard[],
    accounts: DashboardAccount[]
  ): Promise<void> {
    const payload = this.buildCloudSyncPayload(boards, accounts);
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
        updatedFrom: 'web',
      },
      { merge: true }
    );

    this.lastCloudDataHash = hash;
  }

  private getCloudSyncDocument(userId: string) {
    return doc(this.firebaseService.db, CLOUD_SYNC_COLLECTION, userId);
  }

  private buildCloudSyncPayload(
    boards: DashboardBoard[],
    accounts: DashboardAccount[]
  ): CloudSyncPayload {
    return {
      boards: this.serializeCloudBoards(boards),
      accounts: this.serializeCloudAccounts(accounts),
      settings: this.serializeCloudSettings(),
    };
  }

  private serializeCloudBoards(boards: DashboardBoard[]): CloudSyncBoard[] {
    return boards.map((board) => ({
      id: board.id,
      name: board.name,
      color: board.color,
      createdAt: board.createdAt ?? 0,
    }));
  }

  private serializeCloudAccounts(accounts: DashboardAccount[]): CloudSyncAccount[] {
    return accounts.map((account) =>
      this.omitUndefinedFields<CloudSyncAccount>({
        syncId: account.syncId || this.buildLegacySyncId(account.name, account.server),
        boardId: account.boardId ?? null,
        name: account.name,
        server: account.server,
        game: account.game,
        rank: account.rank,
        wins: account.wins,
        losses: account.losses,
        leaguePoints: account.leaguePoints,
        profileIconId: account.profileIconId,
        hotStreak: account.hotStreak,
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
      theme: this.theme(),
      themeVariant: this.themeVariant(),
      showMasteryBackground: this.showMasteryBackground(),
    };
  }

  private deserializeCloudSettings(rawSettings: unknown): CloudSyncSettings {
    const parsed = rawSettings && typeof rawSettings === 'object' ? rawSettings : {};
    const candidate = parsed as Partial<CloudSyncSettings>;

    const resolvedTheme: ThemeMode =
      candidate.theme === 'light' || candidate.theme === 'dark' ? candidate.theme : this.theme();

    const resolvedThemeVariant =
      typeof candidate.themeVariant === 'string' &&
      this.themeVariants.some((variant) => variant.id === candidate.themeVariant)
        ? candidate.themeVariant
        : this.themeVariant();

    return {
      theme: resolvedTheme,
      themeVariant: resolvedThemeVariant,
      showMasteryBackground:
        typeof candidate.showMasteryBackground === 'boolean'
          ? candidate.showMasteryBackground
          : this.showMasteryBackground(),
    };
  }

  private applyCloudSettings(settings: CloudSyncSettings): void {
    this.theme.set(settings.theme);
    this.themeVariant.set(settings.themeVariant);
    this.showMasteryBackground.set(settings.showMasteryBackground);
    this.applyAppearance();
    this.persistAppearance();
    this.persistSettings();
  }

  private deserializeCloudBoards(rawBoards: unknown): CloudSyncBoard[] {
    if (!Array.isArray(rawBoards)) {
      return [];
    }

    const parsedBoards: CloudSyncBoard[] = [];

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
        color: this.ensureBoardColor(board.color),
        createdAt: typeof board.createdAt === 'number' ? board.createdAt : Date.now(),
      });
    }

    return parsedBoards;
  }

  private deserializeCloudAccounts(
    rawAccounts: unknown,
    boards: DashboardBoard[]
  ): CloudSyncAccount[] {
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
          : this.buildLegacySyncId(account.name || '', account.server || '');

      if (
        !syncId ||
        typeof account.name !== 'string' ||
        !account.name.trim() ||
        typeof account.server !== 'string' ||
        !account.server.trim()
      ) {
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
        server: account.server,
        game: typeof account.game === 'string' ? account.game : undefined,
        rank: typeof account.rank === 'string' ? account.rank : undefined,
        wins: typeof account.wins === 'number' ? account.wins : undefined,
        losses: typeof account.losses === 'number' ? account.losses : undefined,
        leaguePoints: typeof account.leaguePoints === 'number' ? account.leaguePoints : undefined,
        profileIconId:
          typeof account.profileIconId === 'number' ? account.profileIconId : undefined,
        hotStreak: typeof account.hotStreak === 'boolean' ? account.hotStreak : undefined,
      });
    }

    return parsedAccounts;
  }

  private materializeWebAccounts(cloudAccounts: CloudSyncAccount[]): DashboardAccount[] {
    const existingBySyncId = new Map<string, DashboardAccount>();

    for (const account of this.accounts()) {
      const syncId = account.syncId || this.buildLegacySyncId(account.name, account.server);
      existingBySyncId.set(syncId, account);
    }

    const usedIds = new Set<number>(this.accounts().map((account) => account.id));
    let nextId = Math.max(0, ...this.accounts().map((account) => account.id)) + 1;

    const getNextId = (): number => {
      while (usedIds.has(nextId)) {
        nextId += 1;
      }

      const id = nextId;
      usedIds.add(id);
      nextId += 1;
      return id;
    };

    return cloudAccounts.map((cloudAccount) => {
      const existing = existingBySyncId.get(cloudAccount.syncId);

      return {
        id: existing?.id ?? getNextId(),
        syncId: cloudAccount.syncId,
        boardId: cloudAccount.boardId,
        name: cloudAccount.name,
        server: cloudAccount.server,
        game: cloudAccount.game,
        rank: cloudAccount.rank,
        wins: cloudAccount.wins,
        losses: cloudAccount.losses,
        leaguePoints: cloudAccount.leaguePoints,
        profileIconId: cloudAccount.profileIconId,
        hotStreak: cloudAccount.hotStreak,
      };
    });
  }

  private ensureBoardColor(value: unknown): BoardColor {
    if (typeof value !== 'string') {
      return 'default';
    }

    const normalized = value as BoardColor;
    if (normalized === 'default' || BOARD_COLORS.includes(normalized)) {
      return normalized;
    }

    return 'default';
  }

  private getCloudStateHash(
    boards: CloudSyncBoard[],
    accounts: CloudSyncAccount[],
    settings: CloudSyncSettings
  ): string {
    return JSON.stringify({ boards, accounts, settings });
  }

  private buildLegacySyncId(name: string, server: string): string {
    const safeName = name.toLowerCase().trim() || 'unknown';
    const safeServer = server.toLowerCase().trim() || 'unknown';
    return `${safeName}::${safeServer}`;
  }

  private createSyncId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }

    return `sync-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  private normalizeRank(rawRank: string | undefined): string | undefined {
    if (!rawRank) {
      return undefined;
    }

    const trimmed = rawRank.trim();
    if (!trimmed) {
      return undefined;
    }

    const [tier, division] = trimmed.split(' ');
    if (!tier) {
      return undefined;
    }

    const normalizedTier = tier.charAt(0).toUpperCase() + tier.slice(1).toLowerCase();
    if (!division) {
      return normalizedTier;
    }

    return `${normalizedTier} ${division.toUpperCase()}`;
  }

  private resetAddAccountForm(): void {
    this.singleRiotId = '';
    this.singleServer = '';
    this.bulkAccountsText = '';
  }

  private applyBodyOverflowForViewport(): void {
    if (window.matchMedia('(max-width: 1000px)').matches) {
      document.body.style.overflow = this.previousBodyOverflow;
      return;
    }

    document.body.style.overflow = 'hidden';
  }

  private initializeAppearance(): void {
    const savedTheme = localStorage.getItem('theme');
    const savedVariant = localStorage.getItem('themeVariant');

    if (savedTheme === 'light' || savedTheme === 'dark') {
      this.theme.set(savedTheme);
    } else {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      this.theme.set(prefersDark ? 'dark' : 'light');
    }

    if (savedVariant && this.themeVariants.some((variant) => variant.id === savedVariant)) {
      this.themeVariant.set(savedVariant);
    }

    this.applyAppearance();
  }

  private initializeSettings(): void {
    try {
      const stored = localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (!stored) {
        return;
      }

      const parsed = JSON.parse(stored) as { showMasteryBackground?: boolean };
      this.showMasteryBackground.set(Boolean(parsed.showMasteryBackground));
    } catch (error) {
      console.error('Failed to load dashboard settings:', error);
    }
  }

  private loadPremiumState(): PremiumEntitlementState {
    const fallbackHadPremiumBefore = false;

    try {
      const raw = localStorage.getItem(PREMIUM_STATE_STORAGE_KEY);
      if (!raw) {
        return {
          status: fallbackHadPremiumBefore ? 'expired' : 'none',
          hadPremiumBefore: fallbackHadPremiumBefore,
        };
      }

      const parsed = JSON.parse(raw) as Partial<PremiumEntitlementState>;
      const status = this.isPremiumStatus(parsed.status)
        ? parsed.status
        : fallbackHadPremiumBefore
          ? 'expired'
          : 'none';

      const hadPremiumBefore =
        typeof parsed.hadPremiumBefore === 'boolean' ? parsed.hadPremiumBefore : status !== 'none';

      return {
        status,
        hadPremiumBefore,
      };
    } catch {
      return {
        status: fallbackHadPremiumBefore ? 'expired' : 'none',
        hadPremiumBefore: fallbackHadPremiumBefore,
      };
    }
  }

  private isPremiumStatus(value: unknown): value is PremiumEntitlementStatus {
    return value === 'active' || value === 'expired' || value === 'none';
  }

  private applyAppearance(): void {
    document.documentElement.setAttribute('data-theme', this.theme());
    document.documentElement.setAttribute('data-theme-variant', this.themeVariant());
  }

  private persistAppearance(): void {
    localStorage.setItem('theme', this.theme());
    localStorage.setItem('themeVariant', this.themeVariant());
  }

  private persistSettings(): void {
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        showMasteryBackground: this.showMasteryBackground(),
      })
    );
  }

  private slugify(input: string): string {
    return input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }
}
