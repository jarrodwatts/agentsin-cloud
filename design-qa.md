# E1.1 Focus Canvas Design QA

## Evidence

- Source visual truth path: `/var/folders/f_/85gw8w354kg5vlcsn0ljjzz80000gn/T/codex-clipboard-6d8ed1d9-3a70-46af-8cd5-476d282f9285.png`
- Final implementation screenshot path: `/private/tmp/agentsin-cloud-e11-final4-1440x1024.jpg`
- Compact implementation screenshot path: `/private/tmp/agentsin-cloud-e11-final4-compact-900x760.jpg`
- Earlier comparison screenshots:
  - `/private/tmp/agentsin-cloud-e11-prefixed-1440x1024.jpg`
  - `/private/tmp/agentsin-cloud-e11-corrected-1440x1024.jpg`
  - `/private/tmp/agentsin-cloud-e11-final3-1440x1024.jpg`
  - `/private/tmp/agentsin-cloud-e11-final3-compact-900x760.jpg`
- Browser-rendered route: active development-only cloud-thread fixture in the in-app Browser.
- Viewports: `1440 × 1024` CSS px for the canonical layout and `900 × 760` CSS px for the compact layout.
- Pixel dimensions and density normalization:
  - Source: `3018 × 1768` pixels; source capture density is unknown.
  - Canonical implementation: `1440 × 1024` pixels at a `1440 × 1024` CSS viewport (1 screenshot pixel per CSS pixel).
  - Compact implementation: `900 × 760` pixels at a `900 × 760` CSS viewport (1 screenshot pixel per CSS pixel).
  - The source and implementation have different full-window aspect ratios, so comparison used normalized region proportions and product-state intent rather than false pixel-for-pixel alignment.
- State: dark theme; active cloud coding thread; E2B running; Codex working; verified checkpoint present; canonical Desktop inspector open; agent owns desktop control; composer ready; `0.18 USDC · Monad` visible. The compact evidence intentionally starts with Desktop collapsed.

## Full-view comparison evidence

The source and final implementation were opened together in the same visual comparison input at original detail. The final implementation preserves the source's essential hierarchy: a quiet repository sidebar, dominant agent timeline, fixed live-desktop inspector, compact bottom composer, branch/cloud context, and dark graphite treatment. The implementation intentionally expresses Agents in Cloud's product model through structured E2B lifecycle events, file-change totals, a verified checkpoint, exact USDC usage, and an explicit desktop-controller state instead of copying Cursor-specific controls or task content.

The canonical layout measures approximately 236 px for the sidebar and 480 px for the inspector, leaving the center as the primary work surface. At `900 × 760`, the inspector collapses before the sidebar and the center timeline/composer remain usable. Opening the compact inspector uses the dedicated panel surface rather than colliding with the composer.

## Focused region comparison evidence

Separate crops were not required because the original-detail canonical comparison kept the three important regions legible:

- Sidebar: Agents in Cloud branding, project/thread grouping, selected-thread treatment, and quiet secondary controls were visually inspected.
- Timeline: task prompt, Codex/E2B state, four ordered progress events, two-file diff summary, and verified checkpoint were visually inspected and confirmed through the browser accessibility tree.
- Inspector: Desktop header, live indicator, agent-control pill, Take Control action, and filled reference desktop frame were visually inspected. Take Control and Release Control were exercised in the rendered app.

## Required fidelity surfaces

- Fonts and typography: SF/system typography and monospace file/commit labels preserve the reference's compact hierarchy. Weights, line heights, wrapping, and truncation remain readable at both tested widths.
- Spacing and layout rhythm: the three-column proportions, hairline dividers, card padding, radii, and vertical grouping match the selected focus-canvas direction. Compact behavior collapses the inspector first and retains the sidebar.
- Colors and visual tokens: graphite surfaces, restrained borders, muted text, emerald healthy state, and violet action/checkpoint accents are coherent with the liquid-glass product direction and do not overpower the work surface.
- Image quality and asset fidelity: the supplied desktop raster remains sharp. It now fills the fixture's landscape desktop surface with a top-biased crop; production live frames continue to use non-cropping `object-contain` behavior.
- Copy and content: the focus-canvas product branding consistently says Agents in Cloud. A later source review found one SSH prompt and two release paths outside the captured fixture that still referenced upstream T3 surfaces; those are recorded and corrected below.
- Icons and controls: existing Lucide icons are consistently sized and aligned. Take Control, Release Control, panel toggle, and responsive panel behavior were exercised.
- Accessibility: semantic regions and controls expose useful names; the controller owner is always stated in text; keyboard-focus styling remains present; existing reduced-motion and reduced-transparency behavior is preserved.

## Primary interactions tested

- Opened the active cloud-thread fixture and confirmed the Desktop inspector appears only for the exact development fixture gate.
- Took exclusive desktop control and confirmed the UI changed to `You're controlling`, `Release Control`, and the agent-input-paused explanation.
- Released control and confirmed ownership returned to `Agent controlling` with `Take Control` restored.
- Removed the fixture query and confirmed neither the development timeline nor Desktop inspector leaked into the ordinary thread.
- Resized from `1440 × 1024` to `900 × 760` and confirmed the inspector collapsed before the sidebar.
- Opened the inspector in compact mode and confirmed it used the intended panel surface without accidental composer overlap.

## Console errors checked

