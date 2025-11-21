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
    displayName: '',
    tag: '',
    server: '',
  });

  servers = LOL_DATA.SERVERS;

  showPassword = signal(false);

  constructor() {
    // Update form when account changes
    effect(() => {
      const acc = this.account();
      if (acc) {
        // Split name into displayName and tag if it contains #
        const [displayName, tag] = acc.name?.includes('#')
          ? acc.name.split('#')
          : [acc.name || '', ''];

        this.editForm.set({
          username: acc.username || '',
          password: acc.password || '',
          displayName: displayName,
          tag: tag,
          server: acc.server || '',
        });
      }
    });
  }

  private resetForm() {
    const acc = this.account();
    this.showPassword.set(false);
    if (acc) {
      const [displayName, tag] = acc.name?.includes('#')
        ? acc.name.split('#')
        : [acc.name || '', ''];

      this.editForm.set({
        username: acc.username || '',
        password: acc.password || '',
        displayName: displayName,
        tag: tag,
        server: acc.server || '',
      });
    }
  }

  togglePasswordVisibility() {
    this.showPassword.set(!this.showPassword());
  }

  close() {
    this.resetForm();
    this.closeModal.emit();
  }

  async saveChanges() {
    const acc = this.account();
    const form = this.editForm();

    if (
      !acc ||
      !form.username ||
      !form.password ||
      !form.displayName ||
      !form.tag ||
      !form.server
    ) {
      return;
    }

    // Combine displayName and tag with #
    const fullName = `${form.displayName}#${form.tag}`;

    // Fetch PUUID and ranked info
    let puuid: string | undefined;
    let fetchedRank: string | undefined;

    try {
      puuid = await this.riotService.getPUUID(form.displayName, form.tag, form.server);
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
      username: form.username,
      password: form.password,
      name: fullName,
      server: form.server,
      rank: fetchedRank,
    };

    this.accountUpdated.emit(updatedAccount);
    this.close();
  }
}
