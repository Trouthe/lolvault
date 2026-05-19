import {
  AfterViewInit,
  Component,
  computed,
  ElementRef,
  inject,
  OnDestroy,
  OnInit,
  signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { PaddleService } from '../../services/paddle.service';
import { PricingService, type OneTimePrice } from '../../services/pricing.service';
import { AuthService } from '../../services/auth.service';

interface PlanPrice {
  priceId: string;
  amount: string;
  amountMinor: number;
  currencyCode: string;
}

const EARLY_SUPPORTER_PRICE_ID = 'pri_01ks089v0ytt2pd49ryqcbd5xd';

const FALLBACK_EARLY_SUPPORTER: PlanPrice = {
  priceId: EARLY_SUPPORTER_PRICE_ID,
  amount: 'Price shown in checkout',
  amountMinor: 0,
  currencyCode: 'USD',
};

@Component({
  selector: 'app-home',
  templateUrl: './home.component.html',
  styleUrl: './home.component.scss',
})
export class HomeComponent implements OnInit, AfterViewInit, OnDestroy {
  readonly title = 'LoL Vault';
  readonly currentYear = new Date().getFullYear();

  readonly releasesUrl = 'https://github.com/Trouthe/lolvault/releases/latest';
  readonly windowsDownloadUrl = 'https://github.com/Trouthe/lolvault/releases/latest';
  readonly macDownloadUrl = 'https://github.com/Trouthe/lolvault/releases/latest';
  readonly discordUrl = 'https://discord.gg/lolvault';

  readonly premiumPrice = signal<PlanPrice>(FALLBACK_EARLY_SUPPORTER);

  readonly premiumButtonLabel = 'Unlock Early Supporter (one-time)';

  readonly premiumBillingHint =
    'Limited early access offer. One-time purchase, no subscription.';

  private readonly paddleService = inject(PaddleService);
  private readonly pricingService = inject(PricingService);
  private readonly authService = inject(AuthService);
  private readonly hostElement = inject(ElementRef<HTMLElement>);

  readonly currentUser = toSignal(this.authService.currentUser$, { initialValue: null });
  readonly primaryCtaHref = computed(() => (this.currentUser() ? '/dashboard' : '/auth'));
  readonly primaryCtaLabel = computed(() =>
    this.currentUser() ? 'Dashboard' : 'Start Free Tier'
  );

  private revealObserver?: IntersectionObserver;
  private revealMutationObserver?: MutationObserver;
  private readonly observedRevealNodes = new WeakSet<HTMLElement>();

  ngOnInit(): void {
    this.paddleService.init();
    void this.loadPricing();
  }

  ngAfterViewInit(): void {
    this.setupScrollReveals();
  }

  ngOnDestroy(): void {
    this.revealObserver?.disconnect();
    this.revealMutationObserver?.disconnect();
  }

  private setupScrollReveals(): void {
    const revealNodes = this.collectRevealNodes(this.hostElement.nativeElement);

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

    this.observeRevealNodes(revealNodes);
    this.observeRevealMutations();
  }

  private collectRevealNodes(root: ParentNode): HTMLElement[] {
    return Array.from(root.querySelectorAll('.reveal')) as HTMLElement[];
  }

  private observeRevealNodes(nodes: HTMLElement[]): void {
    for (const node of nodes) {
      if (this.observedRevealNodes.has(node)) {
        continue;
      }

      this.observedRevealNodes.add(node);
      this.revealObserver?.observe(node);
    }
  }

  private observeRevealMutations(): void {
    this.revealMutationObserver = new MutationObserver((mutations) => {
      const nextNodes: HTMLElement[] = [];

      for (const mutation of mutations) {
        mutation.addedNodes.forEach((addedNode) => {
          if (!(addedNode instanceof HTMLElement)) {
            return;
          }

          if (addedNode.classList.contains('reveal')) {
            nextNodes.push(addedNode);
          }

          nextNodes.push(...this.collectRevealNodes(addedNode));
        });
      }

      if (nextNodes.length) {
        this.observeRevealNodes(nextNodes);
      }
    });

    this.revealMutationObserver.observe(this.hostElement.nativeElement, {
      childList: true,
      subtree: true,
    });
  }

  private async loadPricing(): Promise<void> {
    try {
      const pricing = await this.pricingService.getPremiumPricing();
      this.premiumPrice.set(this.toPlanPrice(pricing.premium));
    } catch {
      // Keep fallback values when live pricing endpoints are unavailable.
    }
  }

  private toPlanPrice(price: OneTimePrice): PlanPrice {
    return {
      priceId: price.priceId,
      amount: price.amount,
      amountMinor: price.amountMinor,
      currencyCode: price.currencyCode,
    };
  }

  scrollToSection(sectionId: string, event: Event): void {
    event.preventDefault();

    const target = document.getElementById(sectionId);
    if (!target) {
      return;
    }

    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  buyPremium(): void {
    this.paddleService.openCheckout(this.premiumPrice().priceId);
  }
}
