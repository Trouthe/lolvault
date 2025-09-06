import { Component } from '@angular/core';
import { input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Account } from '../../models/interfaces/Account';

@Component({
  selector: 'app-delete-account-modal',
  imports: [CommonModule],
  templateUrl: './delete-account-modal.component.html',
  styleUrl: './delete-account-modal.component.scss',
})
export class DeleteAccountModalComponent {
  isOpen = input<boolean>(false);
  account = input<Account | undefined>(undefined);

  closeModal = output<void>();
  accountDeleted = output<Account>();

  close() {
    this.closeModal.emit();
  }

  confirmDelete() {
    const acc = this.account();
    if (acc) {
      this.accountDeleted.emit(acc);
    }
    this.close();
  }
}
