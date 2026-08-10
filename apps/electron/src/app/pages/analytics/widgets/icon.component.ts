import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import {
  ArrowLeft,
  CalendarDays,
  ChartColumn,
  ChartLine,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Crown,
  House,
  Inbox,
  Info,
  KeyRound,
  LucideAngularModule,
  LucideIconData,
  Map as MapIcon,
  Mountain,
  Search,
  Shield,
  Skull,
  Sparkles,
  Sword,
  Swords,
  TrendingDown,
  TriangleAlert,
  Trophy,
  Users,
  Zap,
} from 'lucide-angular';

/**
 * Every Lucide glyph used across analytics, registered once.
 *
 * Centralising the set keeps templates free of per-component icon imports and
 * means the whole feature draws from one visual family instead of a mix of
 * ASCII characters and emoji.
 */
const ICONS = {
  'alert-triangle': TriangleAlert,
  'arrow-left': ArrowLeft,
  'bar-chart': ChartColumn,
  'chart-line': ChartLine,
  calendar: CalendarDays,
  'chevron-down': ChevronDown,
  'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight,
  clock: Clock,
  crown: Crown,
  home: House,
  inbox: Inbox,
  info: Info,
  key: KeyRound,
  map: MapIcon,
  mountain: Mountain,
  search: Search,
  shield: Shield,
  skull: Skull,
  sparkles: Sparkles,
  sword: Sword,
  swords: Swords,
  'trending-down': TrendingDown,
  trophy: Trophy,
  users: Users,
  zap: Zap,
} satisfies Record<string, LucideIconData>;

export type IconName = keyof typeof ICONS;

@Component({
  selector: 'app-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule],
  template: `
    <lucide-icon
      [img]="icon()"
      [size]="size()"
      [strokeWidth]="strokeWidth()"
      [attr.aria-hidden]="label() ? null : 'true'"
      [attr.aria-label]="label() || null"
      [attr.role]="label() ? 'img' : null"
    />
  `,
  styles: [
    `
      :host {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: inherit;
        flex-shrink: 0;
      }

      lucide-icon {
        display: block;
        line-height: 0;
      }
    `,
  ],
})
export class IconComponent {
  name = input.required<IconName>();
  size = input<number>(16);
  strokeWidth = input<number>(2);
  /** Set only when the icon carries meaning on its own. */
  label = input<string>('');

  readonly icon = computed<LucideIconData>(() => ICONS[this.name()]);
}
