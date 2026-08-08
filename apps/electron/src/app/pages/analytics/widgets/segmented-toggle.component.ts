import {
  ChangeDetectionStrategy,
  Component,
  booleanAttribute,
  input,
  output,
} from '@angular/core';

export interface SegmentOption<T = string> {
  value: T;
  label: string;
  /** Optional count/badge rendered after the label (e.g. game count). */
  badge?: string | number;
  disabled?: boolean;
}

/**
 * Pill-style segmented control used throughout analytics — queue filters,
 * with/against, damage type, dealt/taken.
 */
@Component({
  selector: 'app-segmented-toggle',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="segmented" [class.compact]="compact()" role="tablist" [attr.aria-label]="label()">
      @for (opt of options(); track opt.value) {
        <button
          type="button"
          role="tab"
          class="segment"
          [class.active]="opt.value === value()"
          [disabled]="opt.disabled"
          [attr.aria-selected]="opt.value === value()"
          (click)="select(opt)"
        >
          <span class="segment-label">{{ opt.label }}</span>
          @if (opt.badge !== undefined && opt.badge !== null) {
            <span class="segment-badge">{{ opt.badge }}</span>
          }
        </button>
      }
    </div>
  `,
  styles: [
    `
      .segmented {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        padding: 3px;
        border-radius: 10px;
        background: var(--muted);
        border: 1px solid var(--border-color);
        flex-wrap: wrap;
      }

      .segment {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 12px;
        border: none;
        border-radius: 7px;
        background: transparent;
        color: var(--secondary-text);
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        transition:
          background 0.15s ease,
          color 0.15s ease;
        white-space: nowrap;
      }

      .segment:hover:not(:disabled):not(.active) {
        background: color-mix(in oklch, var(--card) 70%, transparent);
        color: var(--primary-text);
      }

      .segment.active {
        background: var(--card);
        color: var(--primary-text);
        box-shadow: 0 1px 3px rgb(0 0 0 / 18%);
      }

      .segment:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }

      .segment-badge {
        font-size: 10px;
        font-weight: 700;
        padding: 1px 6px;
        border-radius: 999px;
        background: var(--muted);
        color: var(--secondary-text);
      }

      .segment.active .segment-badge {
        background: var(--outline);
        color: var(--primary-text);
      }

      .compact .segment {
        padding: 4px 9px;
        font-size: 11px;
      }
    `,
  ],
})
export class SegmentedToggleComponent<T = string> {
  options = input.required<SegmentOption<T>[]>();
  value = input.required<T>();
  label = input<string>('');
  /** Transform so a bare `compact` attribute reads as true. */
  compact = input(false, { transform: booleanAttribute });

  valueChange = output<T>();

  select(opt: SegmentOption<T>): void {
    if (opt.disabled || opt.value === this.value()) return;
    this.valueChange.emit(opt.value);
  }
}
