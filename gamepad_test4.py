#!/usr/bin/env python3
"""
Virtual joystick feasibility test #4 - BTN_TRIGGER_HAPPY range, 20 buttons
=============================================================================
Applies findings from real testing on this exact setup:
  - BTN_TRIGGER_HAPPY1-40 (0x2c0-0x2e7) sit outside the standard XInput/
    DirectInput gamepad range that Proton's winebus treats specially (the
    BTN_GAMEPAD/BTN_MODE range that caused the Guide-button/Steam-hijack
    problem, and the low BTN_BASE joystick range that reportedly double-
    mapped presses under winebus).
  - Explicit non-zero vendor/product IDs, so SDL2 enumerates this as a
    real game controller rather than ignoring it as a misc/keyboard-class
    device.
  - A ~20ms gap between press and release (vs. the 100ms used in the
    earlier BTN_TRIGGER/BTN_THUMB-based test) - short enough to feel
    responsive, per your own testing.

20 buttons this time (not 11) - enough for the planned 4-page Controls
layout (Flight / Weapons / Radar / In-Game MFD, 5 buttons each) without
reusing the same handful of outputs across different logical pages.

HOW TO TEST (phone-remote controlled, same as before - keeps this Deck's
focus on War Thunder the whole time):
    1. Run: python3 gamepad_test4.py [port]   (default port 8091)
    2. On your phone, open the URL it prints - a "SEND NEXT BUTTON" button.
    3. For each of the 20: click to add a new binding for "Target Camera
       (Helicopter)" in WT's Controls settings, THEN tap the phone button.
    4. Watch for:
         - Does anything open Steam at ANY point in the sequence?
         - Do all 20 register, not just a handful?
    5. Report back both answers before we wire this into the real app.

Press Ctrl+C on the Deck to stop.
"""
import http.server
import socket
import sys
import time

try:
    from evdev import UInput, ecodes as e
except ImportError:
    print("Missing dependency. Run this first:")
    print("    python3 -m pip install evdev --break-system-packages")
    raise SystemExit(1)

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8091

# 20 buttons - BTN_TRIGGER_HAPPY1 through BTN_TRIGGER_HAPPY20. Falls back
# to raw numeric codes if a particular evdev version doesn't expose every
# name as a constant (some older versions only define a subset by name).
BUTTON_NAMES = [f"H{i}" for i in range(1, 21)]  # H1..H20, matches page-button naming later
JOYSTICK_CODES = []
for i in range(1, 21):
    const_name = f"BTN_TRIGGER_HAPPY{i}"
    if hasattr(e, const_name):
        JOYSTICK_CODES.append(getattr(e, const_name))
    else:
        JOYSTICK_CODES.append(0x2c0 + (i - 1))  # raw fallback

CAPABILITIES = {
    e.EV_KEY: JOYSTICK_CODES,
    e.EV_ABS: [
        (e.ABS_X, (0, -32768, 32767, 0, 0)),
        (e.ABS_Y, (0, -32768, 32767, 0, 0)),
    ],
}

print("Creating virtual joystick (BTN_TRIGGER_HAPPY range, explicit vendor/product ID)...")
# Explicit, clearly-fake, non-colliding vendor/product - not impersonating
# any real device (same reasoning as gamepad_test2.py's fix for the
# original Xbox 360 identity collision), just present so SDL2 treats this
# as a real enumerated controller rather than ignoring it.
device = UInput(CAPABILITIES, name="WT MFD Virtual Joystick", vendor=0x1234, product=0x5678)
print("Created.")

next_index = [0]


def send_next_button():
    if next_index[0] >= len(BUTTON_NAMES):
        return None, "All 20 buttons already sent - restart the script to go again."
    name = BUTTON_NAMES[next_index[0]]
    code = JOYSTICK_CODES[next_index[0]]
    device.write(e.EV_KEY, code, 1)
    device.syn()
    time.sleep(0.02)  # ~20ms, per your tested findings
    device.write(e.EV_KEY, code, 0)
    device.syn()
    next_index[0] += 1
    remaining = len(BUTTON_NAMES) - next_index[0]
    return name, f"Sent '{name}' ({next_index[0]}/20). {remaining} left."


PAGE_TEMPLATE = """<!DOCTYPE html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Joystick Test 4</title>
<style>
body {{ background:#0a0e17; color:#fff; font-family:monospace; text-align:center; padding:20px; }}
button {{ font-size:24px; padding:30px 20px; width:100%; background:#131c31; color:#00ffcc;
          border:2px solid #2e4470; border-radius:10px; margin-top:20px; }}
button:active {{ background:#00ffcc; color:#05070a; }}
#status {{ font-size:16px; margin-top:20px; color:#8b9bb4; }}
</style></head>
<body>
<h2>Joystick Test 4 (20 buttons)</h2>
<div id="status">Ready. Tap below to send button 1 (H1).</div>
<button onclick="sendNext()">SEND NEXT BUTTON</button>
<script>
async function sendNext() {{
    document.getElementById('status').textContent = 'Sending...';
    try {{
        const res = await fetch('/next', {{ method: 'POST' }});
        const text = await res.text();
        document.getElementById('status').textContent = res.ok ? text : ('ERROR (HTTP ' + res.status + '): ' + text);
    }} catch (err) {{
        document.getElementById('status').textContent = 'REQUEST FAILED: ' + err.message;
    }}
}}
</script>
</body></html>"""


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = PAGE_TEMPLATE.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path == "/next":
            try:
                name, message = send_next_button()
                print(f"  -> {message}")
                body = message.encode("utf-8")
                self.send_response(200)
            except Exception as ex:
                print(f"  -> ERROR: {ex}")
                body = f"Server error: {ex}".encode("utf-8")
                self.send_response(500)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        pass


def get_lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "<couldn't detect - run 'hostname -I' manually>"
    finally:
        s.close()


if __name__ == "__main__":
    lan_ip = get_lan_ip()
    print()
    print("On your phone (same WiFi as this Deck), open:")
    print(f"    http://{lan_ip}:{PORT}/")
    print()
    print("Tap once per binding - keeps this Deck's focus on War Thunder throughout.")
    print("Press Ctrl+C here to stop.")
    server = http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        device.close()
