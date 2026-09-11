# WT Tactical MFD — Test & Calibration Plan

Two goals: (1) confirm existing features hold after changes, and (2) collect
clean calibration data for weapons that haven't been tested yet.

---

## Part 1 — Regression checks

Run these once after any significant update before doing anything else.

### Map view
- [ ] **Self-detection**: your own aircraft shows a single highlighted icon
      with a ring, centered correctly — not duplicated as a second NPC blip.
- [ ] **AA classification**: an enemy SPAA/SAM shows a filled range ring with
      label; a friendly one does NOT unless "Friendly AA" is checked in overlays.
- [ ] **Threat status**: AA THREAT transitions CLEAR → CAUTION → DANGER as
      you fly toward a known enemy AA site.
- [ ] **Check-six badge**: badge is visible top-right, rotates with heading.
      Badge border turns red when a threat is in the rear hemisphere within range.
- [ ] **Centering**: click CENTER in the toolbar at two different window sizes —
      your plane should land dead-center both times.
- [ ] **Toolbar readouts**: SPD / ALT / HDG update live in the top bar.

### MFD bezel
- [ ] **Page navigation**: left rocker steps back, right rocker steps forward
      through FLIGHT → WEAPONS → RADAR → MAP → back to FLIGHT.
- [ ] **FLIGHT page**: IAS, ALT, heading rose, gear/flaps/VS all update live.
      Attitude ladder tilts and pitches in the correct direction (roll right = 
      ladder tilts right; nose up = horizon line moves down).
- [ ] **WEAPONS page**: dropdown reflects the same weapon selected in the
      sidebar. Ballistics data (type, range, Cd) shows for the selected weapon.
- [ ] **RADAR page**: B-scan animates (sweep bar), nearby contacts plot at
      correct bearing. Close contacts appear near the bottom; distant ones near
      the top.
- [ ] **MAP page**: fills the full screen, live tactical map is visible with
      grid and any contacts. Top row buttons (CENTER / ZOOM+ / ZOOM− / RULER /
      GRID) function correctly.
- [ ] **Scaling**: resize the popup window and confirm the bezel, OSB caps,
      rockers, and labels all scale together — no fixed-size elements staying
      small while the rest grows.

### Auto-bind
- [ ] **Default IDs**: open AUTO-BIND CONTROLS in the settings drawer. H1–H19
      should show pre-filled BLK IDs matching the tables in README.md. H20
      should be blank.
- [ ] **Bind flow**: export a fresh controls.blk, drop it in `controls/`, press
      BIND CONTROLS, confirm a `controls_bound.blk` is produced and can be
      imported back into War Thunder without errors.

---

## Part 2 — Weapon calibration

### What to record per test drop

Fly level (unless specifically testing a dive). Line up the in-game CCIP
reticle on a point and read directly from the MFD's debug panels:

| Field | Where to read it |
|---|---|
| Weapon | Selected in WEAPON PROFILE (sidebar or WEAPONS page) |
| Altitude | Release Alt (DEBUG panel) |
| Speed | VX0 (DEBUG panel) |
| Vy at release | Vy (raw) (DEBUG panel) — should be near 0 for level |
| Observed range | Right-click-drag from position to in-game CCIP point |

Report those five fields and calibration can be done immediately.

### Unguided bombs — one parameter (dragCoeff)

Two test points per weapon at well-separated conditions:

1. **Low/slow**: ~1000–1500m altitude, ~400–500 km/h
2. **High/fast**: ~4000–5000m altitude, ~800–900 km/h

If both points produce a similar `dragCoeff`, the model holds and that weapon
is done. If they diverge significantly, a single constant isn't enough for that
weapon's in-game curve and needs further investigation.

Priority: MK 83, a second MK 84 point, then whichever FAB/SC series you fly.

### Glide bombs — two parameters (dragCoeff AND glideRatio)

One test point isn't enough to pin down both unknowns independently. Collect
two well-separated points (same low/slow + high/fast approach), then send both
together — they'll be fitted jointly rather than solved one at a time, which
avoids one parameter masking the other's error.

### Dive releases (optional)

After level-flight calibration is solid, one dive-release point validates the
Vy decomposition. Vy (raw) should be clearly negative in the debug panel and
the observed range should be shorter than an equivalent-speed level release.

---

## What NOT to do

Don't trust weapon stats from other sources or from a stale previous session —
War Thunder's internal ballistics aren't published and every number that's
actually held up came from a real measured drop, not a reference table.
