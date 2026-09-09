#!/usr/bin/env python3
"""
Virtual gamepad feasibility test
==================================
Creates a virtual Xbox 360 controller using Linux's uinput subsystem, then
repeatedly presses the A button every 2 seconds. This is a STANDALONE test,
deliberately NOT wired into anything else yet - the only question it's
meant to answer is:

    Does War Thunder's own control-binding menu detect this virtual
    device and let you bind a button to it?

Why test this in isolation first: virtual gamepads created this way are a
well-established, legitimate technique (the same one game-streaming tools
like Sunshine/Moonshine use) - but games running through Wine/Proton
specifically have documented cases of NOT detecting them, even when the
device is correctly seen by system-level tools. Since I don't know whether
your War Thunder install runs natively or via Proton, this needs a real
test against the actual game before building the real control panel on
top of it.

SETUP (one-time):
    pip install evdev --break-system-packages

    You likely also need permission to access /dev/uinput. Try running
    this script normally first:
        python3 gamepad_test.py
    If it fails with a "Permission denied" error on /dev/uinput, run it
    with sudo instead for this initial test:
        sudo python3 gamepad_test.py
    (A permanent, no-sudo-needed permission fix is a separate, later step
    - not worth setting up yet if the basic idea doesn't even pan out.)

HOW TO TEST:
    1. Run this script (see above).
    2. In War Thunder, open Settings -> Controls.
    3. Look for a new controller/joystick showing up in the device list,
       OR click into any control binding slot (the ones that say "press
       any key/button") and watch whether it detects a button press from
       this script (it presses A once every 2 seconds).
    4. Report back either way - "yes, it showed up" or "no, nothing" -
       before we build anything further on top of this.

Press Ctrl+C to stop.
"""
import time

try:
    from evdev import UInput, ecodes as e
except ImportError:
    print("Missing dependency. Run this first:")
    print("    pip install evdev --break-system-packages")
    raise SystemExit(1)

# Capabilities matching a standard Xbox 360 controller - not every game
# checks these strictly, but matching a known-real controller's button/
# axis set is the most compatible choice (this is the same approach
# other virtual-controller tools use, e.g. ubox360's Xbox 360 event set).
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
        (e.ABS_Z, (0, 0, 255, 0, 0)),   # left trigger
        (e.ABS_RZ, (0, 0, 255, 0, 0)),  # right trigger
        (e.ABS_HAT0X, (0, -1, 1, 0, 0)),
        (e.ABS_HAT0Y, (0, -1, 1, 0, 0)),
    ],
}

print("Creating virtual Xbox 360 controller...")
device = UInput(CAPABILITIES, name="Microsoft X-Box 360 pad", vendor=0x045e, product=0x028e)
print("Created. Now open War Thunder's Controls settings and check if it's detected.")
print("Pressing the A button every 2 seconds - watch for it registering there.")
print("Press Ctrl+C here to stop.")

try:
    while True:
        time.sleep(2)
        print("  -> pressing A")
        device.write(e.EV_KEY, e.BTN_A, 1)  # press
        device.syn()
        time.sleep(0.1)
        device.write(e.EV_KEY, e.BTN_A, 0)  # release
        device.syn()
except KeyboardInterrupt:
    print("\nStopped.")
finally:
    device.close()
