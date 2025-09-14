import { Component } from '@angular/core';
import { input, output, signal, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Account } from '../../../models/interfaces/Account';
import { LOL_DATA } from '../../../models/constants';

@Component({
  selector: 'app-edit-account-modal',
  imports: [CommonModule, FormsModule],
  templateUrl: './edit-account-modal.component.html',
  styleUrl: './edit-account-modal.component.scss',
})
export class EditAccountModalComponent {
  isOpen = input<boolean>(false);
  account = input<Account | undefined>(undefined);

  closeModal = output<void>();
  accountUpdated = output<Account>();

  editForm = signal({
    username: '',
    password: '',
    displayName: '',
    server: '',
    rank: '',
  });

  servers = LOL_DATA.SERVERS;
  ranks = LOL_DATA.RANKS;

  showPassword = signal(false);

  constructor() {
    // Update form when account changes
    effect(() => {
      const acc = this.account();
      if (acc) {
        this.editForm.set({
          username: acc.username || '',
          password: acc.password || '',
          displayName: acc.name || '',
          server: acc.server || '',
          rank: acc.rank || '',
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
        displayName: acc.name || '',
        server: acc.server || '',
        rank: acc.rank || '',
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

  saveChanges() {
    const acc = this.account();
    const form = this.editForm();

    if (!acc || !form.username || !form.password) {
      return;
    }

    const updatedAccount: Account = {
      ...acc,
      username: form.username,
      password: form.password,
      name: form.displayName || form.username,
      server: form.server || undefined,
      rank: form.rank || undefined,
    };

    this.accountUpdated.emit(updatedAccount);
    this.close();
  }
}
