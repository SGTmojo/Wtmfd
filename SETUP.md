# Setup Guide

## Steam Deck Installation

### Prerequisites
- Steam Deck in **Desktop Mode**
- Flatpak Firefox (pre-installed on most Deck setups)
- Python 3 (pre-installed on SteamOS)

### Step 1: Get the Files

**Option A — Git (recommended):**
```bash
cd ~/Downloads
git clone https://github.com/<your-username>/wt-tactical-mfd.git
```

**Option B — ZIP download:**
Download the latest release ZIP from GitHub, extract it into
`~/Downloads/wt-tactical-mfd/`.

> **Important:** The folder must be inside `~/Downloads` (or another location
> Firefox's Flatpak sandbox can access). A repo cloned directly into `~/` may
> not be visible to Firefox's file picker.

### Step 2: Load the Extension

1. Open Firefox
2. Go to `about:debugging#/runtime/this-firefox`
3. Click **Load Temporary Add-on**
4. Navigate to your folder and select `manifest.json`
5. The WT Tactical MFD icon appears in the toolbar

### Step 3: Start serve.py (phone access + virtual gamepad)

```bash
cd ~/Downloads/wt-tactical-mfd
python3 serve.py
```

If you see "Virtual gamepad: not available", install evdev:
```bash
pip install evdev --break-system-packages
```

### Step 4: Open the MFD

- **On the Deck**: click the toolbar icon — a popup window opens
- **On your phone**: open the URL shown in serve.py's terminal output
  (e.g. `http://192.168.x.x:8000/mfd.html`)

---

## Phone / Tablet Setup

1. Connect your device to the **same WiFi** as the Deck
2. Run `serve.py` on the Deck (see above)
3. Type the URL from the terminal into your phone's browser — no app needed

> **Tip:** If Chrome logs garbled errors in serve.py's output, that's just
> Chrome pre-checking HTTPS before falling back to HTTP. The page loads fine.
> Suppress it in Chrome → Settings → Privacy → "Always use secure connections" → Off.

---

## Auto-Bind Controls (Virtual Gamepad)

Binds all 20 MFD buttons to real War Thunder actions in bulk, without touching
them one-by-one in the game's Controls menu.

### Default bindings (pre-filled, no setup needed)

H1–H19 ship with default BLK action IDs matching the button labels on the MFD.
See the button tables in README.md for the full list. H20 is intentionally left
blank — assign it to whatever you want via the Target Action IDs panel.

### First-time setup

1. Start `serve.py` and get into a test flight in War Thunder
2. Press any button on the MFD's Controls page — this registers the virtual
   device so War Thunder sees it
3. In War Thunder's Controls menu, press **Export** and save the file into the
   `controls/` folder inside this project
4. In the MFD's settings drawer, expand **AUTO-BIND CONTROLS**
5. Verify or edit the Target Action IDs if needed (defaults are pre-filled)
6. Click **BIND CONTROLS**
7. Import `controls/controls_bound.blk` back into War Thunder

### After a restart

The virtual device may get a different button offset after restarting `serve.py`
or War Thunder. Re-export your `controls.blk` into the `controls/` folder and
press **BIND CONTROLS** again — the offset is re-detected automatically.

### Custom button H20

H20 has no default binding. To assign it:
1. Double-click the H20 legend on the RADAR page to rename it
2. In the settings drawer, set its Target Action ID to any BLK identifier
   (refer to `War_Thunder_BLK_Control_Names_Reference.txt` for the full list)
3. Click **SAVE IDs**, then **BIND CONTROLS**

---

## Windows

`serve.py` supports Windows via vJoy 2.1.9.1.

1. Download vJoy 2.1.9.1 from https://github.com/shauleiz/vJoy/releases
   (use 2.1.9.1 specifically — 2.2.x has an expired code-signing cert that Windows 11 blocks at the driver level)
2. Install it and open **Configure vJoy** from the Start menu
3. Set device 1 to at least 20 buttons, click Apply
4. Run `python serve.py` — it will report `ready (Windows/vJoy, device 1, buttons 1-20)`
5. Follow the normal auto-bind flow from there

No extra Python packages needed — `serve.py` loads the vJoy DLL directly via `ctypes`.

> **Note:** The auto-bind tool looks for vJoy in the exported `.blk` by matching
> known vJoy device name patterns. If it reports "device not found", make sure
> you pressed at least one MFD button while `serve.py` was running before exporting
> your controls from War Thunder — this is what causes vJoy to appear in the file's
> device list.

---

## Updating

**Git:**
```bash
cd ~/Downloads/wt-tactical-mfd
git pull
```

**ZIP:** Extract the new zip, then run:
```bash
./update.sh
```

Then go to `about:debugging` and click **Reload** on the extension.

> **Important when updating from a zip:** always delete the old folder and
> re-extract fresh rather than overwriting files in place. Firefox caches the
> extension's manifest version — if the version number hasn't visibly changed
> in `about:debugging`, the extension is still running old code.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Blank white popup | Reload the extension in `about:debugging` |
| Map shows "WAITING FOR WAR THUNDER" | Start a match — the API only responds in-game |
| Phone can't connect | Check same WiFi; use the exact URL from serve.py output |
| Virtual gamepad not available (Linux) | Install `evdev` (see Step 3); check `/dev/uinput` permissions |
| Virtual gamepad not available (Windows) | Install vJoy 2.1.9.1, configure device 1 with 20+ buttons (see Windows section above) |
| Buttons not doing anything in-game | Run the auto-bind first, or bind manually in WT's Controls settings |
| "No .blk in controls/ folder" | Export from WT's Controls menu into the `controls/` subfolder |
| Extension looks outdated after update | Delete the old folder, re-extract, remove the extension in `about:debugging` and re-add it |
