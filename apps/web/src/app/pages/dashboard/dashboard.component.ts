import { Component, HostListener, OnDestroy, OnInit, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { BUILD_LABEL, VERSION } from '../../../environments/version';

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

interface ThemeVariantOption {
  id: string;
  name: string;
}

interface DashboardBoard {
  id: string;
  name: string;
  color: BoardColor;
}

interface DashboardAccount {
  id: number;
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

const DASHBOARD_BOARDS: DashboardBoard[] = [
  { id: 'boosting', name: 'Boosting', color: 'cyan' },
  { id: 'high-mmr', name: 'High MMR', color: 'teal' },
  { id: 'placements', name: 'Placements', color: 'yellow' },
];

const DASHBOARD_ACCOUNTS: DashboardAccount[] = [
  {
    id: 1,
    boardId: 'boosting',
    name: 'Astra#2123',
    server: 'EUW',
    rank: 'Diamond II',
    wins: 55,
    losses: 37,
    leaguePoints: 74,
    profileIconId: 29,
    hotStreak: true,
  },
  {
    id: 2,
    boardId: 'boosting',
    name: 'Noctis#1102',
    server: 'NA',
    rank: 'Emerald I',
    wins: 61,
    losses: 49,
    leaguePoints: 12,
    profileIconId: 640,
  },
  {
    id: 3,
    boardId: 'high-mmr',
    name: 'Velis#8861',
    server: 'KR',
    rank: 'Master I',
    wins: 104,
    losses: 81,
    leaguePoints: 221,
    profileIconId: 5178,
  },
  {
    id: 4,
    boardId: 'placements',
    name: 'Sparrow#0044',
    server: 'EUNE',
    wins: 7,
    losses: 3,
    profileIconId: 4572,
  },
  {
    id: 5,
    boardId: null,
    name: 'Westfall#9871',
    server: 'OCE',
    rank: 'Platinum III',
    wins: 41,
    losses: 34,
    leaguePoints: 66,
    profileIconId: 5884,
  },
];

@Component({
  selector: 'app-dashboard',
  imports: [FormsModule],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss',
})
export class DashboardComponent implements OnInit, OnDestroy {
  readonly version = [VERSION, BUILD_LABEL];

  readonly boards = signal<DashboardBoard[]>(DASHBOARD_BOARDS);
  readonly accounts = signal<DashboardAccount[]>(DASHBOARD_ACCOUNTS);

  readonly selectedBoardId = signal<string | null>(null);
  readonly isSortMenuOpen = signal(false);
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

  readonly logoThemeSuffix = computed(() => (this.theme() === 'light' ? 'dark' : 'light'));

  readonly displayedBoards = computed(() => this.boards());
  readonly totalAccountCount = computed(() => this.accounts().length);

  readonly currentBoardTitle = computed(() => this.getCurrentBoardName());

  readonly displayedAccounts = computed(() => {
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

  searchQuery = '';
  bulkAccountsText = '';

  singleRiotId = '';
  singleServer = '';

  editName = signal('');
  editServer = signal('EUW');

  private _searchQuery = signal('');
  private previousBodyOverflow = '';

  constructor() {
    this.initializeAppearance();
    this.initializeSettings();
  }

  ngOnInit(): void {
    this.previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }

  ngOnDestroy(): void {
    document.body.style.overflow = this.previousBodyOverflow;
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (!(event.target as HTMLElement).closest('.sort-menu-container') && this.isSortMenuOpen()) {
      this.isSortMenuOpen.set(false);
    }
  }

  selectBoard(boardId: string | null): void {
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
