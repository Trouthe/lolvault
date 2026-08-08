import { ChangeDetectionStrategy, Component, booleanAttribute, input } from '@angular/core';

/**
 * Honest empty state. Analytics never renders a placeholder or a zero in place
 * of data it does not have — it says what is missing and, where useful, why.
 */
@Component({
  selector: 'app-empty-state',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="empty" [class.inline]="inline()">
      @if (icon()) {
        <span class="empty-icon" aria-hidden="true">{{ icon() }}</span>
      }
      <p class="empty-title">{{ title() }}</p>
      @if (hint()) {
        <p class="empty-hint">{{ hint() }}</p>
      }
      <ng-content />
    </div>
  `,
  styles: [
    `
      .empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 6px;
        padding: 28px 20px;
        text-align: center;
        color: var(--secondary-text);
      }

      .empty.inline {
        padding: 14px 12px;
      }

      .empty-icon {
        font-size: 20px;
        opacity: 0.55;
        line-height: 1;
      }

      .empty-title {
        margin: 0;
        font-size: 13px;
        font-weight: 600;
        color: var(--primary-text);
      }

      .empty-hint {
        margin: 0;
        font-size: 11.5px;
        line-height: 1.5;
        max-width: 42ch;
        color: var(--secondary-text);
      }
    `,
  ],
})
export class EmptyStateComponent {
  title = input.required<string>();
  hint = input<string>('');
  icon = input<string>('');
  /** Transform so a bare `inline` attribute reads as true. */
  inline = input(false, { transform: booleanAttribute });
}
