# WT Tactical MFD

A War Thunder companion tool that reads the game's localhost telemetry API
and displays a live tactical map with weapon overlays, AA threat envelopes,
and a virtual gamepad for controlling the game from a phone or second screen.

Built as a Firefox WebExtension (Manifest V3) for Steam Deck Desktop Mode.

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

### Weapon Overlays
- Weapon/missile FOV arc
- Real-physics bomb CCIP (gravity + drag trajectory simulation)
- Glide bomb standoff footprint with maneuvering basket
- Dynamic altitude/speed scaling
- 1,435-aircraft weapons database (community-sourced)

### Threat Assessment
- AA threat rings with CLEAR / CAUTION / DANGER zones
- Air-to-air check-six indicator (rear hemisphere threat bearing)
- Nearest-target and in-weapon-range readouts

### MFD Controls Page
A full-screen virtual gamepad styled as a green-phosphor CRT display with
bezel buttons. Three pages (FLIGHT / WEAPONS / RADAR) selectable from the
top edge, with functional gamepad buttons on the left and bottom edges.
Each button press is sent to the Steam Deck via `serve.py`'s virtual
gamepad — bind each one to a real action in War Thunder's Controls settings.

### Auto-Bind Controls
Instead of manually binding 20 buttons in War Thunder's UI:

1. Export your `controls.blk` from War Thunder
2. Drop it into the `controls/` folder inside this project
3. Press **BIND CONTROLS** in the sidebar
4. Import `controls/controls_bound.blk` back into War Thunder

The tool identifies its own virtual device in the file's device list
automatically — no manual offset or calibration step needed.

## File Structure

```
manifest.json          Extension manifest
background.js          Extension entry point (opens MFD popup)
mfd.html               Main UI
mfd.js                 All map/overlay/gamepad/MFD logic
mfd.css                All styling
weapons-config.js      Weapon profiles, AA range bands, air threat config
aircraft-weapons-db.json   1,435-aircraft weapon stats database
serve.py               Local server (telemetry proxy + virtual gamepad)
controls/              Drop your controls.blk here for auto-bind
update.sh              Sync helper for zip-based updates
```

## Layouts

- **Desktop**: persistent sidebar + map canvas (default)
- **Mobile**: off-canvas drawer (☰) + top toolbar — tap the layout
  toggle button (bottom-right) to switch. Remembered per device.

## Requirements

- Firefox (tested on Flatpak Firefox 155+ on Steam Deck)
- War Thunder running with localhost API enabled (default)
- Python 3 for `serve.py` (phone access + virtual gamepad)
- `python-evdev` for virtual gamepad (`pip install evdev`)

## Updating

```bash
git pull
```

Then Reload the extension in `about:debugging`. If using zip downloads,
extract and run `./update.sh` to sync into your install folder.

## Known Limitations

- AA range bands are generic per-category, not per-vehicle
- Team classification (enemy = red-dominant RGB) is convention-based
- No ground-relative altitude exists in WT's telemetry API
- Measuring tool has a ~5x scaling discrepancy on some maps (open issue)
- `BTN_MODE` on the virtual gamepad still opens the Steam overlay
