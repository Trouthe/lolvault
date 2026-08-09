import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RolePerformanceRow } from '../models/analytics.types';
import { ROLE_ORDER, roleIcon, roleLabel } from '../services/game-assets';
import { EmptyStateComponent } from './empty-state.component';

/**
 * Win rate per role with the official position icons and a share bar.
 *
 * Roles are listed in lane order (top → support) rather than by games so the
 * layout stays stable as the pool shifts; the most-played role is highlighted.
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
        @for (row of ordered(); track row.roleKey) {
          <div class="role" [class.primary]="row.roleKey === primaryRole()" [class.idle]="!row.games">
            <div class="role-icon-wrap">
              @if (iconFor(row.roleKey); as icon) {
                <img class="role-icon" [src]="icon" [alt]="row.role" />
              }
            </div>

            <div class="role-body">
              <div class="role-head">
                <span class="role-name">{{ row.role }}</span>
                <span class="role-games">{{ row.games }}G</span>
              </div>
              <div class="role-track" [title]="(row.share | number: '1.0-0') + '% of games'">
                <div
                  class="role-fill"
                  [class.positive]="row.winRate >= 50"
                  [style.width.%]="row.games ? row.winRate : 0"
                ></div>
              </div>
              <span class="role-kda">{{ row.kda | number: '1.2-2' }} KDA</span>
            </div>

            <span class="role-wr" [class.positive]="row.winRate >= 50" [class.none]="!row.games">
              {{ row.games ? (row.winRate | number: '1.0-0') + '%' : '—' }}
            </span>
          </div>
        }
      </div>
    }
  `,
  styles: [
    `
      .roles {
        display: flex;
        flex-direction: column;
        gap: 5px;
      }

      .role {
        display: grid;
        grid-template-columns: 26px minmax(0, 1fr) 40px;
        align-items: center;
        gap: 9px;
        padding: 6px 8px;
        border-radius: 9px;
        background: var(--card);
        border: 1px solid transparent;
      }

      .role.primary {
        border-color: var(--outline);
      }

      .role.idle {
        opacity: 0.45;
      }

      .role-icon-wrap {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 26px;
        height: 26px;
        border-radius: 7px;
        background: var(--muted);
      }

      .role-icon {
        width: 16px;
        height: 16px;
        object-fit: contain;
      }

      /* Position SVGs ship white; invert on light themes so they stay visible. */
      [data-theme='light'] .role-icon {
        filter: invert(1);
      }

      .role-body {
        display: flex;
        flex-direction: column;
        gap: 3px;
        min-width: 0;
      }

      .role-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 6px;
      }

      .role-name {
        font-size: 11.5px;
        font-weight: 600;
        color: var(--primary-text);
      }

      .role-games {
        font-size: 10px;
        color: var(--secondary-text);
        font-variant-numeric: tabular-nums;
      }

      .role-track {
        height: 5px;
        border-radius: 999px;
        background: var(--muted);
        overflow: hidden;
      }

      .role-fill {
        height: 100%;
        border-radius: 999px;
        background: var(--danger);
        transition: width 0.3s ease;
      }

      .role-fill.positive {
        background: #2f9e6f;
      }

      .role-kda {
        font-size: 9.5px;
        color: var(--secondary-text);
        font-variant-numeric: tabular-nums;
      }

      .role-wr {
        font-size: 13px;
        font-weight: 700;
        text-align: right;
        color: var(--danger);
        font-variant-numeric: tabular-nums;
      }

      .role-wr.positive {
        color: #2f9e6f;
      }

      .role-wr.none {
        color: var(--secondary-text);
        opacity: 0.6;
      }
    `,
  ],
})
export class RolePerformanceComponent {
  rows = input.required<RolePerformanceRow[]>();

  /** Most-played role, highlighted as the main lane. */
  readonly primaryRole = computed(
    () => [...this.rows()].sort((a, b) => b.games - a.games)[0]?.roleKey ?? ''
  );

  /** All five lanes in play order, with zero rows filled in for unplayed ones. */
  readonly ordered = computed<RolePerformanceRow[]>(() => {
    const byKey = new Map(this.rows().map((r) => [r.roleKey, r]));
    return ROLE_ORDER.map(
      (key) =>
        byKey.get(key) ?? {
          roleKey: key,
          role: roleLabel(key),
          games: 0,
          wins: 0,
          winRate: 0,
          kda: 0,
          share: 0,
        }
    );
  });

  iconFor(roleKey: string): string {
    return roleIcon(roleKey);
  }
}
