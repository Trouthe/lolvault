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
  private static readonly fallbackPricingUrls = [
    '/api/paddle/pricing',
    'https://us-central1-lolvault.cloudfunctions.net/getPaddlePremiumPricing',
  ];

  async getPremiumPricing(): Promise<PremiumPricingResponse> {
    const pricingUrls = this.getPricingUrls();
    let lastError: unknown;

    for (const url of pricingUrls) {
      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
          },
        });

        if (!response.ok) {
          throw new Error(`Pricing request failed with status ${response.status}`);
        }

        return (await response.json()) as PremiumPricingResponse;
      } catch (error) {
        lastError = error;
      }
    }

    if (lastError instanceof Error) {
      throw lastError;
    }

    throw new Error('Pricing request failed for all configured endpoints.');
  }

  private getPricingUrls(): string[] {
    const primary = (environment.paddlePricingApiUrl || '').trim();
    const all = [primary, ...PricingService.fallbackPricingUrls].filter((url) => url.length > 0);
    return [...new Set(all)];
  }
}
