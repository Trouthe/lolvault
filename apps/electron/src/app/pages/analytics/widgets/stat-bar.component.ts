import {
  ChangeDetectionStrategy,
  Component,
  booleanAttribute,
  computed,
  input,
} from '@angular/core';

/**
 * Horizontal magnitude bar with a label and value — used for damage rows,
 * role distribution and win-rate breakdowns.
 */
@Component({
  selector: 'app-stat-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="stat-bar" [class.mirrored]="mirrored()">
      <div class="stat-bar-head">
        <span class="stat-bar-label">{{ label() }}</span>
        <span class="stat-bar-value">{{ display() }}</span>
      </div>
      <div class="stat-bar-track">
        <div
          class="stat-bar-fill"
          [style.width.%]="percent()"
          [style.background]="color()"
        ></div>
      </div>
    </div>
  `,
  styles: [
    `
      .stat-bar {
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 0;
      }

      .stat-bar-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 8px;
      }

      .stat-bar-label {
        font-size: 11.5px;
        color: var(--secondary-text);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .stat-bar-value {
        font-size: 12px;
        font-weight: 700;
        color: var(--primary-text);
        font-variant-numeric: tabular-nums;
      }

      .stat-bar-track {
        height: 6px;
        border-radius: 999px;
        background: var(--muted);
        overflow: hidden;
      }

      .stat-bar-fill {
        height: 100%;
        border-radius: 999px;
        transition: width 0.25s ease;
      }

      .mirrored .stat-bar-track {
        display: flex;
        justify-content: flex-end;
      }
    `,
  ],
})
export class StatBarComponent {
  label = input.required<string>();
  value = input.required<number>();
  /** Value mapped to a full bar. */
  max = input.required<number>();
  /** Overrides the rendered value text (e.g. "16,444 (31%)"). */
  valueText = input<string>('');
  color = input<string>('var(--outline)');
  /** Fills from the right — used for the enemy side of comparisons. */
  mirrored = input(false, { transform: booleanAttribute });

  percent = computed(() => {
    const max = this.max();
    if (!max || max <= 0) return 0;
    return Math.max(0, Math.min(100, (this.value() / max) * 100));
  });

  display = computed(() => this.valueText() || this.value().toLocaleString());
}
