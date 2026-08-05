# Design System Master File

> **LOGIC:** When building a specific page, first check `design-system/pages/[page-name].md`.
> If that file exists, its rules **override** this Master file.
> If not, strictly follow the rules below.

---

**Project:** Personalized News Aggregator
**Generated:** 2026-08-04 (Phase 4.4 Track B, B1)
**Category:** Digital Newspaper (no exact `ui-ux-pro-max` product-type row exists for this niche — see Provenance below)

---

## Provenance — why this file isn't raw tool output

`ui-ux-pro-max-cli`'s flagship `--design-system` auto-generator blends a product-type match with style/color/typography search, but this project's product type ("digital newspaper mimicking print, page-flip navigation") has no close row in `products.csv` — the closest, "News/Media Platform," is tuned for streaming/media apps (recommends "Minimalism + Flat Design," no serif, no print anchor) and doesn't fit. Confirmed the auto-generator is unreliable here two ways: a tuned newspaper-keyword query still returned "Exaggerated Minimalism" + a pink accent (fashion/agency territory), and a neutral "test" query returned "Automotive/Car Dealership" — its relevance ranking needs a decent keyword match to mean anything, and none exists for this niche.

What's actually the tool's real value here: **direct domain searches** (`--domain style`, `--domain color`, `--domain typography`) surfaced two genuinely strong, independently-verified matches:
- **E-Ink / Paper** (`styles.csv`) — explicit "Best For: Reading apps, digital newspapers, minimal journals" — direct hit.
- **Editorial Grid / Magazine** (`styles.csv`) — explicit "Best For: News sites... journalism" and its own Key Effects field literally lists "page-flip transitions" — matches this project's `UI_DESIGN.md` brief independently.
- **News Editorial** typography pairing (`typography.csv`) — Newsreader/Roboto, "Best For: News sites... journalism."

`docs/(C) UI_DESIGN.md` explicitly requires **serif throughout — headlines and body**, which rules out News Editorial's sans body (Roboto). Adapted: kept Newsreader (grounded, purpose-built for news headlines) for display/headings, swapped in **Source Serif 4** for body — a serif explicitly noted "for body legibility" in the tool's "Minimalist Monochrome Editorial" pairing row, itself flagged "100% serif... NO UI sans-serif." Both fonts are tool-grounded rows; the pairing is a reasoned recombination to satisfy the brief's explicit constraint, not an invented font choice.

Color palette is synthesized from **E-Ink/Paper**'s literal paper/ink values (`#FDFBF7` / `#1A1A1A`, its own CSS variable names even match: `--paper-bg`, `--ink-color`) plus the **Museum/Gallery** color row's structure (`colors.csv`) — the closest DB row to "minimal color, accent = same hue as primary, no separate bright accent," matching `UI_DESIGN.md`'s explicit "minimal color... ink-on-paper feel." The one added accent (`#8B1E1E`, muted masthead red, used sparingly for rank badges / section rules) isn't a literal DB row — it's a real-newspaper convention (masthead rule color) applied consistently with the brief's "minimal color" instruction, not the tool's default bright pink/blue accents.

---

## Global Rules

### Color Palette (light-only — dark mode explicitly deferred per `UI_DESIGN.md`)

| Role | Hex | CSS Variable | Source |
|------|-----|--------------|--------|
| Background (paper) | `#FDFBF7` | `--color-background` | E-Ink/Paper |
| Foreground (ink) | `#1A1A1A` | `--color-foreground` | E-Ink/Paper |
| Card | `#FFFFFF` | `--color-card` | standard card-vs-page lift |
| Card Foreground | `#1A1A1A` | `--color-card-foreground` | E-Ink/Paper |
| Primary | `#1A1A1A` | `--color-primary` | E-Ink/Paper (ink black) |
| On Primary | `#FDFBF7` | `--color-on-primary` | — |
| Muted | `#F0EDE6` | `--color-muted` | warm paper-toned, adapted from E-Ink family |
| Muted Foreground | `#5C5C5C` | `--color-muted-foreground` | — |
| Border (subtle, cards) | `#E0E0E0` | `--color-border` | E-Ink/Paper |
| Rule line (section dividers) | `#1A1A1A` | `--color-rule` | Editorial Grid convention — thin (1px), full ink, not the soft card border |
| Accent (masthead red, sparing — rank badges, active nav) | `#8B1E1E` | `--color-accent` | reasoned addition, real-masthead convention |
| On Accent | `#FDFBF7` | `--color-on-accent` | — |
| Destructive | `#DC2626` | `--color-destructive` | standard, error states only — outside the editorial palette |
| Ring (focus) | `#1A1A1A` | `--color-ring` | E-Ink/Paper |

