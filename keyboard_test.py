#!/usr/bin/env python3
"""
Virtual keyboard feasibility test
====================================
Same idea as gamepad_test.py, but a virtual KEYBOARD instead of a virtual
Xbox 360 controller - switched after the gamepad version's device identity
(deliberately matching a real Xbox 360 controller, for compatibility)
collided with an actual physical controller and stopped it connecting.

A virtual keyboard doesn't have that problem - it's its own distinct
device type, nothing shared with a real controller's identity. It also
still avoids the original Wayland-vs-X11 blocker from earlier in this
project: that blocker was specific to xdotool/XTest-style keystroke
SIMULATION, which is an X11-only mechanism. This uses uinput instead,
which operates at the kernel level, below the display server entirely -
same reasoning that made the gamepad approach viable in the first place.

HOW TO TEST:
    1. Run this script (same setup as before - pip install evdev
       --break-system-packages if you haven't already).
    2. In War Thunder, open Settings -> Controls.
    3. Click into any keyboard binding slot (the ones that say "press any
       key") and watch whether it detects a press of the "K" key from
       this script.
    4. Report back either way before we rebuild the button panel around
       this instead of gamepad buttons.

Press Ctrl+C to stop.
"""
import time

try:
    from evdev import UInput, ecodes as e
except ImportError:
    print("Missing dependency. Run this first:")
    print("    python3 -m pip install evdev --break-system-packages")
    raise SystemExit(1)

# A specific, curated list of real keys - not every attribute starting
# with "KEY_" in the evdev library. That was the actual bug: evdev also
# exposes a few non-key sentinel/boundary values under KEY_* names (like
# KEY_MAX, a range marker, not a real key), and the kernel rejects trying
# to register those with exactly the "Invalid argument" error seen here.
# We only need a reasonable set of real, bindable keys anyway.
KEY_NAMES = [
    "KEY_A", "KEY_B", "KEY_C", "KEY_D", "KEY_E", "KEY_F", "KEY_G", "KEY_H",
    "KEY_I", "KEY_J", "KEY_K", "KEY_L", "KEY_M", "KEY_N", "KEY_O", "KEY_P",
    "KEY_Q", "KEY_R", "KEY_S", "KEY_T", "KEY_U", "KEY_V", "KEY_W", "KEY_X",
    "KEY_Y", "KEY_Z",
    "KEY_1", "KEY_2", "KEY_3", "KEY_4", "KEY_5",
    "KEY_6", "KEY_7", "KEY_8", "KEY_9", "KEY_0",
    "KEY_F1", "KEY_F2", "KEY_F3", "KEY_F4", "KEY_F5", "KEY_F6",
    "KEY_F7", "KEY_F8", "KEY_F9", "KEY_F10", "KEY_F11", "KEY_F12",
    "KEY_SPACE", "KEY_ENTER", "KEY_TAB", "KEY_LEFTSHIFT", "KEY_LEFTCTRL", "KEY_LEFTALT",
]
CAPABILITIES = {
    e.EV_KEY: [getattr(e, name) for name in KEY_NAMES]
}

print("Creating virtual keyboard...")
device = UInput(CAPABILITIES, name="WT MFD Virtual Keyboard")
print("Created. Now open War Thunder's Controls settings and check if it's detected.")
print("Pressing the 'K' key every 2 seconds - watch for it registering there.")
print("Press Ctrl+C here to stop.")

try:
    while True:
        time.sleep(2)
        print("  -> pressing K")
        device.write(e.EV_KEY, e.KEY_K, 1)  # press
        device.syn()
        time.sleep(0.1)
        device.write(e.EV_KEY, e.KEY_K, 0)  # release
        device.syn()
except KeyboardInterrupt:
    print("\nStopped.")
finally:
    device.close()
