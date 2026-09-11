#!/usr/bin/env python3
# v91
"""
WT Tactical MFD - local server for phone/tablet access
========================================================
Serves this tool's files AND proxies War Thunder's telemetry API, so a
phone on the same WiFi network can open the tool in ANY browser - no
Firefox extension installation needed, which isn't realistically possible
on mobile anyway.

WHY A PROXY, not just pointing the phone straight at localhost:8111?
  1. "localhost" on a phone means the PHONE itself, not this Deck - the
     phone needs this machine's real LAN IP either way.
  2. Browsers enforce CORS (Cross-Origin Resource Sharing) for plain
     webpages in a way they don't for installed browser extensions (the
     Firefox extension bypasses this via its declared host_permissions -
     a plain webpage gets no such exemption). Rather than gamble on
     whether War Thunder's API sends the right CORS headers for a
     cross-origin browser fetch, the phone only ever talks to ONE origin
     (this server), and THIS server - running ON the Deck - reaches the
     game via genuine localhost, which is guaranteed to work since that's
     exactly how the Firefox extension already does it successfully.

USAGE:
    python3 serve.py [port]
    (default port: 8080)

Then on your phone (same WiFi network as this Deck), open:
    http://<this machine's LAN IP>:8080/mfd.html

Find the LAN IP by running `hostname -I` in another terminal, or just
watch this script's own startup banner - it prints its best guess.

VIRTUAL GAMEPAD BACKENDS
    Linux (Steam Deck):  uses evdev/uinput. Install evdev if missing:
                         pip install evdev --break-system-packages

    Windows:             uses vJoy 2.1.9.1 via ctypes. Install vJoy from
                         https://github.com/shauleiz/vJoy/releases
                         (use 2.1.9.1 specifically - 2.2.x has an expired
                         code-signing cert that Windows 11 blocks).
                         After installing, open "Configure vJoy" from the
                         Start menu and create device 1 with at least 20
                         buttons. No extra Python packages required.
"""
import ctypes
import functools
import http.server
import json
import os
import re
import socket
import sys
import threading
import time
import urllib.error
import urllib.request

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
WT_API_BASE = "http://localhost:8111"
# Paths that are War Thunder's live telemetry (proxied through to the
# actual game) rather than this tool's own static files.
PROXIED_PREFIXES = ("/state", "/indicators", "/map_obj.json", "/map_info.json", "/map.img")

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# ============================================================================
# Virtual gamepad - cross-platform
#
# Linux  → evdev/uinput (BTN_TRIGGER_HAPPY1-20, confirmed working on Deck)
# Windows→ vJoy 2.1.9.1 via ctypes (no extra pip install needed)
#
# Both backends expose the same press_gamepad_button(name) call. The rest
# of the server never touches platform specifics directly.
#
# LINUX HISTORY (kept here for context on why BTN_TRIGGER_HAPPY):
#   1. Xbox 360 spoof → collided with a real physical controller.
#   2. Virtual keyboard → registered in the bind menu but not in-game.
#   3. Generic gamepad → BTN_MODE intercepted by Steam, opened overlay.
#   4. BTN_TRIGGER_HAPPY1-40 (0x2c0-0x2e7) → outside DirectInput/Steam
#      special ranges. All 20 buttons bind; nothing opens Steam.
#
# WINDOWS / vJoy NOTES:
#   - vJoy is a kernel driver, so its device is ALWAYS visible in WT's
#     deviceMapping even when serve.py isn't running. The auto-bind tool
#     looks for it by a set of known vJoy name patterns (see VJOY_NAMES
#     below) in addition to our Linux device identity.
#   - Use vJoy 2.1.9.1 specifically. 2.2.x has an expired code-signing
#     certificate that Windows 11 blocks at the driver level.
#   - Configure vJoy device 1 with at least 20 buttons in "Configure vJoy"
#     before running serve.py. Buttons are 1-based in vJoy (button 1 = H1).
# ============================================================================

PLATFORM = "linux" if sys.platform.startswith("linux") else \
           "windows" if sys.platform == "win32" else "unsupported"

