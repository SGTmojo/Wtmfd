# WT Tactical MFD

A War Thunder companion tool that reads the game's localhost telemetry API
and displays a live tactical map with weapon overlays, AA threat envelopes,
and a virtual MFD gamepad for controlling the game from a phone or second screen.

Built as a Firefox WebExtension (Manifest V3), primarily for Steam Deck Desktop Mode.

## Quick Start

1. **Clone or download** this repo onto your Steam Deck (Desktop Mode).
   Put it somewhere Firefox's sandbox can see — `~/Downloads` works
   reliably with Flatpak Firefox.

2. **Load the extension**: Firefox → `about:debugging#/runtime/this-firefox`
   → Load Temporary Add-on → select `manifest.json`.

3. **Click the toolbar icon** to open the MFD in its own popup window.

4. **Get into a match** — the map appears automatically once War Thunder's
   telemetry API responds on `localhost:8111`.

### Phone / Remote Access

To use the MFD from a phone or tablet on the same WiFi:

```bash
python3 serve.py
```

This starts a local server that proxies War Thunder's telemetry and serves
the MFD page. Open the URL shown in the terminal on your phone's browser.

## Features

### Tactical Map
- Live pan/zoom map with your aircraft centered
- Enemy and friendly unit markers (classified by team color)
- Airfield markers with runway orientation
- Tactical grid overlay
- Measuring tool (right-click drag, or toggle to measure mode on touch)
- Per-map scale calibration (auto + manual)
- SPD / ALT / HDG live readout in the top toolbar

### Weapon Overlays
- Weapon/missile FOV arc
- Real-physics bomb CCIP (gravity + drag trajectory simulation)
- Glide bomb standoff footprint with maneuvering basket
- Dynamic altitude/speed scaling
- 1,435-aircraft weapons database (community-sourced)

### Threat Assessment
- AA threat rings with CLEAR / CAUTION / DANGER zones
- Air-to-air check-six SVG compass badge (top-right, heading-up, with threat blip)
- Nearest-target and in-weapon-range readouts floating over the map

### MFD Controls Page

A full-screen virtual MFD bezel with 20 real OSB caps in authentic avionics
numbering (1–5 top, 6–10 right, 11–15 bottom, 16–20 left). Four pages, paged
via the left (back) and right (forward) rockers in the bottom corners:

**FLIGHT** — Glass PFD: attitude ladder, IAS/ALT tapes, compass rose,
gear/flaps/VS readout. Left caps:

| Button | Action | BLK ID |
|--------|--------|--------|
| H1 | GEAR | `ID_GEAR` |
| H2 | FLAPS UP | `ID_FLAPS_UP` |
| H3 | FLAPS DOWN | `ID_FLAPS_DOWN` |
| H4 | COCKPIT LIGHT | `ID_PLANE_NIGHT_VISION` |
| H5 | NVG MODE | `ID_TOGGLE_NIGHT_VISION` |

**WEAPONS** — Aircraft name, store selector dropdown (synced with sidebar),
live ballistics readout. Left and right caps:

| Button | Action | BLK ID |
|--------|--------|--------|
| H6 | PERIODIC FLARES | `ID_TOGGLE_PERIODIC_FLARES` |
| H7 | SECONDARY WPN | `ID_SWITCH_SHOOTING_CYCLE_SECONDARY` |
| H8 | SEC RIPPLE QTY | `ID_RESIZE_SECONDARY_WEAPON_SERIES` |
| H9 | LASER DESIG | `ID_TOGGLE_LASER_DESIGNATOR` |
| H10 | DEACT TGT PT | `ID_UNLOCK_TARGETING_AT_POINT` |
| H11 | BALLISTIC CPU (RKT) | `ID_TOGGLE_ROCKETS_BALLISTIC_COMPUTER` |
| H12 | BALLISTIC CPU (GUN) | `ID_TOGGLE_CANNONS_BALLISTIC_COMPUTER` |