The browser/dev-server stream was restarted after the final source change, then checked during fresh fixture navigation, responsive resizing, cleanup, and control transfer. The completed fixture emitted no runtime error. An earlier development-only hot reload that changed a hook signature produced React's transient hook-order reset warning; a full reload and the fresh-server verification cleared it. One pre-existing LegendList performance warning about explicitly setting `recycleItems` was observed; it does not affect this slice's function or visual result.

## Comparison history

### Pass 1 — blocked

- Earlier evidence: `/private/tmp/agentsin-cloud-e11-prefixed-1440x1024.jpg`
- Findings:
  - [P1] Prominent T3 Code branding remained in the application shell and desktop packaging.
  - [P1] The rendered state used a light appearance while the selected reference was dark.
  - [P1] The center canvas was sparse and showed provider authentication failure instead of a credible active cloud-agent timeline.
  - [P2] The portrait desktop fixture was heavily letterboxed inside the landscape inspector surface.
- Fixes:
  - Rebranded user-facing shell, window, DMG, and artifact surfaces while preserving technical compatibility identifiers and T3 attribution.
  - Selected the product's dark Agents in Cloud appearance for the comparison state.
  - Added a deterministic development/test-only focus canvas backed by the fixture's canonical cloud events.
  - Added fixture-only crop behavior while preserving production live-frame fitting.

### Pass 2 — blocked

- Earlier evidence: `/private/tmp/agentsin-cloud-e11-corrected-1440x1024.jpg`
- Findings:
  - [P1] Branding and dark appearance were corrected, but the center still displayed an expired-auth error and excessive empty space.
  - [P2] The desktop image remained too small inside its landscape surface.
- Fixes:
  - Replaced unrelated persisted messages only under the exact development fixture gate with a realistic prompt, agent summary, ordered progress events, file-change review, and checkpoint.
  - Filled the fixture desktop surface with a sensible top-focused crop.

### Pass 3 — blocked

- Earlier evidence: `/private/tmp/agentsin-cloud-e11-final3-1440x1024.jpg` and `/private/tmp/agentsin-cloud-e11-final3-compact-900x760.jpg`
- Findings:
  - [P1] The selected fixture still mixed persisted repository, branch, and provider identity into the deterministic cloud state, weakening the screenshot's product story.
  - [P1] A few release-facing labels still used the old product identity.
  - [P2] The compact header's secondary provider pill overlapped the window controls.
  - [P2] Entering the fixture on a compact viewport automatically opened Desktop as a sheet instead of collapsing the inspector first.
- Fixes:
  - Made the fixture's sidebar row, header, branch, provider, and cloud state deterministic without changing ordinary persisted threads.
  - Completed the user-facing release and artifact-name audit while retaining technical compatibility identifiers and T3 attribution.
  - Hid the secondary identity pill below the wide-desktop breakpoint.
  - Reused the existing compact-right-panel media contract so wide fixture entry opens Desktop and compact entry keeps the focus canvas visible; manual compact opening and exact state restoration remain supported.

### Pass 4 — visual comparison passed; source review remained open

- Post-fix evidence: `/private/tmp/agentsin-cloud-e11-final4-1440x1024.jpg` and `/private/tmp/agentsin-cloud-e11-final4-compact-900x760.jpg`
- The source and final canonical implementation were compared together in the same visual input.
- No actionable P0, P1, or P2 difference remains. The shorter deterministic task naturally leaves more vertical breathing room than the long Cursor transcript; this is acceptable product-content variance, not a layout defect.

### Pass 5 — blocked by final source review

- Findings outside the captured focus-canvas state:
  - [P1] The mandatory AUR job still fetched `pingdotgg/t3code` releases and expected `T3-Code-*` AppImages after desktop artifacts had moved to `Agents-in-Cloud-*`.
  - [P1] Desktop update `Read more` links still opened upstream T3 release tags instead of the Agents in Cloud release that supplied the update.
  - [P2] The SSH password dialog mixed `T3 needs` with the Agents in Cloud storage disclaimer.
- Fixes:
  - Pointed the compatibility-named AUR packages and release script exclusively at `jarrodwatts/agentsin-cloud` and `Agents-in-Cloud-*` assets while retaining the `t3code` package, launcher, protocol, and install identifiers.
  - Pointed desktop release details and their toast coverage at the Agents in Cloud release tags.
  - Made the SSH prompt consistently identify Agents in Cloud.

### Pass 6 — source remediation verified without new visual evidence

- No new screenshot was captured because these fixes affect release automation, an external release link destination, and an SSH prompt outside the canonical focus-canvas state.
- Focused AUR/release, desktop update, web, desktop-build, typecheck, lint, format, and diff checks were rerun after the source changes.

## Findings

No actionable focus-canvas visual differences remain, and the final source-review blockers are corrected. The existing screenshots remain the visual evidence; Pass 6 does not claim a new browser comparison.

## Follow-up polish

- [P3] A future demo-data slice could add one more realistic tool result when a denser marketing screenshot is desired; the current fixture is intentionally concise and sufficient for functional visual regression.

## Implementation checklist

- [x] Agents in Cloud branding across user-visible shell and release surfaces.
- [x] Development/test-only deterministic active cloud thread.
- [x] 236 px / dominant center / 480 px canonical geometry.
- [x] Desktop ownership handoff and release exercised.
- [x] Compact inspector-first collapse verified.
- [x] Ordinary-thread state restoration verified.
- [x] Source and final screenshot compared together.
- [x] Browser console checked.

final result: visual comparison passed; final source-review blockers addressed
