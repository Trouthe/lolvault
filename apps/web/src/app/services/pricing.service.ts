import { Injectable } from '@angular/core';
import { environment } from '../../environments/environment';

export interface RecurringPrice {
  priceId: string;
  amount: string;
  amountMinor: number;
  currencyCode: string;
  interval: 'month' | 'year';
  frequency: number;
}

export interface PremiumPricingResponse {
  productId: string;
  monthly: RecurringPrice;
  yearly: RecurringPrice;
  fetchedAt: string;
}

@Injectable({
  providedIn: 'root',
})
export class PricingService {
  async getPremiumPricing(): Promise<PremiumPricingResponse> {
    const response = await fetch(environment.paddlePricingApiUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Pricing request failed with status ${response.status}`);
    }

    return (await response.json()) as PremiumPricingResponse;
  }
}
