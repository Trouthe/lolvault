import { Component, inject, HostListener, ElementRef, ViewChild, OnDestroy } from '@angular/core';
import { signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AccCardComponent } from '../../components/acc-card/acc-card.component';
import { AddAccountModalComponent } from '../../components/modals/add-account-modal/add-account-modal.component';
import { EditAccountModalComponent } from '../../components/modals/edit-account-modal/edit-account-modal.component';
import { DeleteAccountModalComponent } from '../../components/modals/delete-account-modal/delete-account-modal.component';
import { SettingsModalComponent } from '../../components/modals/settings-modal/settings-modal.component';
import { Account } from '../../models/interfaces/Account';
import { Board } from '../../models/interfaces/Board';
import { RiotService } from '../../services/riot.service';
import { SettingsService } from '../../services/settings.service';
import { BoardService } from '../../services/board.service';
import { LOL_DATA } from '../../models/constants';
import { VERSION, REVISION } from '../../../environments/version';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    AccCardComponent,
    AddAccountModalComponent,
    EditAccountModalComponent,
    DeleteAccountModalComponent,
    SettingsModalComponent,
  ],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss',
})
export class DashboardComponent implements OnDestroy {
  @ViewChild('newBoardInput') newBoardInput!: ElementRef<HTMLInputElement>;

  version = [VERSION, REVISION];

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
  public championId = signal<string>('');
  public isSortMenuOpen = signal(false);
  public currentSort = signal<'all' | 'highest' | 'lowest' | 'unranked'>('all');

  // Board state
  public isCreatingBoard = signal(false);
  public newBoardName = signal('');
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

  // Hover state for accounts (to fix stuck hover when modal opens)
  public hoveredAccountId = signal<string | null>(null);
  public hoveredFolderId = signal<string | null>(null);

  // Services
  private riotService = inject(RiotService);
  public settingsService = inject(SettingsService);
  public boardService = inject(BoardService);

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

  public getAccountCountForBoard(boardId: string | null): number {
    return boardId === null
      ? this.accounts().length
      : this.accounts().filter((acc) => acc.boardId === boardId).length;
  }

  constructor() {
    this.loadBoards();
    this.loadAccounts();
    window.addEventListener('dragend', this.onGlobalDragEnd, true);
    document.addEventListener('dragstart', this.onGlobalDragStart, true);
  }

  ngOnDestroy(): void {
    window.removeEventListener('dragend', this.onGlobalDragEnd, true);
    document.removeEventListener('dragstart', this.onGlobalDragStart, true);
  }