# Names vJoy can appear as in an exported controls.blk. War Thunder writes
# the device's HID name, which varies by vJoy version and Windows locale.
# These cover every variant seen in the wild; all checked case-insensitively.
VJOY_NAMES = [
    "vjoy device",
    "vjoy - virtual joystick",
    "virtual joystick",
    "vjoy",
]

EVDEV_AVAILABLE = False
VJOY_AVAILABLE = False

# The plain list of button names - used by the .blk auto-bind logic which
# is pure text processing and works regardless of gamepad backend state.
GAMEPAD_BUTTON_CODES = [f"H{i}" for i in range(1, 21)]
GAMEPAD_BUTTONS = {}   # H1..H20 -> evdev code (Linux only)
GAMEPAD_CAPABILITIES = {}
gamepad_device = None  # evdev UInput instance (Linux) or None
gamepad_lock = threading.Lock()

# ---------- Linux: evdev/uinput ----------
if PLATFORM == "linux":
    try:
        from evdev import UInput, ecodes as ec
        EVDEV_AVAILABLE = True
    except ImportError:
        pass

    if EVDEV_AVAILABLE:
        for i in range(1, 21):
            const_name = f"BTN_TRIGGER_HAPPY{i}"
            GAMEPAD_BUTTONS[f"H{i}"] = getattr(ec, const_name, 0x2c0 + (i - 1))
        GAMEPAD_CAPABILITIES = {
            ec.EV_KEY: list(GAMEPAD_BUTTONS.values()),
            ec.EV_ABS: [
                (ec.ABS_X, (0, -32768, 32767, 0, 0)),
                (ec.ABS_Y, (0, -32768, 32767, 0, 0)),
            ],
        }

# ---------- Windows: vJoy via ctypes ----------
# vJoy's DLL exposes a simple C API. We only need three functions:
#   AcquireVJD(rID)           - claim exclusive ownership of device rID
#   SetBtn(value, rID, nBtn)  - set button nBtn on device rID to 0 or 1
# vJoy button numbers are 1-based, so H1 → button 1, H20 → button 20.
# The DLL lives at a fixed path for all vJoy installs.
_vjoy = None
_VJOY_DEVICE_ID = 1   # vJoy device number (1-based); 1 is the default device

VJOY_DLL_PATHS = [
    r"C:\Program Files\vJoy\x86\vJoyInterface.dll",
    r"C:\Program Files (x86)\vJoy\x86\vJoyInterface.dll",
]

if PLATFORM == "windows":
    for _dll_path in VJOY_DLL_PATHS:
        if os.path.exists(_dll_path):
            try:
                _vjoy = ctypes.WinDLL(_dll_path)
                # AcquireVJD returns TRUE (1) on success
                if _vjoy.AcquireVJD(_VJOY_DEVICE_ID):
                    VJOY_AVAILABLE = True
                else:
                    _vjoy = None
            except Exception:
                _vjoy = None
            break


def press_gamepad_button(name):
    """Press and release one virtual gamepad button. Returns (ok, message)."""

    # --- Linux path ---
    if PLATFORM == "linux":
        if gamepad_device is None:
            return False, "Virtual gamepad not available (evdev missing or failed — see startup log)"
        code = GAMEPAD_BUTTONS.get(name)
        if code is None:
            return False, f"Unknown button '{name}'"
        with gamepad_lock:
            gamepad_device.write(ec.EV_KEY, code, 1)
            gamepad_device.syn()
            time.sleep(0.02)
            gamepad_device.write(ec.EV_KEY, code, 0)
            gamepad_device.syn()
        return True, f"Pressed {name}"

    # --- Windows path ---
    if PLATFORM == "windows":
        if not VJOY_AVAILABLE or _vjoy is None:
            return False, (
                "vJoy not available. Install vJoy 2.1.9.1 from "
                "https://github.com/shauleiz/vJoy/releases and configure "
                "device 1 with at least 20 buttons."
            )
        # H1 → button 1, H20 → button 20 (vJoy is 1-based)
        try:
            btn_num = int(name[1:])
        except (ValueError, IndexError):
            return False, f"Unknown button '{name}'"
        with gamepad_lock:
            _vjoy.SetBtn(1, _VJOY_DEVICE_ID, btn_num)
            time.sleep(0.02)
            _vjoy.SetBtn(0, _VJOY_DEVICE_ID, btn_num)
        return True, f"Pressed {name}"

    return False, f"Virtual gamepad not supported on this platform ({PLATFORM})"


