#!/usr/bin/env python3
"""
Virtual gamepad feasibility test #2 - generic identity, gameplay-focused
==========================================================================
Second attempt at a virtual gamepad, after two things were learned since
the first one:

  1. The original version deliberately spoofed a REAL Xbox 360
     controller's vendor/product ID for maximum compatibility - but that
     collided with an actual physical controller and stopped it
     connecting. This version uses a generic, clearly-unique identity
     instead (no real device impersonated), same approach the well-
     established Windows tool vJoy uses for exactly this reason.

  2. War Thunder players have used vJoy + Joystick Gremlin (virtual
     joystick devices, functionally the same idea as this uinput-based
     approach) successfully in REAL GAMEPLAY for years - confirmed
     directly on the War Thunder forums, not just in the controls-binding
     menu. This is stronger evidence than what we have for a virtual
     KEYBOARD, whose in-game (not menu) detection is unconfirmed - Wine
     has a separate DirectInput keyboard code path that may behave
     differently, whereas joystick/gamepad input has well-documented
     working precedent.

CRITICAL DIFFERENCE FROM THE FIRST GAMEPAD TEST: that one only confirmed
detection in the Controls BINDING menu. This time, testing in an ACTUAL
TEST FLIGHT (not just the menu) is the whole point - that's the specific
gap that broke the keyboard approach, so it needs to be checked here too
before trusting this any further.

HOW TO TEST:
    1. Run this script (pip install evdev --break-system-packages if
       needed, same as before).
    2. In War Thunder's Controls settings, bind a button to something you
       can visually verify in a test flight - Gear or Flaps are good
       choices since you can watch them move.
    3. Start an actual TEST FLIGHT (not just sit in the menu).
    4. Press the button from your phone's KEYBOARD CONTROLS panel... wait,
       this script is standalone - it presses the A button on its own,
       every 2 seconds, so just watch for Gear/Flaps to actually move in
       the test flight while this is running.
    5. Report back: did it work in the BINDING menu, AND did it work
       DURING the test flight? Both answers matter this time.

Press Ctrl+C to stop.
"""
import time

try:
    from evdev import UInput, ecodes as e
except ImportError:
    print("Missing dependency. Run this first:")
    print("    python3 -m pip install evdev --break-system-packages")
    raise SystemExit(1)

CAPABILITIES = {
    e.EV_KEY: [
        e.BTN_A, e.BTN_B, e.BTN_X, e.BTN_Y,
        e.BTN_TL, e.BTN_TR,
        e.BTN_SELECT, e.BTN_START, e.BTN_MODE,
        e.BTN_THUMBL, e.BTN_THUMBR,
    ],
    e.EV_ABS: [
        (e.ABS_X, (0, -32768, 32767, 0, 0)),
        (e.ABS_Y, (0, -32768, 32767, 0, 0)),
        (e.ABS_RX, (0, -32768, 32767, 0, 0)),
        (e.ABS_RY, (0, -32768, 32767, 0, 0)),
        (e.ABS_Z, (0, 0, 255, 0, 0)),
        (e.ABS_RZ, (0, 0, 255, 0, 0)),
        (e.ABS_HAT0X, (0, -1, 1, 0, 0)),
        (e.ABS_HAT0Y, (0, -1, 1, 0, 0)),
    ],
}

print("Creating virtual joystick (generic identity - not impersonating any real device)...")
# No vendor/product spoofing this time - a unique name is enough for the
# OS/game to treat it as its own distinct device, with no risk of
# colliding with a real controller's identity the way the Xbox 360 spoof did.
device = UInput(CAPABILITIES, name="WT MFD Virtual Joystick")
print("Created. Bind a button to Gear or Flaps in War Thunder's Controls settings,")
print("then start an actual TEST FLIGHT (not just the menu) and watch for it moving.")
print("Pressing the A button every 2 seconds - press Ctrl+C here to stop.")

try:
    while True:
        time.sleep(2)
        print("  -> pressing A")
        device.write(e.EV_KEY, e.BTN_A, 1)
        device.syn()
        time.sleep(0.1)
        device.write(e.EV_KEY, e.BTN_A, 0)
        device.syn()
except KeyboardInterrupt:
    print("\nStopped.")
finally:
    device.close()