  // ========== Utility Methods ==========

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
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const clean = accounts.map(({ profileIconId, topChampionId, ...rest }) => rest);
    await window.electronAPI.saveAccounts(clean);
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
    return `var(--folder-color-${colorName}, var(--folder-color-blue))`;
  }

  getCurrentBoardName(): string {
    const boardId = this.boardService.getSelectedBoardId()();
    if (boardId === null) return 'All Accounts';
    return this.boardService.getBoardById(boardId)?.name || 'Unknown Board';
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (!(event.target as HTMLElement).closest('.sort-menu-container') && this.isSortMenuOpen()) {
      this.isSortMenuOpen.set(false);
    }
  }

  toggleSortMenu(): void {
    this.isSortMenuOpen.set(!this.isSortMenuOpen());
  }

  setSortOption(option: 'all' | 'highest' | 'lowest' | 'unranked'): void {
    this.currentSort.set(option);
    this.isSortMenuOpen.set(false);
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

    // Build new account list preserving accounts not in current view
    const reorderedIds = new Set(reorderedFiltered.map((a) => a.id));
    const otherAccounts = allAccounts.filter((a) => !reorderedIds.has(a.id));

    // If viewing a specific board, insert reordered accounts at their board position
    // Otherwise just use reordered as the new order
    let newAccounts: Account[];
    if (selectedBoardId !== null) {
      // Find where the first board account was in the original list
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

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
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

    // Find the account being moved
    const account = this.accounts().find((acc) => String(acc.id) === accountId);
    if (!account) return;

    // If the account is already in this folder, do nothing
    const currentAccountBoardId = account.boardId ?? null;
    if (currentAccountBoardId === boardId) return;

    // Stop the account drag immediately to prevent commitAccountReorder from overwriting our changes
    this.isDraggingAccount.set(false);
    this.draggingAccountId.set(null);

    // Update the account's boardId without reloading all accounts
    const updated = this.accounts().map((acc) =>
      String(acc.id) === accountId
        ? { ...acc, boardId: boardId === null ? undefined : boardId }
        : acc
    );
    this.accounts.set(updated);
    await this.saveAccounts(updated);
  }

  selectBoard(boardId: string | null): void {
    if (this.wasDragging) return;
    this.boardService.selectBoard(boardId);
  }

  startCreatingBoard(): void {
    this.isCreatingBoard.set(true);
    setTimeout(() => this.newBoardInput?.nativeElement?.focus(), 0);
  }

  async confirmNewBoard(): Promise<void> {
    if (this.isConfirmingBoard) return;
    this.isConfirmingBoard = true;
    const name = this.newBoardName().trim();
    this.isCreatingBoard.set(false);
    this.newBoardName.set('');
    if (name) await this.boardService.createBoard(name);
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
    const updated = this.accounts().map((acc) =>
      acc.boardId === boardId ? { ...acc, boardId: undefined } : acc
    );
    this.accounts.set(updated);
    await this.saveAccounts(updated);
    await this.boardService.deleteBoard(boardId);
  }

  async loadBoards(): Promise<void> {
    await this.boardService.loadBoards();
  }

  async loadAccounts(): Promise<void> {
    try {
      const loaded = await window.electronAPI.loadAccounts();
      const updated = await this.enrichAccountsWithRiotData(loaded);
      this.accounts.set(updated);
      this.updateMasteryBackground();
    } catch (error) {
      console.error('Error loading accounts:', error);
    }
  }

  private async enrichAccountsWithRiotData(accounts: Account[]): Promise<Account[]> {
    return Promise.all(
      accounts.map(async (account) => {
        if (!account.name?.includes('#') || !account.server) return account;

        try {
          const [summonerId, tagline] = account.name.split('#');

          // Get PUUID if needed
          if (typeof account.id !== 'string' || account.id.length <= 20) {
            account.id = await this.riotService.getPUUID(summonerId, tagline, account.server);
          }

          const puuid = account.id as string;

          // Fetch display data (not saved to disk)
          const basicInfo = await this.riotService.getBasicAccountInfo(puuid, account.server);
          account.profileIconId = basicInfo.profileIconId;

          const masteryData = await this.riotService.getTopMasteryChampions(puuid, account.server);
          if (masteryData?.length) {
            const top = masteryData.reduce((a, b) => (b.championLevel > a.championLevel ? b : a));
            account.topChampionId = top.championId.toString();
          }

          const rankedInfo = await this.riotService.getRankedInfo(puuid, account.server);
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

  private async updateMasteryBackground(): Promise<void> {
    const account = this.accounts().find((acc) => acc.topChampionId);
    if (!account?.topChampionId) return;

    try {
      const { data } = await import('../../data/champions.json');
      const entry = Object.entries(data).find(([, c]) => c.key === account.topChampionId);
      if (entry) this.championId.set(entry[1].id);
    } catch (error) {
      console.error('Error loading champion data:', error);
    }
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
    const updated = [...this.accounts(), ...processed];
    this.accounts.set(updated);
    await this.saveAccounts(updated);
    this.updateMasteryBackground();
  }

  async onAccountUpdated(updatedAccount: Account): Promise<void> {
    const updated = this.accounts().map((acc) =>
      acc.id === updatedAccount.id ? updatedAccount : acc
    );
    this.accounts.set(updated);
    await this.saveAccounts(updated);
  }

  async onAccountDeleted(deletedAccount: Account): Promise<void> {
    const updated = this.accounts().filter((acc) => acc.id !== deletedAccount.id);
    this.accounts.set(updated);
    await this.saveAccounts(updated);
  }

  async onRemoveFromFolder(account: Account): Promise<void> {
    const updated = this.accounts().map((acc) =>
      acc.id === account.id ? { ...acc, boardId: undefined } : acc
    );
    this.accounts.set(updated);
    await this.saveAccounts(updated);
  }
}
