import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DIVISION_ORDER, TIER_ORDER } from '../models/analytics.types';

interface Step {
  label: string;
  full: string;
  reached: boolean;
  current: boolean;
}

/**
 * Division progress within the current tier, ending at the next tier's entry —
 * e.g. P4 · P3 · **P2** · P1 · E4.
 *
 * Apex tiers (Master and above) have no divisions, so the stepper collapses to
 * a single marker rather than inventing steps that don't exist.
 */
@Component({
  selector: 'app-rank-stepper',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
  template: `
    @if (steps().length > 1) {
      <div class="stepper" role="img" [attr.aria-label]="ariaLabel()">
        <div class="track">
          <div class="track-fill" [style.width.%]="fillPercent()"></div>
        </div>
        <ol class="dots">
          @for (step of steps(); track step.full) {
            <li class="step" [class.reached]="step.reached" [class.current]="step.current">
              <span class="dot" [title]="step.full"></span>
              <span class="label">{{ step.label }}</span>
            </li>
          }
        </ol>
      </div>
    }
  `,
  styles: [
    `
      .stepper {
        position: relative;
        padding-top: 6px;
      }

      .track {
        position: absolute;
        top: 10px;
        left: 6px;
        right: 6px;
        height: 2px;
        border-radius: 999px;
        background: var(--muted);
        overflow: hidden;
      }

      .track-fill {
        height: 100%;
        border-radius: 999px;
        background: #2f9e6f;
        transition: width 0.3s ease;
      }

      .dots {
        position: relative;
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        justify-content: space-between;
      }

      .step {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 5px;
        min-width: 0;
      }

      .dot {
        width: 9px;
        height: 9px;
        border-radius: 50%;
        background: var(--muted);
        border: 2px solid var(--card);
        box-sizing: content-box;
      }

      .step.reached .dot {
        background: #2f9e6f;
      }

      .step.current .dot {
        background: var(--primary-text);
        transform: scale(1.18);
      }

      .label {
        font-size: 9px;
        font-weight: 600;
        color: var(--secondary-text);
        letter-spacing: 0.2px;
      }

      .step.current .label {
        color: var(--primary-text);
        font-weight: 700;
      }
    `,
  ],
})
export class RankStepperComponent {
  tier = input.required<string>();
  division = input.required<string>();

  private readonly info = computed(() => {
    const tier = (this.tier() || '').toUpperCase();
    const division = (this.division() || '').toUpperCase();
    const tierIndex = TIER_ORDER.indexOf(tier as (typeof TIER_ORDER)[number]);
    const divIndex = DIVISION_ORDER.indexOf(division as (typeof DIVISION_ORDER)[number]);
    return { tier, tierIndex, divIndex, apex: tierIndex >= TIER_ORDER.indexOf('MASTER') };
  });

  readonly steps = computed<Step[]>(() => {
    const { tier, tierIndex, divIndex, apex } = this.info();
    if (tierIndex < 0 || apex) return [];

    const initial = tier.charAt(0);
    const nextTier = TIER_ORDER[tierIndex + 1];
    const out: Step[] = DIVISION_ORDER.map((div, i) => ({
      label: `${initial}${4 - i}`,
      full: `${title(tier)} ${div}`,
      reached: i <= divIndex,
      current: i === divIndex,
    }));

    if (nextTier) {
      out.push({
        label: `${nextTier.charAt(0)}4`,
        full: `${title(nextTier)} IV`,
        reached: false,
        current: false,
      });
    }
    return out;
  });

  readonly fillPercent = computed(() => {
    const steps = this.steps();
    if (steps.length < 2) return 0;
    const currentIndex = steps.findIndex((s) => s.current);
    if (currentIndex < 0) return 0;
    return (currentIndex / (steps.length - 1)) * 100;
  });

  readonly ariaLabel = computed(() => {
    const current = this.steps().find((s) => s.current);
    return current ? `Current rank ${current.full}` : '';
  });
}

function title(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase();
}
