# LoLVault — Clean Dark-First UI

## North Star: "Functional Clarity"

Minimal, dark-native, and theme-aware. Inspired by modern developer tooling and gaming UIs. Low noise, high legibility, with expressive regional themes layered on top of a neutral base.

## Colors

All colors are defined as CSS custom properties and swap per theme variant.

### Default Dark

- **Background (`oklch(0.15 0 0)`):** Deep near-black base surface.
- **Muted (`oklch(0.24 0 0)`):** Subtle elevated surface for inputs and secondary areas.
- **Card (`oklch(0.175 0 0)`):** Slightly lifted card surface.
- **Border (`oklch(0.25 0 0)`):** Quiet separator, 1–2px.
- **Outline (`oklch(0.3 0 0)`):** Focus/hover ring for interactive elements.
- **Primary Text (`oklch(0.9 0 0)`):** Near-white, high contrast on dark.
- **Secondary Text (`oklch(0.6 0 0)`):** Dimmed for labels and metadata.
- **Danger (`#dc143c`):** Destructive actions and error states.

### Default Light

- **Background (`oklch(0.98 0 0)`):** Near-white, clean.
- **Muted (`oklch(0.93 0 0)`):** Off-white secondary surface.
- **Primary Text (`oklch(0.13 0 0)`):** Near-black for readability.
- **Danger Hover (`rgba(220, 20, 60, 0.08)`):** Subtle tint on destructive hover.

### Rank Colors

Each rank has a `bg` (translucent) and `text` token used for rank pills and badges:
Iron · Bronze · Silver · Gold · Platinum · Emerald · Diamond · Master · Grandmaster · Challenger

## Typography

- **Font:** Geist — geometric, modern, variable weight (100–900). Applied globally to all text elements.
- **Scale:** Use weight contrast rather than extreme size differences. Bold `font-weight: 700+` for headings, `500` for buttons, `400` for body.
- All text inherits `color: var(--primary-text)` and `font-family: 'Geist', sans-serif`.
- `margin: 0` reset on all text elements — spacing is handled by layout containers.

## Elevation

- No drop shadows.
- Depth is expressed through **background layering**: `--background` → `--card` → `--muted`.
- Borders (`1–2px solid var(--border-color)`) define component edges.
- Focus/active states use `--outline` as a border upgrade, not a glow.

## Components

### Buttons

- **`.btn`** — Solid fill, `border-radius: 10px`, `padding: 10px 16px`, `font-weight: 500`, no border.
  - `.btn-secondary`: `background: var(--muted)`, hover darkens to `var(--border-color)`.
- **`.btn-icon-outlined`** — Transparent fill, `2px solid var(--border-color)`, `border-radius: 10px`, gap for icon + label. Hover fills with `var(--border-color)`.
- **`.action-btn`** — 36×36px icon-only button, transparent, `border-radius: 8px`.
  - `.launch-btn`: double width, `background: var(--muted)`.
  - `.delete-btn`: hover tints with `var(--danger-hover)`.
- Transitions: `0.2–0.3s ease` on `background-color`.

### Cards

- `background: var(--card)`, `border: 1px solid var(--border-color)`.
- `border-radius: 12px`. Content-dense, no decorative padding bloat.

### Inputs / Selects

- `background: var(--card)`, `border: 1px solid var(--border-color)`, `border-radius: 8px`.
- Custom select hides native arrow; injects CSS triangle via `::after`.
- Focus: border upgrades to `var(--outline)`, no box-shadow outline.

## Theming

The app uses a `[data-theme][data-theme-variant]` attribute system. Each combination defines its own set of CSS custom properties. Available variants:
`default` · `lol-classic` · `ionia` · `targon` · `shurima` · `bilgewater` · `shadow-isles` · `freljord` · `noxus` · `demacia`

## Rules

- Dark mode is the primary experience. Light mode mirrors the same token structure.
- Never use gradients on surfaces or decorative shadows.
- All interactive state changes are communicated through `background-color` or `border-color` transitions only.
- oklch is the color format for all base tokens — it ensures perceptually uniform lightness steps.
- Keep spacing and sizing consistent: multiples of 4px (4, 8, 10, 12, 16, 24, 36).
