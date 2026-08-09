/**
 * Paths to the official League art bundled under assets/game-images.
 *
 * Icons come from Riot's own match-history and champ-select clients (via
 * Community Dragon) rather than being redrawn, so objectives and roles look
 * exactly like they do in game. Objective art is team-coloured: `-100` is blue
 * side, `-200` is red side.
 */

const OBJ = 'assets/game-images/objectives';
const ROLE = 'assets/game-images/roles';
const STAT = 'assets/game-images/stats';

/**
 * Stat icons, taken from Riot's own clients via Community Dragon.
 *
 * `dealt`/`taken`/`kda`/`vision`/`minions` are the League post-game scoreboard
 * icons (rcp-fe-lol-postgame), recoloured to `currentColor` so they follow the
 * theme. Riot publishes no dedicated physical/magic/true damage art, so the
 * type split reuses the rune stat-shard icons for the resistance each type is
 * answered by — armour for physical, magic resist for magic, health for true
 * (which ignores both) and adaptive force for the combined total.
 */
export const STAT_ICONS = {
  dealt: `${STAT}/damage-dealt.svg`,
  taken: `${STAT}/damage-taken.svg`,
  kda: `${STAT}/kda.svg`,
  vision: `${STAT}/vision.svg`,
  minions: `${STAT}/minions.svg`,
  ccScore: `${STAT}/cc-score.svg`,
  total: `${STAT}/damage-total.png`,
  physical: `${STAT}/damage-physical.png`,
  magic: `${STAT}/damage-magic.png`,
  true: `${STAT}/damage-true.png`,
} as const;

export type TeamSide = 100 | 200;

/** Canonical role keys as they appear in `teamPosition`. */
export type RoleKey = 'TOP' | 'JUNGLE' | 'MIDDLE' | 'BOTTOM' | 'UTILITY';

const ROLE_ICONS: Record<RoleKey, string> = {
  TOP: `${ROLE}/position-top.svg`,
  JUNGLE: `${ROLE}/position-jungle.svg`,
  MIDDLE: `${ROLE}/position-middle.svg`,
  BOTTOM: `${ROLE}/position-bottom.svg`,
  UTILITY: `${ROLE}/position-utility.svg`,
};

export const ROLE_LABELS: Record<RoleKey, string> = {
  TOP: 'Top',
  JUNGLE: 'Jungle',
  MIDDLE: 'Mid',
  BOTTOM: 'Bot',
  UTILITY: 'Support',
};

export const ROLE_ORDER: RoleKey[] = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];

export function isRoleKey(value: string | null | undefined): value is RoleKey {
  return !!value && value in ROLE_ICONS;
}

export function roleIcon(role: string | null | undefined): string {
  return isRoleKey(role) ? ROLE_ICONS[role] : '';
}

export function roleLabel(role: string | null | undefined): string {
  return isRoleKey(role) ? ROLE_LABELS[role] : (role ?? '');
}

/**
 * Riot's `monsterSubType` for elemental drakes maps onto the elemental art
 * names used by the client. Hextech and Chemtech have no dedicated match-history
 * icon, so they fall back to the generic drake.
 */
const DRAGON_ART: Record<string, string> = {
  AIR_DRAGON: 'air',
  CLOUD_DRAGON: 'air',
  EARTH_DRAGON: 'earth',
  MOUNTAIN_DRAGON: 'earth',
  FIRE_DRAGON: 'fire',
  INFERNAL_DRAGON: 'fire',
  WATER_DRAGON: 'water',
  OCEAN_DRAGON: 'water',
  ELDER_DRAGON: 'elder',
};

export const DRAGON_LABELS: Record<string, string> = {
  AIR_DRAGON: 'Cloud Drake',
  CLOUD_DRAGON: 'Cloud Drake',
  EARTH_DRAGON: 'Mountain Drake',
  MOUNTAIN_DRAGON: 'Mountain Drake',
  FIRE_DRAGON: 'Infernal Drake',
  INFERNAL_DRAGON: 'Infernal Drake',
  WATER_DRAGON: 'Ocean Drake',
  OCEAN_DRAGON: 'Ocean Drake',
  HEXTECH_DRAGON: 'Hextech Drake',
  CHEMTECH_DRAGON: 'Chemtech Drake',
  ELDER_DRAGON: 'Elder Dragon',
};

/** Objective icon for a team side. `subType` selects the drake element. */
export function objectiveIcon(
  kind: 'baron' | 'dragon' | 'herald' | 'tower' | 'inhibitor',
  side: TeamSide,
  subType?: string | null
): string {
  if (kind === 'dragon') {
    const art = subType ? DRAGON_ART[subType.toUpperCase()] : null;
    return `${OBJ}/${art ?? 'dragon'}-${side}.png`;
  }
  return `${OBJ}/${kind}-${side}.png`;
}

export function dragonLabel(subType?: string | null): string {
  if (!subType) return 'Drake';
  return DRAGON_LABELS[subType.toUpperCase()] ?? 'Drake';
}

export const KILL_ICON = `${OBJ}/kills.png`;
export const DEATH_ICON_BLUE = `${OBJ}/dead_blue.png`;
export const DEATH_ICON_RED = `${OBJ}/dead_red.png`;
export const GOLD_ICON = `${OBJ}/icon_gold.png`;
export const MINION_ICON = `${OBJ}/icon_minions.png`;

/** Objective rows rendered in the match Overview tab, in narrative order. */
export const OBJECTIVE_ROWS: {
  key: string;
  kind: 'baron' | 'dragon' | 'herald' | 'tower' | 'inhibitor';
  label: string;
}[] = [
  { key: 'baron', kind: 'baron', label: 'Baron' },
  { key: 'dragon', kind: 'dragon', label: 'Dragon' },
  { key: 'riftHerald', kind: 'herald', label: 'Herald' },
  { key: 'tower', kind: 'tower', label: 'Towers' },
  { key: 'inhibitor', kind: 'inhibitor', label: 'Inhibitors' },
];
