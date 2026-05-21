import { Component, inject } from '@angular/core';
import { input, output, signal, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Account } from '../../../models/interfaces/Account';
import { LOL_DATA } from '../../../models/constants';
import { RiotService } from '../../../services/riot.service';

@Component({
  selector: 'app-edit-account-modal',
  imports: [CommonModule, FormsModule],
  templateUrl: './edit-account-modal.component.html',
  styleUrl: './edit-account-modal.component.scss',
})
export class EditAccountModalComponent {
  private riotService = inject(RiotService);

  isOpen = input<boolean>(false);
  account = input<Account | undefined>(undefined);

  closeModal = output<void>();
  accountUpdated = output<Account>();

  editForm = signal({
    username: '',
    password: '',
    riotId: '',
    server: '',
  });

  servers = LOL_DATA.SERVERS;

  showPassword = signal(false);

  constructor() {
    // Update form when account changes
    effect(() => {
      const acc = this.account();
      if (acc) {
        this.editForm.set({
          username: acc.username || '',
          password: acc.password || '',
          riotId: acc.name || '',
          server: acc.server || '',
        });
      }
    });
  }

  private resetForm() {
    const acc = this.account();
    this.showPassword.set(false);
    if (acc) {
      this.editForm.set({
        username: acc.username || '',
        password: acc.password || '',
        riotId: acc.name || '',
        server: acc.server || '',
      });
    }
  }

  togglePasswordVisibility() {
    this.showPassword.set(!this.showPassword());
  }

  isRiotIdInvalid(): boolean {
    const riotId = this.editForm().riotId.trim();
    return riotId.length > 0 && !this.parseRiotId(riotId);
  }

  close() {
    this.resetForm();
    this.closeModal.emit();
  }

  async saveChanges() {
    const acc = this.account();
    const form = this.editForm();
    const parsedRiotId = this.parseRiotId(form.riotId);

    if (!acc || !parsedRiotId || !form.server) {
      return;
    }

    const username = form.username.trim();
    const password = form.password.trim();

    const fullName = `${parsedRiotId.displayName}#${parsedRiotId.tag}`;

    // Fetch PUUID and ranked info
    let puuid: string | undefined;
    let fetchedRank: string | undefined;

    try {
      puuid = await this.riotService.getPUUID(
        parsedRiotId.displayName,
        parsedRiotId.tag,
        form.server
      );
      console.log('Fetched PUUID:', puuid);

      // Fetch ranked info
      const rankedInfo = await this.riotService.getRankedInfo(puuid, form.server);
      if (rankedInfo && rankedInfo.length > 0) {
        // Find RANKED_SOLO_5x5 queue
        const soloQueue = rankedInfo.find(
          (q: { queueType: string }) => q.queueType === 'RANKED_SOLO_5x5'
        );
        if (soloQueue) {
          fetchedRank = `${soloQueue.tier} ${soloQueue.rank}`;
          console.log('Fetched rank:', fetchedRank);
        }
      }
    } catch (error) {
      console.error('Error fetching Riot data:', error);
    }

    const updatedAccount: Account = {
      ...acc,
      id: puuid || acc.id,
      username: username || undefined,
      password: password || undefined,
      name: fullName,
      server: form.server,
      rank: fetchedRank,
    };

    this.accountUpdated.emit(updatedAccount);
    this.close();
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
}
