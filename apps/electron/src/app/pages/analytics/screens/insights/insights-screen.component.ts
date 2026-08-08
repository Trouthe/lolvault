import { ChangeDetectionStrategy, Component } from '@angular/core';
import { EmptyStateComponent } from '../../widgets/empty-state.component';

/**
 * Deferred by design.
 *
 * The spec explicitly parks the deep-analytics screen for a later pass, so this
 * renders an honest description of what is coming rather than a stub route or
 * fake charts — the switcher stays complete without pretending to have data.
 */
@Component({
  selector: 'app-insights-screen',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [EmptyStateComponent],
  template: `
    <section class="insights">
      <header class="insights-head">
        <h2>Analytics</h2>
        <span class="badge">Coming next</span>
      </header>

      <app-empty-state
        icon="📊"
        title="Deep analytics is not built yet"
        hint="Overview and Champions are live and read real match data. This screen is reserved for
              longer-horizon trends — tilt and session analysis, time-of-day performance, rank
              trajectory and per-role progression."
      />
    </section>
  `,
  styles: [
    `
      .insights {
        display: flex;
        flex-direction: column;
        gap: 16px;
      }

      .insights-head {
        display: flex;
        align-items: center;
        gap: 10px;
      }

      h2 {
        margin: 0;
        font-size: 17px;
        font-weight: 700;
        color: var(--primary-text);
      }

      .badge {
        padding: 2px 9px;
        border-radius: 999px;
        background: var(--muted);
        border: 1px solid var(--border-color);
        color: var(--secondary-text);
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.4px;
        text-transform: uppercase;
      }
    `,
  ],
})
export class InsightsScreenComponent {}
