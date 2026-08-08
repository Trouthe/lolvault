import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RolePerformanceRow } from '../models/analytics.types';
import { EmptyStateComponent } from './empty-state.component';

/**
 * Win rate and KDA per role, with a share bar showing how the champion pool is
 * distributed. Sits in the top band rather than the rail — it reads as a
 * comparison across roles, which needs horizontal room.
 */
@Component({
  selector: 'app-role-performance',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, EmptyStateComponent],
  template: `
    @if (rows().length === 0) {
      <app-empty-state
        inline
        title="No role data"
        hint="Roles come from the match record; older cached games may not include them."
      />
    } @else {
      <div class="roles">
        @for (row of rows(); track row.role) {
          <div class="role" [class.primary]="row.role === primaryRole()">
            <div class="role-head">
              <span class="role-name">{{ row.role }}</span>
              <span class="role-games">{{ row.games }}G</span>
            </div>

            <div class="role-wr" [class.positive]="row.winRate >= 50">
              {{ row.winRate | number: '1.0-0' }}%
            </div>

            <div class="role-bar" [title]="(row.share | number: '1.0-0') + '% of games'">
              <div class="role-bar-fill" [style.width.%]="row.share"></div>
            </div>

            <div class="role-kda">{{ row.kda | number: '1.2-2' }} KDA</div>
          </div>
        }
      </div>
    }
  `,
  styles: [
    `
      .roles {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(104px, 1fr));
        gap: 8px;
      }

      .role {
        display: flex;
        flex-direction: column;
        gap: 5px;
        padding: 10px;
        border-radius: 10px;
        background: var(--card);
        border: 1px solid var(--border-color);
      }

      .role.primary {
        border-color: var(--outline);
      }

      .role-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 6px;
      }

      .role-name {
        font-size: 11px;
        font-weight: 700;
        color: var(--primary-text);
      }

      .role-games {
        font-size: 10px;
        color: var(--secondary-text);
        font-variant-numeric: tabular-nums;
      }

      .role-wr {
        font-size: 18px;
        font-weight: 700;
        line-height: 1.1;
        color: var(--danger);
        font-variant-numeric: tabular-nums;
      }

      .role-wr.positive {
        color: #2f9e6f;
      }

      .role-bar {
        height: 4px;
        border-radius: 999px;
        background: var(--muted);
        overflow: hidden;
      }

      .role-bar-fill {
        height: 100%;
        border-radius: 999px;
        background: var(--outline);
      }

      .role-kda {
        font-size: 10.5px;
        color: var(--secondary-text);
        font-variant-numeric: tabular-nums;
      }
    `,
  ],
})
export class RolePerformanceComponent {
  rows = input.required<RolePerformanceRow[]>();

  /** Most-played role, highlighted as the main lane. */
  readonly primaryRole = computed(() => this.rows()[0]?.role ?? '');
}
