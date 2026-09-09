# WT Tactical MFD — Test & Calibration Plan

Two goals here: (1) confirm the recent fixes actually hold, and (2) collect
clean calibration data for the weapons we haven't tested yet, without
having to re-derive the process each time.

## Part 1 — Regression checks (do these once, quickly)

These confirm the last several fixes didn't break, and haven't silently
regressed.

- [ ] **Self-detection**: your own aircraft shows a single highlighted
      icon with a ring around it, centered correctly - not duplicated as
      a second generic NPC blip.
- [ ] **AA classification**: an enemy SPAA/SAM shows a filled, colored
      range ring with a label; a friendly one does NOT show a ring unless
      "Show Friendly AA Ranges" is checked.
- [ ] **Threat status**: the AA THREAT line transitions CLEAR → CAUTION →
      DANGER as you fly toward a known enemy AA site (rough check, no
      need to be precise about the exact distance it flips at yet).
- [ ] **Centering, at two different window sizes**: resize the browser
      window to a distinctly different aspect ratio (e.g. very wide vs.
      closer to square), then click "Center on Aircraft" at each size -
      your plane should land dead-center both times, not offset.
- [ ] **Measurement tool consistency (the important one)**: pick two
      fixed points on the map you can find again (e.g. two airfields).
      Measure the distance between them. Resize the browser window to a
      different aspect ratio and measure the same two points again - it
      should give the same distance both times. (Before the projection
      fix, this would have changed with window shape - this is the
      regression test for that bug specifically.)
- [ ] **Compact mode**: toggle it on, reload the extension, confirm it's
      still on (persistence), and that the drawer opens/closes via the ☰
      button.

If any of these fail, stop and report that first - it means something
regressed and recalibrating weapons on top of a broken foundation would
waste the effort.

## Part 2 — Calibration data collection

### What to record per test drop

Fly level (unless you're specifically testing a dive - see below), drop
or line up the in-game CCIP reticle on a point, and read straight off the
MFD's own panels - no manual unit conversion needed anymore:

| Field | Where to read it |
|---|---|
| Weapon | Whatever's selected in WEAPON PROFILE |
| Altitude | Release Alt (TRAJECTORY DEBUG panel) |
| Speed | VX0 (TRAJECTORY DEBUG panel) - already resolved to the right units, no IAS/TAS guessing needed |
| Vy at release | Vy (raw) (TRAJECTORY DEBUG panel) - should read close to 0 for a level test |
| Observed range | Right-click-drag from your position to the in-game CCIP point, read the measurement tool |

Report those five things and I can calibrate immediately.

### Unguided bombs (MK 82/83/84, FAB series, SC series, GP bombs) - one parameter (dragCoeff)

Two well-separated test points per weapon is enough:

1. **Low/slow**: ~1000-1500m altitude, ~400-500 km/h TAS
2. **High/fast**: ~4000-5000m altitude, ~800-900 km/h TAS

If both points solve to a similar `dragCoeff`, the model's holding across
the envelope and we're done for that weapon. If they solve to
meaningfully different values, that tells us a single constant isn't
enough for that weapon's real in-game curve, and we'll need to look at
that specifically (rather than silently trusting an average).

**Priority order** (based on what's likely in your normal loadouts -
adjust freely): MK 83, a second MK 84 point (only one so far), then
whichever of FAB-250/FAB-500/FAB-1500 or SC250/SC500 you actually fly.

### Glide bombs (GBU-39, GBU-8, GBU-12, Grom-2, KAB series, Paveway IV, AASM Hammer) - two parameters (dragCoeff AND glideRatio)

These are harder: one test point can only reliably pin down one of the
two unknowns. Plan:

1. Get **two** well-separated test points per glide weapon (same
   low/slow + high/fast idea as above).
2. Send me both - rather than solving them one at a time with the
   single-parameter console helpers, I'll fit `dragCoeff` and
   `glideRatio` together against both points at once (a small search
   over both, not just bisection on one). This avoids the trap of a
   single-parameter calibration masking the other parameter's error.

Don't calibrate these with only one data point - it's not enough
information to trust either resulting number.

### Dive releases (optional, but worth doing once)

After a weapon's level-flight calibration looks solid, one dive-release
test point (meaningfully diving, not just level) validates that the
vy-decomposition logic actually holds - Vy (raw) should be clearly
negative in the debug panel, and the observed range should come out
shorter than an equivalent-speed level release, roughly matching what the
model predicts. This isn't urgent - level-flight coverage is the
priority - but it's the one part of the model that hasn't been checked
against real data yet.

## What NOT to do

Don't trust weapon-stat tables from other sources (including from a
different conversation in this Project, if its knowledge base is stale) -
this project's whole point is that War Thunder's internal ballistics
aren't public, and every number that's actually held up so far came from
a real measured drop, not a reference table. If a number looks suspicious
before you've tested it, it's still just a placeholder.
