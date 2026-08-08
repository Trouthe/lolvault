import { Component, input } from '@angular/core';

export type AdSlotVariant = 'sidebar' | 'banner' | 'inline' | 'footer';

/**
 * Reserved advertising surface. Renders a neutral placeholder for now — the
 * Google Ads unit drops in here later, so the slot keeps its final dimensions.
 */
@Component({
  selector: 'app-ad-slot',
  standalone: true,
  template: `
    <div class="ad-slot" [class]="'ad-slot--' + variant()">
      <span class="ad-slot__label">AD_PLACEHOLDER</span>
    </div>
  `,
  styleUrl: './ad-slot.component.scss',
})
export class AdSlotComponent {
  variant = input<AdSlotVariant>('inline');
}
