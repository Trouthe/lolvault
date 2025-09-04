/* eslint-disable @typescript-eslint/no-explicit-any */
import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AccCardComponent } from '../../components/acc-card/acc-card.component';
@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, AccCardComponent],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss',
})
export class DashboardComponent {
  public accounts: any[] = [];

  constructor() {
    this.loadAccounts();
  }

  async loadAccounts() {
    try {
      this.accounts = await window.electronAPI.loadAccounts();
    } catch (error) {
      console.error('Error loading accounts:', error);
    }
  }
}
