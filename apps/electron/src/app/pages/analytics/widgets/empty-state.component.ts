import { ChangeDetectionStrategy, Component, booleanAttribute, input } from '@angular/core';
import { IconComponent, IconName } from './icon.component';

/**
 * Honest empty state. Analytics never renders a placeholder or a zero in place
 * of data it does not have — it says what is missing and, where useful, why.
 *
 * Full-size states centre themselves in the available space; `inline` shrinks
 * the treatment for use inside a panel.
 */
@Component({
  selector: 'app-empty-state',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  template: `
    <div class="empty" [class.inline]="inline()">
      @if (icon(); as iconName) {
        <span class="empty-icon">
          <app-icon [name]="iconName" [size]="inline() ? 22 : 34" [strokeWidth]="1.5" />
        </span>
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
      :host {
        display: block;
        width: 100%;
      }

      .empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 12px;
        /* Fills the content area so the message sits optically centred. */
        min-height: min(52vh, 420px);
        padding: 40px 24px;
        text-align: center;
        color: var(--secondary-text);
      }

      .empty.inline {
        min-height: 0;
        gap: 7px;
        padding: 22px 14px;
      }

      .empty-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 68px;
        height: 68px;
        border-radius: 50%;
        background: var(--muted);
        border: 1px solid var(--border-color);
        color: var(--secondary-text);
      }

      .inline .empty-icon {
        width: 42px;
        height: 42px;
      }

      .empty-title {
        margin: 0;
        font-size: 17px;
        font-weight: 700;
        color: var(--primary-text);
      }

      .inline .empty-title {
        font-size: 13px;
      }

      .empty-hint {
        margin: 0;
        font-size: 13px;
        line-height: 1.6;
        max-width: 46ch;
        color: var(--secondary-text);
      }

      .inline .empty-hint {
        font-size: 11.5px;
        line-height: 1.5;
        max-width: 42ch;
      }
    `,
  ],
})
export class EmptyStateComponent {
  title = input.required<string>();
  hint = input<string>('');
  icon = input<IconName | null>(null);
  /** Transform so a bare `inline` attribute reads as true. */
  inline = input(false, { transform: booleanAttribute });
}
