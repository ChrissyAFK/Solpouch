# Solpouch redesign

**DEADLINE: 2026-10-04 02:10 PDT** (loop started 01:10 PDT; stop and summarize once this has passed)

Branch `design/redesign`, worktree `stormhacks/2026/Solpouch-redesign`. Production runs from the
main checkout; never build or restart there. Verify here with `pnpm --filter @solpouch/web build`
and a `next start` on a spare port.

Rules for every item: don't change copy or functionality. Restyle markup and CSS; restructure
JSX only where the layout needs it, keeping every string, link, handler and test hook.

## Direction: "Fare gate"

**References.** Vancouver's Compass Card and the SkyTrain fare gate (tap, read the balance, the
gate opens or stays shut). Card rendering and spacing discipline from Mercury, Ramp and Stripe;
the readout grammar of a transit validator. Impeccable seed `0190c21b`, grounded candidate 5 of 7
(envelope system, receipt tape, banknote security print, tape measure, **fare card + gate**,
shelf labels, job-site tags).

**Thesis.** A pouch is a fare card: a physical-feeling card with a balance printed on it. Paying
is a tap at a gate. The gate reads the rules and either opens (green readout, amount, what's left)
or stays shut (red readout, which rule stopped it). It refuses the category default of a crypto
dark page with neon glow and a generic dashboard of grey cards.

**Own world.** Light, cool "platform" ground; ink-black type; pouches are full-bleed colored cards
with rounded 20px corners, a chip-like notch, the balance set large in tabular mono. One committed
brand field: deep transit violet, used in big flat regions (hero band, primary buttons, the
closing panel), never as glow. Readouts are black glass panels with mono digits. Hairline rules,
no drop-shadow soup: one soft card shadow, used only on cards that represent money.

**Story.** Visitor sees a card being tapped and the gate deciding, understands "limits are
enforced, not promised", and opens the dashboard.

**First viewport.** Left 6 cols: headline at display size, intro, primary CTA in violet, text link.
Right 6 cols: the hero sequence restyled as a validator: a fare card (the pouch) above a black
readout panel that plays the voice-to-receipt sequence. CTA above the fold at every width.

**Signature interaction.** The tap: on approval the card nudges down 6px and back (ease-out
200ms), the readout flips to the green "Approved" state with the remaining balance counting.
Denial: a short horizontal shake (reduced-motion: color change only).

**Finish.** Unreviewed and undocumented is unfinished; this build ends with the finish review,
the verdict, DESIGN.md, and every shipping raster carrying its provenance.

### Type

- **Hanken Grotesk** (variable, 400 to 800) for everything readable. Display set at 700 to 800
  with -0.035em tracking; body 400 at 1.55 line height. Humanist enough for older users, crisp
  enough for a fintech.
- **Geist Mono** for amounts, limits, readouts, codes. Always `font-variant-numeric: tabular-nums`.
- Scale (rem, 16px base, ratio about 1.25, display clamps):
  `--text-xs .8125` · `--text-sm .875` · `--text-base 1` · `--text-lg 1.125` · `--text-xl 1.375` ·
  `--text-2xl 1.75` · `--text-3xl 2.25` · `--text-4xl clamp(2.5rem, 5vw, 3.5rem)` ·
  `--text-display clamp(3rem, 7.2vw, 6.25rem)`. Floor: nothing under 13px.

### Color tokens

Light (default for app and landing):
`--canvas #F3F4F1` · `--surface #FFFFFF` · `--surface-raised #E9EBE6` · `--ink #0E1015` ·
`--ink-soft #2E323A` · `--muted #5B606B` · `--faint #6E737D` · `--line #DDE0DA` · `--line-strong #C5C9C1`
Brand: `--brand #4B2BEF` (transit violet) · `--brand-ink #FFFFFF` · `--brand-soft #ECE8FF` · `--brand-deep #2A178F`
Gate states: `--ok #0A7A4B` / `--ok-surface #E2F5EA` · `--warn #8A5300` / `--warn-surface #FBF0D9` ·
`--danger #B4233F` / `--danger-surface #FBE7EB`
Readout glass: `--readout #0B0D12` · `--readout-ink #E9FFF4` · `--readout-ok #3DF5A5` · `--readout-bad #FF6B85`
Pouch card fills (tone 0 to 3): violet `#4B2BEF`, mint `#13C27E`, amber `#F2A33A`, ink `#1B1F2A`.

Dark (app preference and auto): `--canvas #0B0D12` · `--surface #12151C` · `--surface-raised #1A1E27` ·
`--ink #F2F3F5` · `--muted #9AA0AD` · `--line #252A35` · `--brand #7B63FF` · state colors lifted for contrast.

### Spacing and layout

4px base: `--space-1 4` · `2 8` · `3 12` · `4 16` · `5 24` · `6 32` · `7 48` · `8 64` · `9 96` · `10 128`.
Container 1200px max, 24px gutters (16px under 600px). 12-column grid on landing. Section rhythm:
96px between landing sections on desktop, 64px on mobile; more space above a heading than below.
Radii: `--r-sm 8` (inputs, chips) · `--r-md 12` (buttons, panels) · `--r-lg 16` (cards; craft floor caps card radii at 16) · pill 999.

### Motion

- Easing: `--ease-out cubic-bezier(.23,1,.32,1)`, `--ease-in-out cubic-bezier(.77,0,.175,1)`.
- Durations: press 140ms, hover/color 160ms, panels 220ms, the tap 200ms. Nothing over 300ms in UI;
  the hero sequence may be longer because it explains.
- Buttons `scale(.97)` on `:active`. Hover effects only under `(hover: hover) and (pointer: fine)`.
- Only transform and opacity animate. `prefers-reduced-motion` and `[data-motion="reduced"]`
  remove movement and keep color changes.

## Checklist (in order)

- [x] 1. Foundations: fonts (Hanken Grotesk, Geist Mono), tokens, type scale, base buttons, inputs, focus, motion tokens in `globals.css` + `layout.tsx`
- [x] 2. Landing nav + hero (validator hero: fare card + readout restyle of HeroSequence)
- [x] 3. Landing "A pouch for every budget" as fare cards
- [x] 4. Landing how it works, boundary, FAQ, closing panel
- [ ] 5. Footer (shared) and landing nav on mobile
- [ ] 6. App shell: sidebar, top bar, sign-in card, Ask Solpouch button
- [ ] 7. Info pages: About, Privacy, Terms, Contact, Delete account
- [ ] 8. Dashboard overview: stat tiles, spending card, pouch list as cards
- [ ] 9. Order page and receipt
- [ ] 10. Chat widget panel

## Log
- 01:17 Item 1: Hanken Grotesk + Geist Mono, light/dark fare-gate tokens with old names aliased, base buttons/inputs/cards/focus/motion tokens. Build passes; /dashboard and /about checked at 1440.
- 01:22 Item 2: landing now on the light palette; hero headline Hanken 800 at -0.035em, "limit." in brand violet, violet CTA with press scale, underlined text link; nav 72px with a bordered Sign in button; HeroSequence restyled as a validator (segmented tabs, black readout panel, mint voice bars, white receipt tape). Build passes; / checked at 1440 and 390.
- 01:25 Item 3: pouches rebuilt as fare cards (tinted card face per tone with a chip mark, pouch glyph and name on the face, purpose and mono rule table below, one soft money-card shadow); glyph tones moved to transit violet and mint. Build passes; / checked at 1440 and 390.
- 01:27 Item 4: how-it-works rail with gate-square stops (last one signal green); boundary as a black readout panel; FAQ toggles as bordered squares that rotate on open; closing as the violet brand field with mint second line and a white CTA. Build passes; / checked at 1440 and 390.
