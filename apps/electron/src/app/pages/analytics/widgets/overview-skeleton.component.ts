import { ChangeDetectionStrategy, Component } from '@angular/core';
import { SkeletonComponent } from './skeleton.component';

/**
 * The overview screen's own shape, drawn as placeholders.
 *
 * Deliberately mirrors the real layout — five band panels, the heatmap, a run
 * of match rows — so the page does not reflow when the data lands.
 */
@Component({
  selector: 'app-overview-skeleton',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SkeletonComponent],
  template: `
    <section class="skeleton-overview" aria-busy="true" aria-label="Loading analytics">
      <div class="band">
        @for (panel of [1, 2, 3]; track panel) {
          <article class="panel short">
            <app-skeleton width="64px" height="10px" />
            <app-skeleton width="70%" height="30px" />
            <app-skeleton width="45%" height="11px" />
          </article>
        }

        @for (panel of [1, 2]; track panel) {
          <article class="panel tall">
            <app-skeleton width="80px" height="10px" />
            @for (row of [1, 2, 3, 4, 5]; track row) {
              <div class="row">
                <app-skeleton width="28px" height="28px" radius="8px" />
                <div class="row-body">
                  <app-skeleton width="60%" height="11px" />
                  <app-skeleton width="35%" height="9px" />
                </div>
                <app-skeleton width="34px" height="13px" />
              </div>
            }
          </article>
        }
      </div>

      <article class="panel">
        <app-skeleton width="70px" height="10px" />
        <app-skeleton height="96px" radius="8px" />
      </article>

      <div class="matches">
        <app-skeleton width="130px" height="15px" />
        @for (card of [1, 2, 3, 4, 5]; track card) {
          <app-skeleton height="76px" radius="10px" />
        }
      </div>
    </section>
  `,
  styles: [
    `
      .skeleton-overview {
        display: flex;
        flex-direction: column;
        gap: 14px;
      }

      .band {
        display: grid;
        grid-template-columns: repeat(6, minmax(0, 1fr));
        gap: 12px;
        align-items: stretch;
      }

      .band .short {
        grid-column: span 2;
      }

      .band .tall {
        grid-column: span 3;
      }

      @media (max-width: 1080px) {
        .band {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }

        .band .short:first-child {
          grid-column: span 2;
        }

        .band .short,
        .band .tall {
          grid-column: span 1;
        }
      }

      .panel {
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 13px 14px;
        border-radius: 12px;
        background: var(--card);
        border: 1px solid var(--border-color);
        min-width: 0;
      }

      .row {
        display: flex;
        align-items: center;
        gap: 9px;
      }

      .row-body {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 0;
      }

      .matches {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
    `,
  ],
})
export class OverviewSkeletonComponent {}