# ============================================================================
# ----------------------------------------------------------------------------
# .blk controls-file auto-bind
# ----------------------------------------------------------------------------
# Folder-based: the user drops their exported controls.blk into the
# controls/ subfolder next to this script, presses one button, and gets
# a bound copy written back into the same folder. No file pickers, no
# upload/download dance.
#
# Our virtual device is identified in the file's own deviceMapping{} block
# by the exact vendor/product ID and name we set on it (see UInput() below),
# so the offset is always correct with zero prep.
#
# Every operation here works on a COPY - the original .blk is never modified.
# ============================================================================
CONTROLS_DIR = os.path.join(SCRIPT_DIR, "controls")
CALIBRATION_FILE = os.path.join(SCRIPT_DIR, "gamepad_calibration.json")
OUR_DEVICE_ID = "1234:5678"
OUR_DEVICE_NAME = "WT MFD Virtual Joystick"

DEFAULT_TARGET_IDS = {
    # FLIGHT
    "H1":  "ID_GEAR",
    "H2":  "ID_FLAPS_UP",
    "H3":  "ID_FLAPS_DOWN",
    "H4":  "ID_PLANE_NIGHT_VISION",
    "H5":  "ID_TOGGLE_NIGHT_VISION",
    # WEAPONS
    "H6":  "ID_TOGGLE_PERIODIC_FLARES",
    "H7":  "ID_SWITCH_SHOOTING_CYCLE_SECONDARY",
    "H8":  "ID_RESIZE_SECONDARY_WEAPON_SERIES",
    "H9":  "ID_TOGGLE_LASER_DESIGNATOR",
    "H10": "ID_UNLOCK_TARGETING_AT_POINT",
    "H11": "ID_TOGGLE_ROCKETS_BALLISTIC_COMPUTER",
    "H12": "ID_TOGGLE_CANNONS_BALLISTIC_COMPUTER",
    # RADAR
    "H13": "ID_SENSOR_SWITCH",
    "H14": "ID_SENSOR_RANGE_SWITCH",
    "H15": "ID_SENSOR_SCAN_PATTERN_SWITCH",
    "H16": "ID_SENSOR_TYPE_SWITCH",
    "H17": "ID_SENSOR_MODE_SWITCH",
    "H18": "ID_SENSOR_TARGET_SWITCH",
    "H19": "ID_SENSOR_TARGET_LOCK",
    "H20": "",  # user-customisable, no default bind
}


def load_calibration():
    if os.path.exists(CALIBRATION_FILE):
        with open(CALIBRATION_FILE) as f:
            data = json.load(f)
            data.setdefault("target_ids", dict(DEFAULT_TARGET_IDS))
            return data
    return {"target_ids": dict(DEFAULT_TARGET_IDS)}


def save_calibration(data):
    with open(CALIBRATION_FILE, "w") as f:
        json.dump(data, f, indent=2)


def find_newest_blk():
    """Returns the path to the newest .blk file in CONTROLS_DIR, or None."""
    os.makedirs(CONTROLS_DIR, exist_ok=True)
    blks = [os.path.join(CONTROLS_DIR, f) for f in os.listdir(CONTROLS_DIR)
            if f.lower().endswith(".blk") and not f.startswith("controls_bound")]
    if not blks:
        return None
    return max(blks, key=os.path.getmtime)


def insert_hotkey_bindings(blk_text, bindings):
    lines = blk_text.splitlines()
    hotkeys_start = None
    for i, line in enumerate(lines):
        if line.strip() == "hotkeys{":
            hotkeys_start = i
            break
    if hotkeys_start is None:
        raise ValueError("No hotkeys{ block found - is this a real exported controls.blk?")
    depth = 1
    insert_at = None
    for i in range(hotkeys_start + 1, len(lines)):
        depth += lines[i].count("{") - lines[i].count("}")
        if depth == 0:
            insert_at = i
            break
    if insert_at is None:
        raise ValueError("Malformed hotkeys{ block - file may be truncated")
    new_lines = []
    for action_id, joy_buttons in bindings.items():
        if not action_id:
            continue
        new_lines.append(f"    {action_id}{{")
        for jb in joy_buttons:
            new_lines.append(f"      joyButton:i={jb}")
        new_lines.append("    }")
        new_lines.append("")
    return "\r\n".join(lines[:insert_at] + new_lines + lines[insert_at:]) + "\r\n"