**Accessibility:** `#1A1A1A` on `#FDFBF7` and `#FFFFFF` both clear WCAG AAA for body text (E-Ink/Paper's own row rates AAA). `#8B1E1E` on `#FDFBF7` clears AA for the badge/rule use it's scoped to — don't use it for body text.

### Typography

- **Heading font:** Newsreader (400/500/600/700) — grounded in "News Editorial" pairing, purpose-built for news/editorial headlines.
- **Body font:** Source Serif 4 (300/400/600) — grounded in "Minimalist Monochrome Editorial" pairing's body row, explicit note "for body legibility."
- **No sans-serif anywhere** — per `UI_DESIGN.md`'s explicit "serif throughout" requirement. This is a deliberate deviation from the tool's default serif+sans pairing template.
- **Google Fonts import:**
  ```
  @import url('https://fonts.googleapis.com/css2?family=Newsreader:wght@400;500;600;700&family=Source+Serif+4:opsz,wght@8..60,300;8..60,400;8..60,600&display=swap');
  ```
- **Tailwind 4 `@theme` mapping** (CSS-first, no `tailwind.config.js` — see `TECH_STACK.md`). Uses shadcn's own `--font-sans`/`--font-heading` naming (not custom `--font-display`/`--font-body` names) so shadcn components/utilities that reference `font-sans` resolve to our body serif rather than a stray sans-serif:
  ```css
  @theme inline {
    --font-sans: var(--font-source-serif-4), serif;   /* body */
    --font-heading: var(--font-newsreader), serif;    /* headings */
  }
  ```

### Motion Philosophy (from E-Ink/Paper's own Effects & Animation field)

> "No motion blur, distinct page turns, grain/noise texture, sharp transitions (no fade)"

Directly informs Track B's animation steps (B6-B8): the page-flip (B8) should read as a **crisp, distinct turn**, not a soft crossfade or blurred zoom — reinforces the already-approved plan's explicit choice of a Motion-orchestrated multi-stage flip over Next 16's View Transitions (built for simple crossfades). No grain/noise texture is in scope for v1 (not requested in `UI_DESIGN.md`, flagged here only as a future polish option if the flat paper background ever feels too digital).

### Spacing Variables

| Token | Value | Usage |
|-------|-------|-------|
| `--space-xs` | `4px` / `0.25rem` | Tight gaps |
| `--space-sm` | `8px` / `0.5rem` | Icon gaps, inline spacing |
| `--space-md` | `16px` / `1rem` | Standard padding |
| `--space-lg` | `24px` / `1.5rem` | Section padding |
| `--space-xl` | `32px` / `2rem` | Large gaps |
| `--space-2xl` | `48px` / `3rem` | Section margins |
| `--space-3xl` | `64px` / `4rem` | Masthead / hero padding |

(Standard scale, not style-specific — carried from the tool's default since no newspaper-specific spacing row exists.)

### Shadow Depths — used sparingly

Real newsprint has no drop shadows. Reserve shadow use for interactive elevation only (the Sheet/Dialog overlay sidebar, the focus-mode overlay's backdrop) — not on cards, which should read as flat print, differentiated by the rule-line border and paper/card color contrast, not elevation.

| Level | Value | Usage |
|-------|-------|-------|
| `--shadow-sm` | `0 1px 2px rgba(26,26,26,0.06)` | Sources-flip card back face |
| `--shadow-md` | `0 4px 6px rgba(26,26,26,0.10)` | Sidebar sheet |
| `--shadow-lg` | `0 10px 24px rgba(26,26,26,0.16)` | Focus-mode overlay card |

---

## Component Notes (guidance, not prescriptive CSS — actual components are shadcn/ui primitives per `IMPLEMENTATION_PLAN_4.4.md` B3, restyled with these tokens)

- **Buttons:** `--color-primary` fill for primary actions (ink black on paper), `--color-accent` reserved for the rare emphasis action, not default buttons — matches "minimal color."
- **Cards (`NewsCard`):** flat, `--color-card` bg, `--color-border` hairline, no shadow at rest; rank/severity badge uses `--color-accent`.
- **Rule lines (section dividers, masthead underline):** `--color-rule`, 1px solid, full ink — distinct from `--color-border`'s softer card outline.
- **Focus states:** visible `--color-ring` outline everywhere, per the tool's own accessibility-first priority ranking (Accessibility + Touch/Interaction are CRITICAL priority ahead of Style/Typography/Animation).

---

## Anti-Patterns (do NOT use)

- Bright/saturated accent colors beyond the one restrained masthead red — this isn't a generic SaaS palette.
- Sans-serif fonts anywhere in reading UI (headlines, body, captions).
- Soft crossfades or blur on page transitions — E-Ink/Paper's own motion note explicitly calls for "sharp transitions (no fade)."
- Drop shadows on flat card surfaces at rest (reserve for genuine overlay elevation only).
- Emojis as icons — use `lucide-react` (Track B B4).
- Missing `cursor-pointer` on clickable elements; invisible focus states; instant (non-transitioned) state changes.

---

## Pre-Delivery Checklist

- [ ] No sans-serif anywhere in reading UI
- [ ] Accent red used only for badges/rules/rare emphasis, not as a base UI color
- [ ] Text contrast 4.5:1 minimum (ink-on-paper combos here clear AAA)
- [ ] Focus states visible for keyboard nav
- [ ] `prefers-reduced-motion` respected (page-flip, focus-mode zoom, Sources flip all need a reduced-motion fallback)
- [ ] No motion blur / soft fade on page transitions — sharp, distinct
- [ ] Responsive: desktop + tablet-landscape only in scope for v1 (mobile/portrait explicitly deferred per `UI_DESIGN.md`)
