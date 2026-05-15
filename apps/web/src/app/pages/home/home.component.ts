import { Component, inject, OnInit } from '@angular/core';
import { PaddleService } from '../../services/paddle.service';

@Component({
  selector: 'app-home',
  templateUrl: './home.component.html',
  styleUrl: './home.component.scss',
})
export class HomeComponent implements OnInit {
  readonly title = 'LoL Vault';

  readonly YEARLY_PRICE_ID = 'pri_01krnjvsr30mync1qyz5998xj7';
  readonly MONTHLY_PRICE_ID = 'pri_01krnjteeh4nbz3kmdq8emje9e';

  private readonly paddleService = inject(PaddleService);

  ngOnInit(): void {
    this.paddleService.init();
  }

  buyMonthly(): void {
    this.paddleService.openCheckout(this.MONTHLY_PRICE_ID);
  }

  buyYearly(): void {
    this.paddleService.openCheckout(this.YEARLY_PRICE_ID);
  }
}