def parse_device_mapping(blk_text):
    devices = []
    for block in re.findall(r"joystick\{([^}]*)\}", blk_text):
        def field(pattern):
            m = re.search(pattern, block)
            return m.group(1) if m else None
        connected = field(r'connected:b=(\w+)')
        dev_id = field(r'devId:t="([^"]*)"')
        name = field(r'name:t="([^"]*)"')
        offset = field(r'buttonsOffset:i=(-?\d+)')
        count = field(r'buttonsCount:i=(-?\d+)')
        if offset is None or count is None:
            continue
        devices.append({
            "connected": connected == "yes",
            "devId": dev_id or "",
            "name": name or "",
            "buttonsOffset": int(offset),
            "buttonsCount": int(count),
        })
    return devices


def find_our_device(blk_text):
    devices = parse_device_mapping(blk_text)
    # Linux: match by our exact vendor:product ID or device name.
    # Windows/vJoy: vJoy's kernel driver always registers as a fixed HID
    # device - the name varies slightly by version and locale, so we check
    # against a list of known variants (case-insensitive). The devId for
    # vJoy is typically "044f:b677" but also varies, so name-matching is
    # the more reliable path on Windows.
    def is_ours(d):
        if d["devId"] == OUR_DEVICE_ID or d["name"] == OUR_DEVICE_NAME:
            return True
        name_lower = d["name"].lower()
        return any(v in name_lower for v in VJOY_NAMES)

    matches = [d for d in devices if is_ours(d)]
    connected = [d for d in matches if d["connected"]]
    return connected[0] if connected else (matches[0] if matches else None)


def run_direct_bind(blk_text):
    device = find_our_device(blk_text)
    if device is None:
        return False, None, (
            f'"{OUR_DEVICE_NAME}" not found in deviceMapping. '
            f"Make sure serve.py was running when you exported."
        )
    if not device["connected"]:
        return False, None, (
            f'"{device["name"]}" found but shows disconnected. '
            f"Start serve.py, press any MFD button once, then re-export."
        )
    offset = device["buttonsOffset"]
    data = load_calibration()
    target_ids = data.get("target_ids", DEFAULT_TARGET_IDS)
    bindings = {}
    skipped = []
    for i, code in enumerate(GAMEPAD_BUTTON_CODES):
        target_id = target_ids.get(code, "")
        if not target_id:
            skipped.append(code)
            continue
        bindings[target_id] = [offset + i]
    try:
        result = insert_hotkey_bindings(blk_text, bindings)
    except ValueError as e:
        return False, None, str(e)
    msg = f"Bound {len(bindings)} actions (offset {offset}, device \"{device['name']}\")."
    if skipped:
        msg += f" {len(skipped)} skipped (no target ID)."
    return True, result, msg


def run_folder_bind():
    """Reads newest .blk from controls/, binds, writes controls_bound.blk."""
    src = find_newest_blk()
    if src is None:
        return False, "No .blk file found in controls/ folder. Export your controls from War Thunder into that folder first."
    with open(src, "r", encoding="utf-8", errors="replace") as f:
        blk_text = f.read()
    ok, result_text, msg = run_direct_bind(blk_text)
    if not ok:
        return False, msg
    out_path = os.path.join(CONTROLS_DIR, "controls_bound.blk")
    with open(out_path, "w", encoding="utf-8", newline="") as f:
        f.write(result_text)
    return True, f"{msg} Written to controls/controls_bound.blk (import this file into War Thunder)."