**RADAR** — Live B-scan (bearing × range, close at bottom). Left and right caps:

| Button | Action | BLK ID |
|--------|--------|--------|
| H13 | RADAR PWR | `ID_SENSOR_SWITCH` |
| H14 | RADAR RANGE | `ID_SENSOR_RANGE_SWITCH` |
| H15 | RADAR SCOPE | `ID_SENSOR_SCAN_PATTERN_SWITCH` |
| H16 | RADAR MODE | `ID_SENSOR_TYPE_SWITCH` |
| H17 | SEARCH MODE | `ID_SENSOR_MODE_SWITCH` |
| H18 | TGT CYCLE | `ID_SENSOR_TARGET_SWITCH` |
| H19 | TGT LOCK | `ID_SENSOR_TARGET_LOCK` |
| H20 | CUSTOM | *(user-assignable — double-click legend to rename)* |

**MAP** — The live tactical map with every overlay blitted in. The top OSB
row becomes real map controls (CENTER / ZOOM+ / ZOOM− / RULER / GRID) instead
of gamepad buttons.

The gear icon between the rockers opens the settings drawer. The four-corners
icon returns to the full-screen tactical map.

### Auto-Bind Controls

Instead of manually binding all 20 buttons in War Thunder's Controls menu:

1. Export your `controls.blk` from War Thunder
2. Drop it into the `controls/` folder inside this project
3. Press **BIND CONTROLS** in the settings drawer
4. Import `controls/controls_bound.blk` back into War Thunder

Default BLK target IDs for H1–H19 are pre-filled (see tables above). H20 is
intentionally left blank for you to assign. The tool auto-detects the virtual
device's button offset in the file every time — no manual calibration needed.

## File Structure

```
manifest.json              Extension manifest
background.js              Extension entry point (opens MFD popup)
mfd.html                   Main UI
mfd.js                     All map/overlay/gamepad/MFD logic
mfd.css                    All styling
weapons-config.js          Weapon profiles, AA range bands, air threat config
aircraft-weapons-db.json   1,435-aircraft weapon stats database
serve.py                   Local server (telemetry proxy + virtual gamepad)
controls/                  Drop your controls.blk here for auto-bind
update.sh                  Sync helper for zip-based updates
War_Thunder_BLK_Control_Names_Reference.txt   BLK action ID reference
```

## Layout

One unified layout at every screen size: a slim top toolbar (map controls +
SPD/ALT/HDG readout), the tactical map full-screen underneath, and a settings
drawer (gear icon, top right) that slides in as an overlay.

## Requirements

- Firefox (tested on Flatpak Firefox 155+ on Steam Deck)
- War Thunder running with localhost API enabled (default)
- Python 3 for `serve.py` (phone access + virtual gamepad)

**Linux (Steam Deck):** `python-evdev` for virtual gamepad
```bash
pip install evdev --break-system-packages
```

**Windows:** vJoy 2.1.9.1 — download from https://github.com/shauleiz/vJoy/releases
(use 2.1.9.1 specifically — 2.2.x has an expired code-signing cert that Windows 11 blocks).
After installing, open "Configure vJoy" from the Start menu and set device 1 to at least
20 buttons. No extra Python packages needed — `serve.py` talks to vJoy via `ctypes`.

## Updating

```bash
git pull
```

Then Reload the extension in `about:debugging`. If using zip downloads,
extract and run `./update.sh` to sync into your install folder.

## Known Limitations

- AA range bands are generic per-category, not per-vehicle
- Team classification (enemy = red-dominant RGB) is convention-based
- No ground-relative altitude in WT's telemetry API (rules out terrain-relative CCIP)
- Measuring tool has a ~5x scaling discrepancy on some maps (open issue)
- vJoy button offset on Windows (0-based vs 1-based) is unverified against a real export — if bindings are one button off after auto-bind, report it
