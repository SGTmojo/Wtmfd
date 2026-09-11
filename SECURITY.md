# Security Notes

This tool runs a local HTTP server (`serve.py`) that's reachable from
other devices on your network, so it's worth understanding what it does
and doesn't protect against before running it.

## What serve.py exposes

When running, `serve.py` listens on `0.0.0.0` (all network interfaces,
not just localhost) on port 8000 (or the next free port). This is
**intentional** — it's how the phone/tablet access feature works. It
means:

- Any device on the **same WiFi network** can reach it at
  `http://<your-ip>:<port>/`
- It serves the MFD page, proxies War Thunder telemetry, and accepts
  virtual gamepad button presses and controls-file bind requests

## What's protected

- **CORS is scoped to the extension only.** As of this version, only
  requests with a `moz-extension://` (or `chrome-extension://`) Origin
  get a CORS response. A random website you visit in your browser can no
  longer silently `fetch()` these endpoints and press buttons or read
  your telemetry — browsers block cross-origin requests without a
  matching CORS header.

## What's NOT protected

- **No authentication.** Any device already on your network can directly
  make HTTP requests to these endpoints (curl, a script, another
  browser tab typing the URL directly) — CORS only stops in-browser
  JavaScript running on a *different* site, it does not stop a device
  that talks to the server directly.
- **No encryption.** Everything is plain HTTP. Someone passively
  monitoring the same network (e.g. a compromised router, or on
  untrusted/public WiFi) could see your telemetry traffic and gamepad
  commands.
- **No rate limiting.**

## Practical recommendation

**Only run this on a trusted home network.** Do not run `serve.py` on
public WiFi (coffee shops, airports, hotels) or any network you don't
control. If you want remote access outside your home network, use a VPN
into your home network rather than exposing the port directly — never
port-forward this to the public internet.

## What an attacker could actually do

With the above caveats, the realistic worst case for someone else on
your LAN is: pressing your virtual gamepad buttons (whatever those are
bound to in War Thunder), reading your current match's telemetry
(speed/altitude/position - not your account or any personal data), or
triggering a controls-file bind (writes a file inside this project's own
`controls/` folder, nothing outside it). There's no code execution, no
file access outside the `controls/` folder, and no access to anything
else on your machine.

## Reporting an issue

If you find something not covered here, open a GitHub issue.