class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith(PROXIED_PREFIXES):
            self.proxy_to_war_thunder()
        elif self.path.startswith("/gamepad/press/"):
            self.handle_gamepad_press()
        elif self.path == "/blk/status":
            self.handle_blk_status()
        else:
            super().do_GET()

    def do_POST(self):
        if self.path == "/blk/bind":
            self.handle_blk_bind()
        elif self.path == "/blk/settings":
            self.handle_blk_settings()
        else:
            self.send_response(404)
            self.end_headers()

    def do_HEAD(self):
        # mfd.js only ever uses fetch() (GET), so this path is never hit
        # by the actual tool - fixed anyway so manual testing (curl -I,
        # browser dev tools, etc.) doesn't see a misleading 404 here.
        if self.path.startswith(PROXIED_PREFIXES):
            self.proxy_to_war_thunder()
        else:
            super().do_HEAD()

    def read_body_text(self):
        length = int(self.headers.get("Content-Length", 0))
        return self.rfile.read(length).decode("utf-8", errors="replace")

    def send_json(self, status, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def handle_blk_status(self):
        data = load_calibration()
        src = find_newest_blk()
        self.send_json(200, {
            "target_ids": data.get("target_ids", DEFAULT_TARGET_IDS),
            "button_codes": GAMEPAD_BUTTON_CODES,
            "source_file": os.path.basename(src) if src else None,
            "controls_dir": CONTROLS_DIR,
        })

    def handle_blk_bind(self):
        try:
            ok, msg = run_folder_bind()
            self.send_json(200 if ok else 400, {"ok": ok, "message": msg})
        except Exception as e:
            self.send_json(500, {"ok": False, "message": f"Server error: {e}"})

    def handle_blk_settings(self):
        try:
            payload = json.loads(self.read_body_text())
            data = load_calibration()
            target_ids = data.get("target_ids", dict(DEFAULT_TARGET_IDS))
            new_ids = payload.get("target_ids", {})
            for code in GAMEPAD_BUTTON_CODES:
                if code in new_ids:
                    target_ids[code] = new_ids[code].strip()
            data["target_ids"] = target_ids
            save_calibration(data)
            self.send_json(200, {"ok": True, "target_ids": target_ids})
        except Exception as e:
            self.send_json(500, {"ok": False, "message": f"Server error: {e}"})

    def handle_gamepad_press(self):
        button_name = self.path.rsplit("/", 1)[-1].upper()
        client_ip = self.client_address[0]
        print(f"[GAMEPAD] {client_ip} -> {button_name}", end=" ")
        ok, message = press_gamepad_button(button_name)
        print(f"{'OK' if ok else 'FAIL: ' + message}")
        body = message.encode("utf-8")
        self.send_response(200 if ok else 400)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def proxy_to_war_thunder(self):
        url = f"{WT_API_BASE}{self.path}"
        try:
            with urllib.request.urlopen(url, timeout=2) as resp:
                body = resp.read()
                self.send_response(200)
                self.send_header("Content-Type", resp.headers.get("Content-Type", "application/json"))
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()  # adds Access-Control-Allow-Origin, see override below
                self.wfile.write(body)
        except (urllib.error.URLError, socket.timeout, ConnectionRefusedError):
            # War Thunder isn't running, or isn't in a match yet - a
            # normal/expected state (the tool's own "OFFLINE" status
            # handling already deals with this), not a real server error.
            self.send_response(503)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"War Thunder API not reachable (game not running or not in a match)")

    def end_headers(self):
        # SECURITY: CORS was previously a blanket "*", which means ANY
        # website loaded in ANY browser on the same network - not just
        # this extension - could fetch() these endpoints cross-origin and
        # silently press gamepad buttons or read telemetry, without the
        # user ever visiting anything related to this tool. That's a real
        # drive-by risk once this is public on a LAN.
        #
        # The legitimate cross-origin caller is the Firefox extension
        # popup, which always has a moz-extension:// origin. Requests
        # loaded directly from serve.py itself (phone/browser access) are
        # same-origin and don't need a CORS header at all. So: only grant
        # CORS to a moz-extension:// (or chrome-extension://, for anyone
        # who ports this) Origin - everything else gets no CORS header,
        # which browsers treat as "cross-origin request denied".
        #
        # This does NOT stop a device that's already on your LAN from
        # directly curling these endpoints (CORS is a browser-only, JS-only
        # restriction) - see SECURITY.md for what this tool does and
        # doesn't protect against.
        origin = self.headers.get("Origin", "")
        if origin.startswith("moz-extension://") or origin.startswith("chrome-extension://"):
            self.send_header("Access-Control-Allow-Origin", origin)
        super().end_headers()

    def log_message(self, format, *args):
        print(f"[serve.py] {self.address_string()} - {format % args}")


