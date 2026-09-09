#!/usr/bin/env python3
# v67
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
    http://<this Deck's LAN IP>:8080/mfd.html

Find this Deck's LAN IP by running `hostname -I` in another terminal, or
just watch this script's own startup banner - it prints its best guess.
"""
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

# Virtual gamepad support is OPTIONAL - if the evdev package isn't
# installed, or /dev/uinput isn't accessible, the rest of this server
# (serving files, proxying telemetry) still works fine; only the gamepad
# button endpoints become unavailable. Never let a missing optional
# feature take down the whole server.
try:
    from evdev import UInput, ecodes as ec
    EVDEV_AVAILABLE = True
except ImportError:
    EVDEV_AVAILABLE = False

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
WT_API_BASE = "http://localhost:8111"
# Paths that are War Thunder's live telemetry (proxied through to the
# actual game) rather than this tool's own static files.
PROXIED_PREFIXES = ("/state", "/indicators", "/map_obj.json", "/map_info.json", "/map.img")

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# ============================================================================
# Virtual gamepad - lets the web UI's buttons press a real (virtual)
# joystick/gamepad button, which you then bind to whatever in-game action
# you want via War Thunder's own Controls settings (Gear, Flaps, etc.) -
# same convenience as an extra macro pad, not automation: nothing here
# decides WHEN to press anything, it only presses what a person taps
# on-screen.
#
# HISTORY (four iterations to get here, each confirmed/refuted by real
# testing, not assumption):
#   1. Virtual GAMEPAD spoofing a real Xbox 360 controller's exact
#      vendor/product ID, for max compatibility - collided with an
#      actual physical controller and stopped it connecting.
#   2. Virtual KEYBOARD to avoid that collision - worked in War Thunder's
#      Controls BINDING menu, but never actually registered during real
#      gameplay. Likely cause: Wine's DirectInput keyboard reading is a
#      separate code path from normal windowing key events.
#   3. Back to a virtual GAMEPAD with a generic, non-spoofed identity -
#      fixed the controller collision, but BTN_MODE (the "Guide/Home"
#      button convention) got intercepted by Steam Input globally,
#      opening Steam instead of reaching the game.
#   4. Switched to the BTN_TRIGGER_HAPPY1-40 code range (0x2c0-0x2e7) -
#      sits outside both the DirectInput gamepad range (BTN_GAMEPAD/
#      BTN_MODE, which Proton's winebus and Steam Input treat specially)
#      and the low BTN_BASE joystick range. Explicit non-zero vendor/
#      product ID so SDL2 enumerates it as a real controller. Confirmed
#      via direct testing: all 20 buttons bind correctly, nothing opens
#      Steam at any point in the sequence.
#
# 20 buttons (not 11) - enough for the Controls page's 4-page x 5-button
# layout (Flight / Weapons / Radar / In-Game MFD) without reusing the same
# handful of outputs across different logical pages.
# ============================================================================
GAMEPAD_CAPABILITIES = {}
GAMEPAD_BUTTONS = {}  # name (used in the URL, "H1".."H20") -> evdev button code
# The plain list of button names, independent of whether evdev/uinput is
# actually available - the .blk calibration/sync logic below is pure text
# processing and has nothing to do with the live virtual device, so it
# shouldn't be unable to function just because evdev happens to be missing.
GAMEPAD_BUTTON_CODES = [f"H{i}" for i in range(1, 21)]
gamepad_device = None
gamepad_lock = threading.Lock()

if EVDEV_AVAILABLE:
    # Falls back to raw numeric codes if a particular evdev version doesn't
    # expose every BTN_TRIGGER_HAPPY name as a constant (some older
    # versions only define a subset by name) - matches gamepad_test4.py.
    GAMEPAD_BUTTONS = {}
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


def press_gamepad_button(name):
    """Presses and releases one virtual gamepad button. Returns (ok, message)."""
    if gamepad_device is None:
        return False, "Virtual gamepad not available (evdev missing, or failed to create - see startup log)"
    code = GAMEPAD_BUTTONS.get(name)
    if code is None:
        return False, f"Unknown button '{name}'. Valid: {', '.join(GAMEPAD_BUTTONS.keys())}"
    # Locked so two near-simultaneous requests (e.g. someone double-tapping)
    # can't interleave their press/release event pairs on the same device.
    # ~20ms hold - matches gamepad_test4.py exactly, confirmed working
    # end-to-end (all 20 buttons bound, nothing opened Steam) - shorter
    # than the earlier 100ms figure since a different button-code range
    # can behave differently, and this specific value is what was tested.
    with gamepad_lock:
        gamepad_device.write(ec.EV_KEY, code, 1)
        gamepad_device.syn()
        time.sleep(0.02)
        gamepad_device.write(ec.EV_KEY, code, 0)
        gamepad_device.syn()
    return True, f"Pressed {name}"


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
    "H1": "ID_GEAR", "H2": "ID_FLAPS", "H3": "ID_AIR_BRAKE",
    "H4": "", "H5": "",
    "H6": "", "H7": "ID_BOMBS", "H8": "ID_LOCK_TARGETING",
    "H9": "", "H10": "", "H11": "", "H12": "",
    "H13": "", "H14": "", "H15": "", "H16": "",
    "H17": "", "H18": "", "H19": "", "H20": "",
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
    matches = [d for d in devices if d["devId"] == OUR_DEVICE_ID or d["name"] == OUR_DEVICE_NAME]
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
        # Applied to EVERY response (static files AND proxied telemetry)
        # from one place, so it's never accidentally sent twice (duplicate
        # CORS headers can make browsers reject the response outright) and
        # never accidentally missed on some code path.
        self.send_header("Access-Control-Allow-Origin", "*")
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


if __name__ == "__main__":
    lan_ip = get_lan_ip()

    # Create the virtual gamepad ONCE, before the server starts, and reuse
    # the same device object for every button-press request for as long as
    # this process runs (creating a new virtual device per request would
    # make the OS see it disappear/reappear constantly, which isn't how a
    # real controller behaves). Generic identity - no vendor/product
    # spoofing - confirmed via gamepad_test2.py to avoid the collision
    # that broke a real physical controller with the original approach.
    gamepad_status = "not available (evdev not installed)"
    if EVDEV_AVAILABLE:
        try:
            gamepad_device = UInput(GAMEPAD_CAPABILITIES, name="WT MFD Virtual Joystick", vendor=0x1234, product=0x5678)
            gamepad_status = "ready"
        except Exception as e:
            gamepad_status = f"FAILED to create ({e}) - check /dev/uinput permissions"

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
    print(f"Proxying telemetry from:  {WT_API_BASE}")
    print(f"Virtual gamepad:  {gamepad_status}")
    print()
    print("On your phone (same WiFi network as this Deck), open:")
    print(f"    http://{lan_ip}:{actual_port}/mfd.html")
    print()
    print("Press Ctrl+C to stop.")
    print("=" * 60)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        if gamepad_device is not None:
            gamepad_device.close()
