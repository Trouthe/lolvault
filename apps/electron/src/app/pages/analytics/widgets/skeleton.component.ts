import { ChangeDetectionStrategy, Component, booleanAttribute, input } from '@angular/core';

/**
 * A placeholder block shaped like the thing it stands in for.
 *
 * Shown while analytics loads instead of a spinner and the word "Loading":
 * the layout arrives first and fills in, so the page never jumps and there is
 * never a moment where a real empty state ("No games") is on screen claiming
 * something we do not actually know yet.
 */
@Component({
  selector: 'app-skeleton',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '',
  host: {
    '[style.width]': 'width()',
    '[style.height]': 'height()',
    '[style.borderRadius]': 'radius()',
    '[class.circle]': 'circle()',
    'aria-hidden': 'true',
  },
  styles: [
    `
      :host {
        display: block;
        flex-shrink: 0;
        background: linear-gradient(
          90deg,
          color-mix(in oklch, var(--primary-text) 6%, transparent) 25%,
          color-mix(in oklch, var(--primary-text) 12%, transparent) 37%,
          color-mix(in oklch, var(--primary-text) 6%, transparent) 63%
        );
        background-size: 400% 100%;
        animation: skeleton-sheen 1.4s ease-in-out infinite;
      }

      :host(.circle) {
        border-radius: 50%;
      }

      @keyframes skeleton-sheen {
        0% {
          background-position: 100% 50%;
        }
        100% {
          background-position: 0 50%;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        :host {
          animation: none;
        }
      }
    `,
  ],
})
export class SkeletonComponent {
  width = input<string>('100%');
  height = input<string>('14px');
  radius = input<string>('6px');
  /** `transform` so it reads as a bare attribute: `<app-skeleton circle />`. */
  circle = input(false, { transform: booleanAttribute });
}