def get_lan_ip():
    """Best-effort guess at this machine's LAN IP, for the startup banner."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))  # doesn't actually send anything, just picks a route
        return s.getsockname()[0]
    except OSError:
        return "<couldn't detect - run 'hostname -I' manually>"
    finally:
        s.close()


def stdin_debug_loop():
    """Runs in a background thread alongside the server - type a button
    code (e.g. H1) directly into this terminal and it presses immediately,
    with the same [GAMEPAD] log line a real request would produce. This
    isolates "does serve.py/uinput actually work" from "is the network
    request from the browser/phone even reaching serve.py" - if typing
    here works but the browser doesn't trigger a log line at all, the
    problem is network/JS, not this server or the virtual gamepad."""
    print("[DEBUG] Type a button code (H1-H20) and press Enter to test it directly. Type 'quit' to stop this prompt (server keeps running).")
    while True:
        try:
            line = input().strip().upper()
        except (EOFError, KeyboardInterrupt):
            break
        if not line:
            continue
        if line in ("QUIT", "EXIT"):
            print("[DEBUG] Stdin debug prompt stopped (server still running, Ctrl+C to fully stop).")
            break
        print(f"[GAMEPAD] <stdin debug> -> {line}", end=" ")
        ok, message = press_gamepad_button(line)
        print(f"{'OK' if ok else 'FAIL: ' + message}")


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="WT Tactical MFD - phone/tablet server")
    parser.add_argument("--press", metavar="CODE", help="Press one virtual gamepad button (e.g. H1) and exit immediately, without starting the web server. Use this to test the uinput device in isolation.")
    parser.add_argument("--no-debug-prompt", action="store_true", help="Don't start the interactive stdin debug prompt alongside the server.")
    args = parser.parse_args()

    if args.press:
        # One-shot hardware test - no server, no network, just: does the
        # virtual gamepad device itself work at all.
        code = args.press.strip().upper()
        print(f"Testing virtual gamepad: pressing {code}...")
        if PLATFORM == "linux":
            if not EVDEV_AVAILABLE:
                print("FAILED: evdev not installed (pip install evdev --break-system-packages)")
                sys.exit(1)
            try:
                gamepad_device = UInput(GAMEPAD_CAPABILITIES, name="WT MFD Virtual Joystick", vendor=0x1234, product=0x5678)
                ok, message = press_gamepad_button(code)
                print(f"{'OK' if ok else 'FAILED'}: {message}")
                gamepad_device.close()
            except Exception as e:
                print(f"FAILED to create virtual gamepad: {e}")
                print("Check /dev/uinput permissions (may need sudo, or a udev rule).")
        elif PLATFORM == "windows":
            if not VJOY_AVAILABLE:
                print("FAILED: vJoy not available. Install vJoy 2.1.9.1 and configure device 1 with 20+ buttons.")
                sys.exit(1)
            ok, message = press_gamepad_button(code)
            print(f"{'OK' if ok else 'FAILED'}: {message}")
        else:
            print(f"FAILED: platform '{PLATFORM}' not supported.")
        sys.exit(0)

    lan_ip = get_lan_ip()

    # Create the virtual gamepad ONCE at startup and reuse for all requests.
    gamepad_status = "not available"
    if PLATFORM == "linux":
        if not EVDEV_AVAILABLE:
            gamepad_status = "not available (evdev not installed — pip install evdev --break-system-packages)"
        else:
            try:
                gamepad_device = UInput(GAMEPAD_CAPABILITIES, name="WT MFD Virtual Joystick", vendor=0x1234, product=0x5678)
                gamepad_status = "ready (Linux/evdev, BTN_TRIGGER_HAPPY1-20)"
            except Exception as e:
                gamepad_status = f"FAILED to create ({e}) — check /dev/uinput permissions"
    elif PLATFORM == "windows":
        if VJOY_AVAILABLE:
            gamepad_status = f"ready (Windows/vJoy, device {_VJOY_DEVICE_ID}, buttons 1-20)"
        else:
            gamepad_status = (
                "not available — install vJoy 2.1.9.1 from "
                "https://github.com/shauleiz/vJoy/releases "
                "and configure device 1 with 20+ buttons"
            )
    else:
        gamepad_status = f"not supported on this platform ({PLATFORM})"

    # directory=SCRIPT_DIR makes it serve mfd.html/mfd.js/mfd.css/etc from
    # THIS script's own folder regardless of the working directory it's
    # launched from. Binding to 0.0.0.0 (not just localhost/127.0.0.1) is
    # what actually makes it reachable from another device at all.
    handler = functools.partial(Handler, directory=SCRIPT_DIR)
    # ThreadingHTTPServer, not plain HTTPServer - the plain version handles
    # ONE request at a time, strictly in sequence. mfd.js fires off several
    # telemetry requests every 250-1000ms the moment it loads - on a
    # single-threaded server, if even one of those is slow (or War Thunder
    # isn't responding yet), it blocks EVERY other pending request behind
    # it, including the request for mfd.html/mfd.css/mfd.js themselves -
    # this is exactly what "the page just loads forever" looks like from
    # the browser's side. ThreadingHTTPServer handles each request on its
    # own thread instead, so a slow/stuck one can't stall everything else.
    #
    # BUG FIX: the startup banner (including the "open this URL on your
    # phone" line) used to print BEFORE attempting to bind the socket -
    # so if binding failed (e.g. a leftover process from a previous run
    # still holding the port), it still confidently printed a URL that
    # was never actually live, which is exactly what caused confusion
    # here: the banner looked successful even on a run that crashed
    # immediately after. Now it only prints once binding has genuinely
    # succeeded.
    #
    # AUTO PORT SWITCHING: rather than failing outright with "Address
    # already in use" (which kept happening from leftover processes from
    # earlier runs), try the next port automatically. actual_port may
    # differ from the requested PORT - the banner below always reports
    # whichever one actually worked, since that's the one that matters.
    MAX_PORT_ATTEMPTS = 20
    server = None
    actual_port = PORT
    last_error = None
    for attempt in range(MAX_PORT_ATTEMPTS):
        candidate_port = PORT + attempt
        try:
            server = http.server.ThreadingHTTPServer(("0.0.0.0", candidate_port), handler)
            actual_port = candidate_port
            break
        except OSError as e:
            last_error = e
            continue

    if server is None:
        print(f"FAILED to start: tried ports {PORT}-{PORT + MAX_PORT_ATTEMPTS - 1}, all in use.")
        print(f"Last error: {last_error}")
        print()
        print("This usually means several previous copies of this script are")
        print("still running. Try: pkill -9 -f serve.py")
        sys.exit(1)

    print("=" * 60)
    print("WT Tactical MFD - phone/tablet server")
    print("=" * 60)
    if actual_port != PORT:
        print(f"NOTE: port {PORT} was already in use - automatically switched to {actual_port} instead.")
    print(f"Serving files from:  {SCRIPT_DIR}")
    print(f"Drop your controls.blk into:  {CONTROLS_DIR}")
    print(f"Proxying telemetry from:  {WT_API_BASE}")
    print(f"Virtual gamepad:  {gamepad_status}")
    print()
    print("On your phone (same WiFi network as this Deck), open:")
    print(f"    http://{lan_ip}:{actual_port}/mfd.html")
    print()
    print("Press Ctrl+C to stop.")
    print("=" * 60)

    if not args.no_debug_prompt:
        threading.Thread(target=stdin_debug_loop, daemon=True).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        if gamepad_device is not None:
            gamepad_device.close()
        if VJOY_AVAILABLE and _vjoy is not None:
            try:
                _vjoy.RelinquishVJD(_VJOY_DEVICE_ID)
            except Exception:
                pass
