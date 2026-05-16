import { AfterViewInit, Component, computed, ElementRef, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { PaddleService } from '../../services/paddle.service';
import { PricingService, type RecurringPrice } from '../../services/pricing.service';

type BillingCycle = 'monthly' | 'yearly';

interface PlanPrice {
  priceId: string;
  amount: string;
  amountMinor: number;
  currencyCode: string;
}

const FALLBACK_MONTHLY: PlanPrice = {
  priceId: 'pri_01krnjteeh4nbz3kmdq8emje9e',
  amount: '$5.99',
  amountMinor: 599,
  currencyCode: 'USD',
};

const FALLBACK_YEARLY: PlanPrice = {
  priceId: 'pri_01krnjvsr30mync1qyz5998xj7',
  amount: '$59.99',
  amountMinor: 5999,
  currencyCode: 'USD',
};

@Component({
  selector: 'app-home',
  templateUrl: './home.component.html',
  styleUrl: './home.component.scss',
})
export class HomeComponent implements OnInit, AfterViewInit, OnDestroy {
  readonly title = 'LoL Vault';

  readonly releasesUrl = 'https://github.com/Trouthe/lolvault/releases/latest';
  readonly windowsDownloadUrl = 'https://github.com/Trouthe/lolvault/releases/latest';
  readonly macDownloadUrl = 'https://github.com/Trouthe/lolvault/releases/latest';
  readonly discordUrl = 'https://discord.gg/lolvault';

  readonly billingCycle = signal<BillingCycle>('monthly');
  readonly monthlyPrice = signal<PlanPrice>(FALLBACK_MONTHLY);
  readonly yearlyPrice = signal<PlanPrice>(FALLBACK_YEARLY);

  readonly selectedPrice = computed(() =>
    this.billingCycle() === 'monthly' ? this.monthlyPrice() : this.yearlyPrice()
  );

  readonly premiumPrice = computed(() => this.selectedPrice().amount);

  readonly premiumPeriodLabel = computed(() =>
    this.billingCycle() === 'monthly' ? 'monthly' : 'yearly'
  );

  readonly premiumButtonLabel = computed(() =>
    this.billingCycle() === 'monthly'
      ? `Go Premium Monthly - ${this.monthlyPrice().amount}`
      : `Go Premium Yearly - ${this.yearlyPrice().amount}`
  );

  readonly premiumBillingHint = computed(() => {
    if (this.billingCycle() === 'monthly') {
      return 'Billed every month.';
    }

    const monthlyAnnualCost = this.monthlyPrice().amountMinor * 12;
    const yearlyCost = this.yearlyPrice().amountMinor;
    const savings = monthlyAnnualCost - yearlyCost;

    if (savings <= 0) {
      return 'Billed once per year.';
    }

    return `Save ${this.formatCurrencyFromMinor(savings, this.yearlyPrice().currencyCode)} per year.`;
  });

  private readonly paddleService = inject(PaddleService);
  private readonly pricingService = inject(PricingService);
  private readonly hostElement = inject(ElementRef<HTMLElement>);

  private revealObserver?: IntersectionObserver;

  ngOnInit(): void {
    this.paddleService.init();
    void this.loadPricing();
  }

  ngAfterViewInit(): void {
    this.setupScrollReveals();
  }

  ngOnDestroy(): void {
    this.revealObserver?.disconnect();
  }

  private setupScrollReveals(): void {
    const revealNodes = Array.from(
      this.hostElement.nativeElement.querySelectorAll('.reveal')
    ) as HTMLElement[];

    if (!revealNodes.length) {
      return;
    }

    if (typeof IntersectionObserver === 'undefined') {
      revealNodes.forEach((node) => node.classList.add('is-visible'));
      return;
    }

    this.revealObserver = new IntersectionObserver(
      (entries, observer) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;

          (entry.target as HTMLElement).classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      },
      {
        threshold: 0.16,
        rootMargin: '0px 0px -8% 0px',
      }
    );

    revealNodes.forEach((node) => this.revealObserver?.observe(node));
  }

  private async loadPricing(): Promise<void> {
    try {
      const pricing = await this.pricingService.getPremiumPricing();
      this.monthlyPrice.set(this.toPlanPrice(pricing.monthly));
      this.yearlyPrice.set(this.toPlanPrice(pricing.yearly));
    } catch (error) {
      console.error('Failed to load dynamic Paddle pricing. Using fallback values.', error);
    }
  }

  private toPlanPrice(price: RecurringPrice): PlanPrice {
    return {
      priceId: price.priceId,
      amount: price.amount,
      amountMinor: price.amountMinor,
      currencyCode: price.currencyCode,
    };
  }

  private formatCurrencyFromMinor(amountMinor: number, currencyCode: string): string {
    const formatter = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currencyCode,
    });
    const fractionDigits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
    return formatter.format(amountMinor / 10 ** fractionDigits);
  }

  setBillingCycle(cycle: BillingCycle): void {
    this.billingCycle.set(cycle);
  }

  buyPremium(): void {
    this.paddleService.openCheckout(this.selectedPrice().priceId);
  }
}
