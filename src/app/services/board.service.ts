import { Injectable, signal } from '@angular/core';
import { Board } from '../models/interfaces/Board';

const FOLDER_COLOR_PREFIX = '--folder-color-';

function getFolderColorNames(): string[] {
  if (typeof document === 'undefined') return ['default'];

  const styles = getComputedStyle(document.documentElement);
  const names: string[] = [];

  for (const prop of styles) {
    if (typeof prop === 'string' && prop.startsWith(FOLDER_COLOR_PREFIX)) {
      const name = prop.slice(FOLDER_COLOR_PREFIX.length);
      if (name && name !== 'default') names.push(name);
    }
  }

  return names.length ? names : ['default'];
}

function getRandomFolderColor(): string {
  const names = getFolderColorNames();
  return names[Math.floor(Math.random() * names.length)] ?? 'default';
}

@Injectable({
  providedIn: 'root',
})
export class BoardService {
  private boards = signal<Board[]>([]);
  private selectedBoardId = signal<string | null>(null); // null means "All Accounts"

  getRandomFolderColor(): string {
    return getRandomFolderColor();
  }

  getBoards() {
    return this.boards;
  }

  getSelectedBoardId() {
    return this.selectedBoardId;
  }

  selectBoard(boardId: string | null) {
    this.selectedBoardId.set(boardId);
  }

  async loadBoards(): Promise<Board[]> {
    try {
      const loadedBoards = await window.electronAPI.loadBoards();
      // Migrate boards without colors
      let needsSave = false;
      const migratedBoards = loadedBoards.map((board) => {
        if (!board.color) {
          needsSave = true;
          return { ...board, color: getRandomFolderColor() };
        }
        return board;
      });
      this.boards.set(migratedBoards);
      if (needsSave) {
        await window.electronAPI.saveBoards(migratedBoards);
      }
      return migratedBoards;
    } catch (error) {
      console.error('Error loading boards:', error);
      return [];
    }
  }

  async saveBoards(): Promise<boolean> {
    try {
      const result = await window.electronAPI.saveBoards(this.boards());
      return result.success;
    } catch (error) {
      console.error('Error saving boards:', error);
      return false;
    }
  }

  async createBoard(name: string): Promise<Board> {
    return this.createBoardWithColor(name, getRandomFolderColor(), false);
  }

  async createBoardWithColor(name: string, color: string, autoSelect = false): Promise<Board> {
    const newBoard: Board = {
      id: crypto.randomUUID(),
      name,
      color,
      createdAt: Date.now(),
    };

    this.boards.update((boards) => [...boards, newBoard]);
    await this.saveBoards();

    if (autoSelect) {
      this.selectedBoardId.set(newBoard.id);
    }

    return newBoard;
  }

  async updateBoard(boardId: string, updates: Partial<Board>): Promise<void> {
    this.boards.update((boards) =>
      boards.map((board) => (board.id === boardId ? { ...board, ...updates } : board))
    );
    await this.saveBoards();
  }

  async deleteBoard(boardId: string): Promise<void> {
    this.boards.update((boards) => boards.filter((board) => board.id !== boardId));

    if (this.selectedBoardId() === boardId) {
      this.selectedBoardId.set(null);
    }

    await this.saveBoards();
  }

  getBoardById(boardId: string): Board | undefined {
    return this.boards().find((board) => board.id === boardId);
  }

  async reorderBoards(fromIndex: number, toIndex: number): Promise<void> {
    const currentBoards = [...this.boards()];
    const [movedBoard] = currentBoards.splice(fromIndex, 1);
    currentBoards.splice(toIndex, 0, movedBoard);
    this.boards.set(currentBoards);
    await this.saveBoards();
  }

  async setBoards(boards: Board[]): Promise<void> {
    this.boards.set(boards);
    await this.saveBoards();
  }

  getBoardIndex(boardId: string): number {
    return this.boards().findIndex((board) => board.id === boardId);
  }
}
