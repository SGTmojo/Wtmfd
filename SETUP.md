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

> **Important:** The folder must be inside `~/Downloads` (or another
> location Firefox's Flatpak sandbox can access). A repo cloned into
> `~/` directly may not be visible to Firefox's file picker.

### Step 2: Load the Extension

1. Open Firefox
2. Go to `about:debugging#/runtime/this-firefox`
3. Click **Load Temporary Add-on**
4. Navigate to your folder and select `manifest.json`
5. The WT Tactical MFD icon appears in the toolbar

### Step 3: Start serve.py (for phone access / virtual gamepad)

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

## Phone Setup

1. Connect your phone to the **same WiFi** as the Deck
2. Run `serve.py` on the Deck (see above)
3. Type the URL from the terminal into your phone's browser
4. Tap the **layout toggle** button (bottom-right) to switch to Mobile mode
5. The sidebar becomes a slide-out drawer (☰ button)

> **Tip:** If Chrome shows garbled errors in serve.py's log, that's just
> Chrome trying HTTPS first before falling back to HTTP. The page still
> loads fine. You can suppress this in Chrome → Settings → Privacy →
> "Always use secure connections" → Off.

## Auto-Bind Controls (Virtual Gamepad)

This lets you bind the MFD's 20 virtual buttons to real War Thunder
actions without doing it one-by-one in the game's Controls menu.

### First Time Setup

1. Start `serve.py` and get into a test flight
2. Press any button on the MFD Controls page (this makes War Thunder
   register the virtual device)
3. In War Thunder's Controls settings, press **Export** — save the file
   into the `controls/` folder inside this project
4. In the MFD sidebar, expand **AUTO-BIND CONTROLS**
5. Fill in the Target Action IDs for each button you want bound
   (e.g. H1 → `ID_GEAR`, H2 → `ID_FLAPS` — find the real IDs by
   searching your exported `.blk` file in a text editor)
6. Click **SAVE IDs**, then **BIND CONTROLS**
7. Import `controls/controls_bound.blk` back into War Thunder

### After a Restart

The virtual device may get a different button offset after restarting
serve.py or War Thunder. Just re-export your controls.blk into the
`controls/` folder and press **BIND CONTROLS** again — the tool
re-detects the offset automatically every time.

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

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Blank white popup window | Reload the extension in about:debugging |
| Map shows "WAITING FOR WAR THUNDER" | Start a match — the API only responds in-game |
| Phone can't connect | Check same WiFi, use the exact URL from serve.py |
| Virtual gamepad not working | Install `evdev`, check `/dev/uinput` permissions |
| Buttons not doing anything in-game | Bind them in WT's Controls settings first |
| "No .blk in controls/ folder" | Export from WT into the controls/ subfolder |
