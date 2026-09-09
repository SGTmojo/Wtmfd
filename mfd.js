// v70
const FAST_POLL_MS = 250;
const SLOW_POLL_MS = 500;
// Safe even outside an extension context (unlike the old version, which
// referenced `chrome` directly without a typeof guard - that throws a
// ReferenceError immediately if NEITHER browser nor chrome exist, which
// is exactly the case when mfd.html is opened as a plain webpage, e.g.
// on a phone via the mfd/serve.py helper - crashing the whole script
// before anything else could even run).
const extensionApi = (typeof browser !== "undefined") ? browser
    : (typeof chrome !== "undefined") ? chrome
    : null;
// runtime.id only exists when actually running inside an installed
// extension - a reliable way to tell "real extension" apart from "plain
// webpage that happens to be served over http/https".
const IS_EXTENSION_CONTEXT = !!(extensionApi && extensionApi.runtime && extensionApi.runtime.id);

// Telemetry API base URL. Inside the real extension, this is always
// localhost (the extension and the game run on the same machine).
// Outside it - i.e. opened as a plain webpage, which is how the phone
// setup works (see mfd/serve.py) - default to the page's OWN origin,
// since that little proxy server both serves these files AND re-exposes
// War Thunder's telemetry under itself (sidesteps CORS and the "does WT
// accept non-localhost connections" question entirely, since the proxy
// always talks to the game via true localhost on the Deck itself).
// A manual override is still available via the Telemetry Host field in
// the sidebar for anyone who needs something different.
const DEFAULT_BASE = IS_EXTENSION_CONTEXT ? "http://localhost:8111" : window.location.origin;
// Gamepad presses ALWAYS go to serve.py, never to War Thunder directly.
// In extension context (Deck), serve.py is on localhost but a different
// port than WT's 8111 — we discover it from the saved telemetry host if
// it looks like a serve.py URL, otherwise fall back to the page's own
// origin (which IS serve.py when loaded on a phone via http).
// In non-extension context (phone), window.location.origin is always
// serve.py since that's what served the page.
const GAMEPAD_BASE = IS_EXTENSION_CONTEXT ? null : window.location.origin;

// Turns whatever the person typed into the Telemetry Host field into a
// real base URL. Accepts a full URL ("http://192.168.1.42:8080") or just
// a bare host/IP ("192.168.1.42") - a bare host with no port defaults to
// WT's standard 8111 (the common case: pointing this AT the machine
// actually running the game, on its normal port), not the port this page
// happened to load from.
function resolveTelemetryBase(rawInput) {
    const trimmed = (rawInput || "").trim();
    if (!trimmed) return DEFAULT_BASE;
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
        return trimmed.replace(/\/$/, "");
    }
    const hasPort = /:\d+$/.test(trimmed);
    return `http://${trimmed}${hasPort ? "" : ":8111"}`;
}

// Single source of truth is the RAW text the person typed (persisted as-
// is), not a separately-stored resolved URL - BASE is always derived
// fresh from it, so there's only one place this can get out of sync.
const savedTelemetryHostInput = localStorage.getItem("wtmfd_telemetry_host_input") || "";
let BASE = resolveTelemetryBase(savedTelemetryHostInput);
const MAP_META_POLL_MS = 1000;

const canvas = document.getElementById("map-canvas");
const ctx = canvas.getContext("2d");

// DOM Elements
const elStatus = document.getElementById("val-status");
const elSpeed = document.getElementById("val-speed");
const elAlt = document.getElementById("val-alt");
const elRadar = document.getElementById("val-radar");
const elPlayerLock = document.getElementById("val-player-lock");
const elRangeInfo = document.getElementById("val-range-info");
const elThreat = document.getElementById("val-threat");
const elAirThreat = document.getElementById("val-air-threat");
const checkSixBlip = document.getElementById("check-six-blip");
const elTarget = document.getElementById("val-target");
const elInRange = document.getElementById("val-in-range");
const elVyRaw = document.getElementById("val-vy-raw");
const elV0 = document.getElementById("val-v0");
const elReleaseAlt = document.getElementById("val-release-alt");
const elZoom = document.getElementById("val-zoom");
const elSpanX = document.getElementById("val-span-x");
const elYScale = document.getElementById("val-yscale");
const elRawMeasure = document.getElementById("val-raw-measure");
const inputTrueDistance = document.getElementById("input-true-distance");
const inputCalibAltitude = document.getElementById("input-calib-altitude");
const btnAddCalibrationPoint = document.getElementById("btn-add-calibration-point");
const calibrationPointsListEl = document.getElementById("calibration-points-list");
const elCalibrationFactor = document.getElementById("val-calibration-factor");
const btnRecalibrateMap = document.getElementById("btn-recalibrate-map");
const chkAutoCalibrate = document.getElementById("chk-auto-calibrate");

const selCountry = document.getElementById("sel-country");
const selWeapon = document.getElementById("sel-weapon");
const selVehicle = document.getElementById("sel-vehicle");
const elVehicleSource = document.getElementById("val-vehicle-source");

const chkAA = document.getElementById("chk-aa-rings");
const chkFriendlyAA = document.getElementById("chk-friendly-aa");
const chkRangeArc = document.getElementById("chk-range-arc");
const chkBombCCIP = document.getElementById("chk-bomb-ccip");
const chkDynamicRange = document.getElementById("chk-dynamic-range");
const chkGridOverlay = document.getElementById("chk-grid-overlay");
const chkDebugLog = document.getElementById("chk-debug-log");
const chkShowFriendlyForces = document.getElementById("chk-show-friendly-forces");
const chkShowEnemyForces = document.getElementById("chk-show-enemy-forces");

const btnCenterPlayer = document.getElementById("btn-center-player");
const btnResetView = document.getElementById("btn-reset-view");
const btnClearMeasurer = document.getElementById("btn-clear-measurer");
const btnToggleView = document.getElementById("btn-toggle-view");

// Declared here (not down near where they're mainly used) because
// updateViewModeUI() below reads them immediately on script load
// (see the unconditional call a few lines down) - a `let` declared
// later in the file is in the "temporal dead zone" until execution
// reaches it, which was throwing "can't access lexical declaration
// before initialization" the moment the page loaded.
let viewMode = "map"; // "map" | "weapon" | "controls"

const controlsPageOverlay = document.getElementById("controls-page-overlay");
const elSidebar = document.getElementById("sidebar");
const btnBackToMap = document.getElementById("btn-back-to-map");

function updateViewModeUI() {
    if (btnToggleView) {
        btnToggleView.textContent = viewMode === "map" ? "SWITCH TO WEAPON MFD VIEW"
            : viewMode === "weapon" ? "SWITCH TO CONTROLS VIEW"
            : "SWITCH TO MAP VIEW";
    }
    if (controlsPageOverlay) controlsPageOverlay.style.display = viewMode === "controls" ? "grid" : "none";
    // The MFD/Controls page is a full-screen self-contained bezel - the
    // regular sidebar (weapon profile, map controls, telemetry, etc.)
    // doesn't apply there and just gets in the way, so it's hidden for
    // as long as this page is showing. btn-back-to-map is the only way
    // back while it's hidden (see #mode-controls in mfd.html).
    if (elSidebar) elSidebar.style.display = viewMode === "controls" ? "none" : "";
    if (btnBackToMap) btnBackToMap.style.display = viewMode === "controls" ? "flex" : "none";
}

function setViewMode(mode) {
    viewMode = mode;
    updateViewModeUI();
}

if (btnToggleView) {
    btnToggleView.addEventListener("click", () => {
        setViewMode(viewMode === "map" ? "weapon"
            : viewMode === "weapon" ? "controls"
            : "map");
    });
}
if (btnBackToMap) {
    btnBackToMap.addEventListener("click", () => setViewMode("map"));
}
updateViewModeUI();
const btnToggleDrawer = document.getElementById("btn-toggle-drawer");
const topToolbar = document.getElementById("top-toolbar");
const toolbarLeft = document.getElementById("toolbar-left");
const toolbarCenter = document.getElementById("toolbar-center");
const toolbarRight = document.getElementById("toolbar-right");
const primaryStatusRow = document.getElementById("primary-status-row");
const airThreatRow = document.getElementById("air-threat-row");
const btnFullscreen = document.getElementById("btn-fullscreen");
const btnLayoutToggle = document.getElementById("btn-layout-toggle");
const btnToggleTouchMeasure = document.getElementById("btn-toggle-touch-measure");
const chkLargeText = document.getElementById("chk-large-text");
const inputTelemetryHost = document.getElementById("input-telemetry-host");
const elTelemetryHostInfo = document.getElementById("val-telemetry-host-info");
const btnReconnect = document.getElementById("btn-reconnect");

if (btnReconnect) {
    btnReconnect.addEventListener("click", () => {
        // Re-resolve BASE from whatever's currently in the IP field, in
        // case the person just fixed a typo there and wants to retry
        // immediately rather than wait for the next automatic poll tick.
        //
        // Deliberately does NOT call pollFast() directly here - pollFast
        // re-schedules its own next call via setTimeout every time it
        // runs, so calling it manually while the existing loop is also
        // already scheduled would spawn a second, parallel polling chain
        // that never stops (and gets worse with every additional click).
        // The already-running loop picks up this BASE change on its very
        // next tick regardless (within 250ms - imperceptible), so there's
        // nothing to gain from forcing an extra call, only risk.
        BASE = resolveTelemetryBase(inputTelemetryHost?.value ?? "");
        updateTelemetryHostInfo();
        elStatus.textContent = "RECONNECTING...";
        elStatus.style.color = "#ffaa00";
    });
}

function updateTelemetryHostInfo() {
    if (elTelemetryHostInfo) elTelemetryHostInfo.textContent = `Using: ${BASE}`;
}
if (inputTelemetryHost) {
    inputTelemetryHost.value = savedTelemetryHostInput;
    updateTelemetryHostInfo();
    inputTelemetryHost.addEventListener("change", () => {
        localStorage.setItem("wtmfd_telemetry_host_input", inputTelemetryHost.value);
        BASE = resolveTelemetryBase(inputTelemetryHost.value);
        updateTelemetryHostInfo();
        isConnected = false; // force the status readout to re-evaluate against the new host right away
    });
}

// ---------- Gamepad controls (Deck-side only, requires serve.py) ----------
// Only meaningful when this page is being served by serve.py on the Deck
// itself (never inside the Firefox extension, and never useful from a
// phone - the phone isn't running the game). Each button here presses one
// virtual gamepad button; what that DOES in-game is entirely up to
// whatever you've bound it to in War Thunder's own Controls settings -
// this only ever presses what's tapped, on tap, nothing automated.
//
// HISTORY (three iterations to get here):
//   1. Virtual gamepad spoofing a real Xbox 360 controller's exact
//      identity - collided with an actual physical controller.
//   2. Virtual KEYBOARD instead - worked in the Controls binding menu,
//      but never actually registered during real gameplay (Wine likely
//      reads DirectInput keyboard input through a separate path than
//      normal windowing key events).
//   3. Back to a virtual gamepad, but with a generic, non-spoofed
//      identity - confirmed via direct testing to both bind AND actually
//      move Gear/Flaps in a live test flight. Also backed by real-world
//      precedent: War Thunder players have used vJoy (Windows'
//      equivalent) via Joystick Gremlin in real gameplay for years.
const GAMEPAD_BUTTON_CODES = Array.from({ length: 20 }, (_, i) => `H${i + 1}`);

// Sensible starting labels for common flight actions, shown instead of
// raw button codes - purely cosmetic (renamed via double-click either
// here or on the dedicated Controls page, see below) since the actual
// in-game action is always whatever's bound in War Thunder's own Controls
// settings, not anything this tool controls. Grouped to match the 3-page
// bezel layout below (5 / 7 / 8 buttons - all 20 codes used, no page left
// over).
const DEFAULT_GAMEPAD_LABELS = {
    // FLIGHT (5)
    H1: "GEAR", H2: "FLAPS UP", H3: "FLAPS DOWN", H4: "COCKPIT LIGHT", H5: "NVG MODE",
    // WEAPONS (7)
    H6: "PRIMARY WPN", H7: "SECONDARY WPN", H8: "SEC RIPPLE QTY", H9: "LASER DESIG",
    H10: "DEACT TGT PT", H11: "BALLISTIC CPU (RKT)", H12: "BALLISTIC CPU (GUN)",
    // RADAR (8)
    H13: "RADAR PWR", H14: "RADAR RANGE", H15: "RADAR SCOPE", H16: "RADAR MODE",
    H17: "IRST TOGGLE", H18: "SEARCH MODE", H19: "RADAR STAB", H20: "RTN TO BORE",
};

// The 3 pages for the dedicated Controls page - each a real, independent
// set of buttons/outputs (not the same handful reused with different
// labels), matching the BTN_TRIGGER_HAPPY1-20 range confirmed working.
// 5 + 7 + 8 = 20, using every code exactly once. Renaming a button here
// only changes the on-screen label - if you move a function to a
// different H-code you still need to rebind that H-number in WT's own
// Controls settings to match.
const GAMEPAD_PAGES = [
    { title: "FLIGHT", codes: ["H1", "H2", "H3", "H4", "H5"] },
    { title: "WEAPONS", codes: ["H6", "H7", "H8", "H9", "H10", "H11", "H12"] },
    { title: "RADAR", codes: ["H13", "H14", "H15", "H16", "H17", "H18", "H19", "H20"] },
];

// LEFT is always filled first (up to LEFT_CAPACITY), BOTTOM only gets
// whatever overflows past that - RIGHT isn't used at all anymore (see
// createTabButton/renderControlsPage: the top edge is now the page-tab
// row). Capacities are fixed across all 3 pages so the bezel's shape
// never changes when you switch pages - a page with fewer buttons than
// capacity just leaves the remaining slots as visible, disabled
// placeholders (see createDisabledBezelSlot) instead of the layout
// shrinking around it.
const LEFT_CAPACITY = 5;
const BOTTOM_CAPACITY = Math.max(0, Math.max(...GAMEPAD_PAGES.map(p => p.codes.length)) - LEFT_CAPACITY);

function distributeToBezelEdges(codes) {
    return {
        left: codes.slice(0, LEFT_CAPACITY),
        bottom: codes.slice(LEFT_CAPACITY, LEFT_CAPACITY + BOTTOM_CAPACITY),
    };
}

// (gamepad-button-grid and val-gamepad-status removed from sidebar in v66 —
// buttons now live on the MFD Controls page, status goes to console.warn)

function getGamepadButtonLabel(code) {
    return localStorage.getItem(`wtmfd_gamepad_label_${code}`) || DEFAULT_GAMEPAD_LABELS[code] || code;
}

// Updates EVERY on-screen instance of this button's label at once (the
// sidebar's compact grid AND the dedicated Controls page both show the
// same button, so renaming in either place needs to update both -
// otherwise they'd silently drift out of sync with each other).
function renameGamepadButton(code) {
    const current = getGamepadButtonLabel(code);
    const next = prompt(`Label for button "${code}" (shown here only - doesn't change what it does):`, current);
    if (next !== null && next.trim()) {
        localStorage.setItem(`wtmfd_gamepad_label_${code}`, next.trim());
        document.querySelectorAll(`[data-gamepad-code="${code}"]`).forEach(el => {
            el.textContent = next.trim();
        });
    }
}

async function pressGamepadButton(code) {
    console.log(`[GAMEPAD] pressGamepadButton called: ${code}`);
    // GAMEPAD_BASE is non-null when loaded via serve.py (phone). In
    // extension context it's null — the extension talks to WT on 8111
    // for telemetry but serve.py (gamepad) is on a different port.
    // Use the telemetry host if it points at serve.py (non-8111 port),
    // otherwise try common serve.py ports on localhost.
    let base = GAMEPAD_BASE;
    if (!base) {
        // Extension context: BASE points at WT (port 8111), not serve.py.
        // Try the resolved telemetry host if user entered one with a
        // non-8111 port (that's serve.py), otherwise assume localhost:8000.
        if (BASE && !BASE.includes(":8111")) {
            base = BASE;
        } else {
            base = "http://localhost:8000";
        }
    }
    try {
        const url = `${base}/gamepad/press/${code}`;
        console.log(`[GAMEPAD] fetching: ${url}`);
        const res = await fetch(url);
        const text = await res.text();
        if (!res.ok) console.warn(`[GAMEPAD] ${code}: ${text}`);
    } catch (err) {
        console.warn(`[GAMEPAD] ${code}: fetch failed -`, err.message);
    }
}

// Builds one button element for a given code - shared by both the
// sidebar's compact grid and the dedicated Controls page, so they always
// stay visually and behaviorally identical (same label source, same
// press/rename logic) rather than two separate implementations that
// could quietly diverge over time.
function createGamepadButton(code) {
    const btn = document.createElement("button");
    btn.textContent = getGamepadButtonLabel(code);
    btn.dataset.gamepadCode = code; // lets renameGamepadButton find every instance of this button
    btn.title = `Virtual gamepad button: ${code}. Double-click to rename.`;
    btn.addEventListener("click", () => pressGamepadButton(code));
    btn.addEventListener("dblclick", () => renameGamepadButton(code));
    return btn;
}

// Sidebar gamepad button grid removed — buttons now live on the MFD
// Controls page (see renderControlsPage). createGamepadButton is kept
// because it's reused by the Controls page's createFunctionalButton.

// ---------- Gear button state (Flight page) ----------
// WT's own ID_GEAR is a single TOGGLE action (confirmed from a real
// exported controls.blk - one binding, not separate up/down commands),
// so every tap just sends one H1 press and flips our own tracked state.
// The LED reflects OUR OWN last-commanded state, NOT confirmed real gear
// position - there's no telemetry field for actual gear state, so this
// is "what we last told it to do", shown amber briefly (in transit) then
// settling to green/dark, same convention as a real gear indicator.
function getGearLeverState() {
    return localStorage.getItem("wtmfd_gear_lever_state") || "up";
}
function toggleGearState() {
    const newState = getGearLeverState() === "down" ? "up" : "down";
    localStorage.setItem("wtmfd_gear_lever_state", newState);
    return newState;
}

// ---------- Bezel MFD (the uploaded "Modern Tactical MFD" asset,
// wired up as the actual screen content - not a style reference) ----------
// TOP edge = the 3 page tabs (FLIGHT/WEAPONS/RADAR). LEFT edge = that
// page's gamepad buttons, overflowing to BOTTOM once LEFT_CAPACITY is
// used up. No right edge. The screen itself shows real data per page -
// FLIGHT and WEAPONS reuse the asset's list/grid layout verbatim, just
// populated from true telemetry instead of the asset's placeholder
// content; RADAR is the one part rebuilt visually, since that's the
// only piece explicitly called out as changeable - the sweep now plots
// real nearby contacts instead of 3 fixed fake ones.
const controlsPageContent = document.getElementById("controls-page-content");
let currentControlsPage = localStorage.getItem("wtmfd_controls_page") || GAMEPAD_PAGES[0].title;

// Percent-of-edge position for slot `i` of `count`, evenly spaced with
// margin on both ends (never flush against a corner) - same scheme the
// original asset used for its 3 top-edge and 3 bottom-edge buttons.
function edgeSlotPercent(i, count) {
    return ((i + 1) / (count + 1)) * 100;
}

function createFunctionalButton(code, edge, index, count) {
    const btn = document.createElement("button");
    btn.className = `mfd-bezel-square mfd-bezel-square-${edge}`;
    if (edge === "left") btn.style.top = `${edgeSlotPercent(index, count)}%`;
    else btn.style.left = `${edgeSlotPercent(index, count)}%`;
    btn.title = `Virtual gamepad button: ${code}. Double-click to rename.`;
    btn.dataset.gamepadCode = code;

    const isGear = code === "H1" && currentControlsPage === "FLIGHT";
    if (isGear) {
        const led = document.createElement("span");
        led.className = "mfd-bezel-led";
        btn.appendChild(led);
        const labelSpan = document.createElement("span");
        labelSpan.textContent = getGamepadButtonLabel(code);
        btn.appendChild(labelSpan);
        const setLed = (state, transitioning) => {
            led.classList.toggle("mfd-bezel-led-transition", !!transitioning);
            led.classList.toggle("mfd-bezel-led-down", state === "down" && !transitioning);
            led.classList.toggle("mfd-bezel-led-up", state === "up" && !transitioning);
        };
        setLed(getGearLeverState(), false);
        btn.addEventListener("click", () => {
            const newState = toggleGearState();
            setLed(newState, true);
            pressGamepadButton("H1");
            setTimeout(() => setLed(newState, false), 600);
        });
    } else {
        btn.textContent = getGamepadButtonLabel(code);
        btn.addEventListener("click", () => pressGamepadButton(code));
    }
    btn.addEventListener("dblclick", () => renameGamepadButton(code));
    return btn;
}

// Top-edge OSB that SWITCHES PAGES instead of pressing a gamepad button.
function createTabButton(page, index, count) {
    const btn = document.createElement("button");
    btn.className = "mfd-bezel-square mfd-bezel-square-top mfd-bezel-tab-square";
    btn.style.left = `${edgeSlotPercent(index, count)}%`;
    btn.textContent = page.title;
    btn.title = `Switch to ${page.title} page`;
    btn.classList.toggle("active", page.title === currentControlsPage);
    btn.addEventListener("click", () => {
        currentControlsPage = page.title;
        localStorage.setItem("wtmfd_controls_page", page.title);
        renderControlsPage();
    });
    return btn;
}

// A visible-but-inert placeholder for an edge slot the current page
// doesn't use (e.g. FLIGHT only fills 5 of the 8 left+bottom slots) -
// keeps the bezel's shape constant across pages, per "leftover buttons
// should still appear, just be non-functional."
function createDisabledSlot(edge, index, count) {
    const btn = document.createElement("button");
    btn.className = `mfd-bezel-square mfd-bezel-square-${edge} mfd-bezel-square-disabled`;
    if (edge === "left") btn.style.top = `${edgeSlotPercent(index, count)}%`;
    else btn.style.left = `${edgeSlotPercent(index, count)}%`;
    btn.textContent = "—";
    btn.disabled = true;
    btn.tabIndex = -1;
    btn.setAttribute("aria-hidden", "true");
    return btn;
}

// ---------- Real telemetry readers for the MFD screen ----------
// Same confirmed /state field names the old instrument panel used
// ("H, m", "IAS, km/h", etc.) - kept minimal since the screen only needs
// a handful of values, not a full gauge set.
function getMfdTelemetry() {
    const s = latestState || {};
    const ind = latestIndicators || {};
    return {
        altitude: s["H, m"] ?? 0,
        iasKmh: s["IAS, km/h"] ?? s["TAS, km/h"] ?? 0,
        headingDeg: Number(ind["compass"] ?? ind["compass1"] ?? ind["heading"]) || 0,
        gearPct: s["gear, %"] ?? 0,
        flapsPct: s["flaps, %"] ?? 0,
        airbrakePct: s["airbrake, %"] ?? 0,
        vy: s["Vy, m/s"] ?? 0,
        valid: isConnected && s["valid"] !== false,
    };
}

function buildScreen(page) {
    const screen = document.createElement("div");
    screen.className = "mfd-screen";

    const header = document.createElement("div");
    header.className = "mfd-header";
    header.innerHTML = `
        <div>SPD: <span id="mfd-tele-spd">-</span> KM/H</div>
        <div>ALT: <span id="mfd-tele-alt">-</span> M</div>
        <div>HDG: <span id="mfd-tele-hdg">-</span>&deg;</div>`;
    screen.appendChild(header);

    if (page.title === "RADAR") {
        const view = document.createElement("div");
        view.className = "mfd-view active";
        const canvas = document.createElement("canvas");
        canvas.id = "mfd-radar-canvas";
        view.appendChild(canvas);
        screen.appendChild(view);
    } else if (page.title === "WEAPONS") {
        const view = document.createElement("div");
        view.className = "mfd-view active";
        view.innerHTML = `
            <div style="font-size:14px; font-weight:bold; margin-top:36px;">STORES MANAGEMENT</div>
            <div class="weapon-grid" id="mfd-weapon-grid"></div>`;
        screen.appendChild(view);
    } else {
        const view = document.createElement("div");
        view.className = "mfd-view active";
        view.innerHTML = `
            <div style="font-size:14px; font-weight:bold; margin-top:36px;">FLIGHT STATUS</div>
            <div class="controls-list" id="mfd-flight-list"></div>`;
        screen.appendChild(view);
    }

    return screen;
}

// ---------- Live per-frame update (header + whichever view is showing)
// - called from render() below while viewMode === "controls", separate
// from renderControlsPage() so switching pages/tabs doesn't fight with
// live telemetry redrawing every frame. ----------
function updateControlsScreenLive() {
    const t = getMfdTelemetry();
    const elSpd = document.getElementById("mfd-tele-spd");
    const elAlt = document.getElementById("mfd-tele-alt");
    const elHdg = document.getElementById("mfd-tele-hdg");
    if (elSpd) elSpd.textContent = t.valid ? Math.round(t.iasKmh) : "-";
    if (elAlt) elAlt.textContent = t.valid ? Math.round(t.altitude).toLocaleString() : "-";
    if (elHdg) elHdg.textContent = t.valid ? Math.round(t.headingDeg).toString().padStart(3, "0") : "-";

    if (currentControlsPage === "RADAR") {
        drawControlsRadar(t);
    } else if (currentControlsPage === "WEAPONS") {
        updateControlsWeaponGrid(t);
    } else if (currentControlsPage === "FLIGHT") {
        updateControlsFlightList(t);
    }
}

function updateControlsWeaponGrid(t) {
    const grid = document.getElementById("mfd-weapon-grid");
    if (!grid) return;
    const vehicleName = selVehicle?.value || "NO VEHICLE SELECTED";
    const weaponName = selWeapon?.value || "-";
    const rangeText = elRangeInfo?.textContent || "-";
    const ready = t.valid;
    grid.innerHTML = `
        <div class="weapon-card selected">
            <div class="weapon-title">${vehicleName}</div>
            <div class="status-tag ${ready ? "status-ready" : ""}">STATUS: ${ready ? "TELEMETRY LIVE" : "NO TELEMETRY"}</div>
        </div>
        <div class="weapon-card">
            <div class="weapon-title">${weaponName}</div>
            <div>${rangeText}</div>
        </div>`;
}

function updateControlsFlightList(t) {
    const list = document.getElementById("mfd-flight-list");
    if (!list) return;
    const gearDown = t.gearPct > 50;
    list.innerHTML = `
        <div class="control-row"><span>GEAR</span><span>${t.valid ? (gearDown ? "DOWN" : "UP") + ` (${Math.round(t.gearPct)}%)` : "-"}</span></div>
        <div class="control-row"><span>FLAPS</span><span>${t.valid ? Math.round(t.flapsPct) + "%" : "-"}</span></div>
        <div class="control-row"><span>AIRBRAKE</span><span>${t.valid ? Math.round(t.airbrakePct) + "%" : "-"}</span></div>
        <div class="control-row"><span>VERTICAL SPEED</span><span>${t.valid ? t.vy.toFixed(1) + " M/S" : "-"}</span></div>`;
}

// Sweeping radar view - the one part of the uploaded asset explicitly
// meant to change visually. Keeps the rotating sweep + range rings, but
// every contact plotted is a REAL nearby map object, using the exact
// same bearing math as the check-six indicator above (relBearingRad: 0 =
// dead ahead/top, +-PI = dead astern/bottom) so both stay consistent.
let controlsRadarSweepAngle = 0;
const CONTROLS_RADAR_RANGE_M = 15000; // 15km scope range - not user-configurable yet

function drawControlsRadar(t) {
    const canvas = document.getElementById("mfd-radar-canvas");
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (canvas.width !== parent.clientWidth) canvas.width = parent.clientWidth;
    if (canvas.height !== parent.clientHeight) canvas.height = parent.clientHeight;
    const ctx2 = canvas.getContext("2d");
    ctx2.clearRect(0, 0, canvas.width, canvas.height);

    const cX = canvas.width / 2;
    const cY = canvas.height / 2;
    const maxR = Math.min(cX, cY) - 20;
    if (maxR <= 0) return;

    const playerObj = findPlayerObject();
    if (!isConnected || !playerObj) {
        ctx2.fillStyle = "rgba(255, 170, 0, 0.6)";
        ctx2.font = "12px monospace";
        ctx2.textAlign = "center";
        ctx2.fillText("NO TELEMETRY", cX, cY);
        return;
    }

    // Range rings + crosshairs
    ctx2.strokeStyle = "rgba(0, 255, 102, 0.18)";
    ctx2.lineWidth = 1;
    for (let i = 1; i <= 3; i++) {
        ctx2.beginPath();
        ctx2.arc(cX, cY, (maxR / 3) * i, 0, Math.PI * 2);
        ctx2.stroke();
    }
    ctx2.beginPath();
    ctx2.moveTo(cX - maxR, cY); ctx2.lineTo(cX + maxR, cY);
    ctx2.moveTo(cX, cY - maxR); ctx2.lineTo(cX, cY + maxR);
    ctx2.stroke();

    // Sweep line
    controlsRadarSweepAngle += 0.02;
    if (controlsRadarSweepAngle > Math.PI * 2) controlsRadarSweepAngle = 0;
    ctx2.beginPath();
    ctx2.moveTo(cX, cY);
    ctx2.lineTo(cX + Math.cos(controlsRadarSweepAngle) * maxR, cY + Math.sin(controlsRadarSweepAngle) * maxR);
    ctx2.strokeStyle = "rgba(0, 255, 102, 0.8)";
    ctx2.stroke();

    // Real contacts, nose-up (same convention as the check-six indicator).
    if (typeof playerObj.dx === "number" && typeof playerObj.dy === "number") {
        const playerHeadingRad = Math.atan2(playerObj.dy, playerObj.dx);
        const mapSpanMeters = currentMapSpanMeters || getMapSpanXMeters();

        for (const obj of latestMapObj) {
            if (obj === playerObj || typeof obj.x !== "number") continue;
            const dx = obj.x - playerObj.x;
            const dy = obj.y - playerObj.y;
            const distMeters = Math.hypot(dx, dy) * mapSpanMeters;
            if (distMeters > CONTROLS_RADAR_RANGE_M) continue;

            const bearingRad = Math.atan2(dy, dx);
            let relBearingRad = bearingRad - playerHeadingRad;
            while (relBearingRad > Math.PI) relBearingRad -= 2 * Math.PI;
            while (relBearingRad < -Math.PI) relBearingRad += 2 * Math.PI;

            const r = (distMeters / CONTROLS_RADAR_RANGE_M) * maxR;
            const tx = cX + r * Math.sin(relBearingRad);
            const ty = cY - r * Math.cos(relBearingRad);

            const team = classifyTeam(obj);
            ctx2.strokeStyle = team === "enemy" ? "#ff3366" : team === "friendly" ? "#00ff66" : "#8b9bb4";
            ctx2.strokeRect(tx - 5, ty - 5, 10, 10);
            ctx2.fillStyle = ctx2.strokeStyle;
            ctx2.font = "9px monospace";
            ctx2.textAlign = "left";
            ctx2.fillText(obj.icon || "?", tx + 7, ty + 3);
        }
    }

    // Player marker, dead center, nose pointing up.
    ctx2.fillStyle = "#00ff66";
    ctx2.beginPath();
    ctx2.moveTo(cX, cY - 6);
    ctx2.lineTo(cX - 4, cY + 5);
    ctx2.lineTo(cX + 4, cY + 5);
    ctx2.closePath();
    ctx2.fill();
}

function renderControlsPage() {
    if (!controlsPageContent) return;
    controlsPageContent.innerHTML = "";
    const page = GAMEPAD_PAGES.find(p => p.title === currentControlsPage) || GAMEPAD_PAGES[0];
    const edges = distributeToBezelEdges(page.codes);

    const frame = document.createElement("div");
    frame.className = "mfd-bezel-frame";

    GAMEPAD_PAGES.forEach((p, i) => frame.appendChild(createTabButton(p, i, GAMEPAD_PAGES.length)));

    for (let i = 0; i < LEFT_CAPACITY; i++) {
        frame.appendChild(edges.left[i]
            ? createFunctionalButton(edges.left[i], "left", i, LEFT_CAPACITY)
            : createDisabledSlot("left", i, LEFT_CAPACITY));
    }
    for (let i = 0; i < BOTTOM_CAPACITY; i++) {
        frame.appendChild(edges.bottom[i]
            ? createFunctionalButton(edges.bottom[i], "bottom", i, BOTTOM_CAPACITY)
            : createDisabledSlot("bottom", i, BOTTOM_CAPACITY));
    }
    // No right edge - every functional button lives on the left,
    // overflowing to the bottom (see LEFT_CAPACITY/BOTTOM_CAPACITY).

    frame.appendChild(buildScreen(page));
    controlsPageContent.appendChild(frame);
    // updateControlsScreenLive is called per-frame from render() once the
    // poll loops are running - do NOT call it here during the initial
    // renderControlsPage() at script load, since isConnected/latestMapObj/
    // etc. aren't declared yet (they're `let` further down the file, so
    // referencing them from here would be a temporal-dead-zone crash that
    // kills the entire script before render() even gets defined).
}

renderControlsPage();

// ---------- Controls File Auto-Bind (folder-based, requires serve.py) ----------
const btnBlkBind = document.getElementById("btn-blk-bind");
const elBlkStatus = document.getElementById("val-blk-status");
const blkTargetIdGrid = document.getElementById("blk-target-id-grid");
const btnBlkSaveIds = document.getElementById("btn-blk-save-ids");

function setBlkStatus(text, ok) {
    if (!elBlkStatus) return;
    elBlkStatus.textContent = text;
    elBlkStatus.style.color = ok ? "#00ffcc" : "#ff3366";
}

async function refreshBlkStatus() {
    if (!elBlkStatus) return;
    try {
        const res = await fetch(`${GAMEPAD_BASE || BASE}/blk/status`);
        const data = await res.json();
        const file = data.source_file;
        setBlkStatus(file ? `Ready — found ${file}` : "No .blk in controls/ folder yet.", !!file);
        if (blkTargetIdGrid) {
            blkTargetIdGrid.innerHTML = "";
            for (const code of data.button_codes) {
                const label = document.createElement("div");
                label.textContent = code;
                label.style.color = "#8b9bb4";
                blkTargetIdGrid.appendChild(label);
                const input = document.createElement("input");
                input.type = "text";
                input.dataset.code = code;
                input.value = data.target_ids[code] || "";
                input.placeholder = "ID_...";
                blkTargetIdGrid.appendChild(input);
            }
        }
    } catch (err) {
        setBlkStatus("Server unreachable — is serve.py running?", false);
    }
}
refreshBlkStatus();

if (btnBlkBind) {
    btnBlkBind.addEventListener("click", async () => {
        setBlkStatus("Binding...", true);
        try {
            const res = await fetch(`${GAMEPAD_BASE || BASE}/blk/bind`, { method: "POST", body: "{}" });
            const data = await res.json();
            setBlkStatus(data.message, data.ok);
        } catch (err) {
            setBlkStatus("Failed — is serve.py running?", false);
        }
    });
}

if (btnBlkSaveIds) {
    btnBlkSaveIds.addEventListener("click", async () => {
        if (!blkTargetIdGrid) return;
        const target_ids = {};
        blkTargetIdGrid.querySelectorAll("input[data-code]").forEach(input => {
            target_ids[input.dataset.code] = input.value;
        });
        try {
            const res = await fetch(`${GAMEPAD_BASE || BASE}/blk/settings`, { method: "POST", body: JSON.stringify({ target_ids }) });
            const data = await res.json();
            setBlkStatus(data.ok ? "Saved." : data.message, data.ok);
        } catch (err) {
            setBlkStatus("Save failed — is serve.py running?", false);
        }
    });
}

// Create or hook up Follow Toggle Button dynamically if not in HTML
let btnToggleFollow = document.getElementById("btn-toggle-follow");
if (!btnToggleFollow) {
    btnToggleFollow = document.createElement("button");
    btnToggleFollow.id = "btn-toggle-follow";
    btnToggleFollow.textContent = "FOLLOW JET: ON";
    btnToggleFollow.style.cssText = "background: #00ffcc; color: #080c14; border: none; padding: 6px 12px; font-weight: bold; cursor: pointer; border-radius: 4px; font-family: monospace; font-size: 11px;";
    if (btnCenterPlayer && btnCenterPlayer.parentNode) {
        btnCenterPlayer.parentNode.insertBefore(btnToggleFollow, btnCenterPlayer.nextSibling);
    }
}

// Create Airfields Overlay Checkbox dynamically if missing
let chkAirfields = document.getElementById("chk-airfields");
if (!chkAirfields && chkAA && chkAA.parentNode) {
    const container = document.createElement("label");
    chkAirfields = document.createElement("input");
    chkAirfields.type = "checkbox";
    chkAirfields.id = "chk-airfields";
    chkAirfields.checked = true;
    container.appendChild(chkAirfields);
    container.appendChild(document.createTextNode("Show Airfields"));
    chkAA.parentNode.appendChild(container);
}

let isConnected = false;
let latestState = null;
let latestIndicators = null;
let latestMapObj = [];
let mapImage = null;
let mapInfo = null;
let currentMapGeneration = null;
let airfieldsList = [];
let seenObjectSignatures = new Set();

// Viewport State & Follow Cam Lock
let zoom = 1.0;
let panX = 0;
let panY = 0;
let isPanning = false;
let startPanX = 0;
let startPanY = 0;
let isJetCentered = true;

// Right-Click Measurement Tool State
let isMeasuring = false;
let measureStartWorld = null;
let measureCurrentWorld = null;
let activeMeasurement = null;
let lastRawMeasurementDelta = null; // {dx, dy} in raw world-fraction units

// Movement history tracking for AI heading calculations
const npcHistory = new Map();

// Called once per frame, before either view is drawn, so enemy headings
// stay fresh even while looking at the Weapon MFD screen (previously this
// only updated inside the map view's own icon-drawing loop, which meant
// heading data - and therefore anything that depends on it - went stale
// the moment you switched away from the map).
function updateNpcHeadings() {
    latestMapObj.forEach((obj, idx) => {
        if (typeof obj.x !== "number" || typeof obj.y !== "number") return;
        if (obj.type !== "aircraft") return;
        const entityId = obj.id || `npc_${idx}`;
        if (!npcHistory.has(entityId)) {
            npcHistory.set(entityId, { lastX: obj.x, lastY: obj.y, headingRad: 0 });
        }
        const history = npcHistory.get(entityId);
        const dx = obj.x - history.lastX;
        const dy = obj.y - history.lastY;
        if (Math.hypot(dx, dy) > 0.00005) {
            history.headingRad = Math.atan2(dy, dx);
            history.lastX = obj.x;
            history.lastY = obj.y;
        }
    });
    if (npcHistory.size > 0) {
        const presentIds = new Set(latestMapObj.map((o, idx) => o.id || `npc_${idx}`));
        for (const key of npcHistory.keys()) {
            if (!presentIds.has(key)) npcHistory.delete(key);
        }
    }
}

// Air-to-air threat tracking (separate from ground AA): since map_obj
// never tells us an enemy aircraft's actual loadout, "in his missile
// range" is approximated from proximity + whether he's roughly pointed
// at you (using the heading derived above) - the same two things a real
// RWR effectively infers. Tunable in weapons-config.js as AIR_THREAT_CONFIG.
let latestAirThreats = []; // [{obj, distMeters, bearingRad, severity}]

function computeAirThreats(playerObj) {
    latestAirThreats = [];
    if (!playerObj || typeof playerObj.x !== "number") return;
    const cfg = (typeof AIR_THREAT_CONFIG !== "undefined") ? AIR_THREAT_CONFIG : { checkSixRangeKm: 5, checkSixRearArcDeg: 180 };
    const mapSpanMeters = getMapSpanXMeters();

    // Player's own heading, straight from the map object's own dx/dy
    // heading vector (same field aircraft already carry, confirmed via
    // direct debug logging of the raw telemetry earlier in this project)
    // - NOT derived from the compass instrument, which is in a different
    // reference frame (true-north degrees) than this map's x/y fraction
    // space. Using dx/dy keeps the bearing-to-threat and player-heading
    // calculations in the exact same coordinate frame, so comparing them
    // directly is safe and doesn't need any cross-frame conversion that
    // could silently introduce a rotational offset bug.
    if (typeof playerObj.dx !== "number" || typeof playerObj.dy !== "number") return;
    const playerHeadingRad = Math.atan2(playerObj.dy, playerObj.dx);
    const rearArcRad = (cfg.checkSixRearArcDeg * Math.PI / 180) / 2; // half-angle from directly-behind

    for (let idx = 0; idx < latestMapObj.length; idx++) {
        const obj = latestMapObj[idx];
        if (obj === playerObj) continue;
        if (typeof obj.x !== "number" || obj.type !== "aircraft") continue;
        if (classifyTeam(obj) !== "enemy") continue;

        const dx = obj.x - playerObj.x;
        const dy = obj.y - playerObj.y;
        const distMeters = Math.hypot(dx, dy) * mapSpanMeters;
        if (distMeters > cfg.checkSixRangeKm * 1000) continue;

        // Bearing FROM the player TO this contact, in the same map-frame
        // convention as playerHeadingRad above.
        const bearingRad = Math.atan2(dy, dx);

        // How far off the player's SIX O'CLOCK (directly behind) is this
        // contact, not how far off the nose - normalized to (-PI, PI].
        let offBehind = bearingRad - (playerHeadingRad + Math.PI);
        while (offBehind > Math.PI) offBehind -= 2 * Math.PI;
        while (offBehind < -Math.PI) offBehind += 2 * Math.PI;

        // Only a real check-six threat if it's within the rear arc - e.g.
        // for the default 180 deg (full rear hemisphere), offBehind must
        // be within +-90 deg of dead-astern. A narrower configured arc
        // would require the contact to be more directly behind, not just
        // somewhere in the rear half.
        if (Math.abs(offBehind) > rearArcRad) continue;

        // Relative bearing from the player's OWN NOSE - this is what the
        // directional indicator actually plots (0 = dead ahead/top of the
        // display, 180 = dead astern/bottom), independent of the rear-arc
        // gate above which uses offBehind for the threshold check itself.
        let relBearingRad = bearingRad - playerHeadingRad;
        while (relBearingRad > Math.PI) relBearingRad -= 2 * Math.PI;
        while (relBearingRad < -Math.PI) relBearingRad += 2 * Math.PI;

        latestAirThreats.push({ obj, distMeters, bearingRad, relBearingRad, severity: "danger" });
    }
}

function updateAirThreatUI() {
    if (!elAirThreat) return;
    if (latestAirThreats.length === 0) {
        elAirThreat.textContent = "CLEAR";
        elAirThreat.className = "telemetry-val status-safe";
        if (checkSixBlip) checkSixBlip.style.display = "none";
        return;
    }
    // Nearest qualifying threat, not "worst by severity" - every entry
    // that made it into latestAirThreats already passed the same 5km +
    // rear-arc gate, so "closest" is the most meaningful thing to surface.
    const nearest = latestAirThreats.reduce((a, b) => (b.distMeters < a.distMeters ? b : a), latestAirThreats[0]);
    const label = nearest.obj.icon || "BANDIT";
    elAirThreat.textContent = `DANGER: ${label} ${(nearest.distMeters / 1000).toFixed(1)}KM`;
    elAirThreat.className = "telemetry-val status-danger";

    // Position the blip on the check-six indicator - nose/forward at the
    // TOP of the circle (standard RWR convention), clockwise from there.
    // relBearingRad: 0 = dead ahead (top), +-PI = dead astern (bottom).
    if (checkSixBlip) {
        const R = 9; // matches the circle radius drawn in the SVG markup
        const bx = 14 + R * Math.sin(nearest.relBearingRad);
        const by = 14 - R * Math.cos(nearest.relBearingRad);
        checkSixBlip.setAttribute("cx", bx.toFixed(1));
        checkSixBlip.setAttribute("cy", by.toFixed(1));
        checkSixBlip.style.display = "block";
    }
}

// Updated each render frame by renderMapObjects() so the safety-status
// checks (which run separately) use the same scale as what's drawn.
let currentMapSpanMeters = 65000;
let currentPixelsPerMeter = 1;

// --- STRICT AA-ONLY CLASSIFICATION & RANGE PROFILES ---
const AA_RANGE_PROFILES = {
    spaag: { minRangeM: 2500, maxRangeM: 3500, color: "rgba(255, 140, 0, 0.9)", fill: "rgba(255, 140, 0, 0.04)", label: "SPAAG" },
    shorad: { minRangeM: 5000, maxRangeM: 10000, color: "rgba(255, 51, 102, 0.9)", fill: "rgba(255, 51, 102, 0.04)", label: "SHORAD" },
    mrad: { minRangeM: 15000, maxRangeM: 30000, color: "rgba(238, 130, 238, 0.9)", fill: "rgba(238, 130, 238, 0.03)", label: "M-SAM" },
    lrad: { minRangeM: 50000, maxRangeM: 100000, color: "rgba(186, 85, 211, 0.9)", fill: "rgba(186, 85, 211, 0.02)", label: "L-SAM" }
};

function classifyStrictAA(obj) {
    const icon = String(obj.icon || "").toLowerCase();
    const type = String(obj.type || "").toLowerCase();
    const name = String(obj.name || "").toLowerCase();
    const combined = `${icon} ${type} ${name}`;

    if (combined.includes("tank") || combined.includes("howitzer") || combined.includes("pillbox") || combined.includes("base") || combined.includes("ship") || combined.includes("boat")) {
        return null;
    }

    if (combined.includes("patriot") || combined.includes("s-300") || combined.includes("s300") || combined.includes("s-400") || combined.includes("s400") || combined.includes("lrad")) {
        return AA_RANGE_PROFILES.lrad;
    }
    if (combined.includes("buk") || combined.includes("hawk") || combined.includes("nasams") || combined.includes("kub") || combined.includes("mrad")) {
        return AA_RANGE_PROFILES.mrad;
    }
    if (combined.includes("strela") || combined.includes("roland") || combined.includes("tor") || combined.includes("tunguska") || combined.includes("chaparral") || combined.includes("adats") || combined.includes("shorad") || combined.includes("sam") || combined.includes("linebacker") || combined.includes("fv103") || combined.includes("stormer")) {
        return AA_RANGE_PROFILES.shorad;
    }
    // NOTE: confirmed live data shows the generic icon is exactly "SPAA" (no
    // trailing G) - the "spaag" keyword alone never matches that. Added
    // "spaa" explicitly so the most common AA category actually gets flagged.
    if (combined.includes("gepard") || combined.includes("shilka") || combined.includes("m163") || combined.includes("vads") || combined.includes("marksman") || combined.includes("zsu") || combined.includes("spaag") || combined.includes("spaa") || combined.includes("aaa") || combined.includes("flak") || combined.includes("m19") || combined.includes("m42") || combined.includes("ostwind") || combined.includes("wirbelwind") || combined.includes("kugelblitz") || combined.includes("sdkfz") || combined.includes("bkan") || icon.includes("aaa") || icon.includes("sam")) {
        return AA_RANGE_PROFILES.spaag;
    }

    return null;
}

// Team classification using the "color[]" RGB array the API provides
// directly (e.g. [31, 250, 0] for own-team green) - far more reliable than
// matching against hex-string substrings like "green"/"blue", which never
// match an actual "#1fFA00"-style value and previously meant the
// friendly/enemy split silently never worked.
function classifyTeam(obj) {
    const rgb = obj["color[]"];
    if (!Array.isArray(rgb) || rgb.length < 3) return "unknown";
    const [r, g, b] = rgb;
    if (g > r + 40 && g > b + 40) return "friendly";
    if (r > g + 40 && r > b + 40) return "enemy";
    return "unknown"; // covers the player's own marker color and neutral map features
}

let lastPlayerLockState = "none"; // "exact" | "fallback" | "none"

function findPlayerObject() {
    // Confirmed from live debug data: the player's own aircraft is
    // icon "Player" (exact case). Falls back to "any non-red aircraft"
    // only if that's somehow missing (e.g. between matches, or a
    // momentary gap in map_obj.json) - that fallback can't tell your
    // aircraft apart from another ally one, so it's tracked separately
    // rather than treated as equally reliable.
    const exact = latestMapObj.find(o => o.icon === "Player");
    if (exact) {
        lastPlayerLockState = "exact";
        return exact;
    }
    const fallback = latestMapObj.find(o => o.type === "aircraft" && classifyTeam(o) !== "enemy");
    if (fallback) {
        lastPlayerLockState = "fallback";
        return fallback;
    }
    lastPlayerLockState = "none";
    return null;
}

// A/A missiles only make sense against aircraft; bombs and glide bombs only
// make sense against ground/naval contacts. Without this, "nearest target"
// and "in range" could report YES against a tank while you have a
// Sidewinder selected, which isn't useful information.
function isValidTargetForWeapon(obj, profile) {
    if (!profile) return true;
    const isAircraft = obj.type === "aircraft";
    if (profile.type === "missile") return isAircraft;
    return !isAircraft; // bomb / glide_bomb
}

// General friendly/enemy visibility toggle for unit icons and airfields -
// distinct from the AA-specific "Show Friendly/Enemy AA Ranges" toggles,
// which control range-ring overlays rather than whether the unit itself
// is drawn at all.
function isTeamVisible(obj) {
    const team = classifyTeam(obj);
    if (team === "friendly") return chkShowFriendlyForces?.checked ?? true;
    if (team === "enemy") return chkShowEnemyForces?.checked ?? true;
    return true; // unknown team (e.g. self) - always show
}

// ---------- Trajectory physics ----------
// Point-mass simulation under gravity + aerodynamic drag, plus (for glide
// weapons) a lift force sized by a target glide ratio, integrated from the
// aircraft's ACTUAL current velocity vector (not an assumed level release).
// This replaces the old closed-form CCIP fudge and the linear glide-range
// formula with one real trajectory model for both.
//
// Coefficients (mass/refArea/dragCoeff/glideRatio) are still real-world
// reference estimates, NOT calibrated to War Thunder's actual in-game
// ballistics - use calibrateDragCoeff/calibrateGlideRatio in the console
// against your own test drops to tighten them (see README).

const GRAVITY = 9.80665;

function isaDensity(altitudeM) {
    const T0 = 288.15, P0 = 101325, L = 0.0065, R = 287.05, g0 = 9.80665;
    const alt = Math.max(0, altitudeM);
    if (alt <= 11000) {
        const T = T0 - L * alt;
        const P = P0 * Math.pow(T / T0, g0 / (R * L));
        return P / (R * T);
    }
    const T11 = 216.65;
    const P11 = P0 * Math.pow(T11 / T0, g0 / (R * L));
    const P = P11 * Math.exp((-g0 * (alt - 11000)) / (R * T11));
    return P / (R * T11);
}

/**
 * @param {object} weapon - {mass, refArea, dragCoeff, glideRatio}
 * @param {number} releaseAltitude - meters AGL
 * @param {number} vx0 - initial horizontal velocity, m/s
 * @param {number} vy0 - initial vertical velocity, m/s (negative = descending)
 * @returns {{range:number, time:number}}
 */
function simulateImpactRange(weapon, releaseAltitude, vx0, vy0, opts = {}) {
    const dt = opts.dt ?? 0.02;
    const maxTime = opts.maxTime ?? 400;

    let x = 0, y = Math.max(0, releaseAltitude);
    let vx = vx0, vy = vy0;
    let t = 0;

    while (y > 0 && t < maxTime) {
        const v = Math.hypot(vx, vy) || 1e-6;
        const rho = isaDensity(y);
        const q = 0.5 * rho * v * v;
        const dragForce = q * weapon.refArea * weapon.dragCoeff;

        const ux = vx / v, uy = vy / v;
        const perpX = uy, perpY = -ux;
        let liftForce = 0;
        if (weapon.glideRatio > 0) liftForce = dragForce * weapon.glideRatio;
        const liftSign = perpY > 0 ? 1 : -1;

        const ax = (-dragForce * ux + liftSign * liftForce * perpX) / weapon.mass;
        const ay = -GRAVITY + (-dragForce * uy + liftSign * liftForce * perpY) / weapon.mass;

        vx += ax * dt;
        vy += ay * dt;
        x += vx * dt;
        y += vy * dt;
        t += dt;
    }
    return { range: x, time: t };
}

/** Solves for dragCoeff reproducing an observed test-drop range. Use for unguided bombs.
 *  Search range is wide (not capped at real-world aerodynamic values) because
 *  War Thunder's in-game bomb model needs far higher effective drag than a
 *  real bomb has - we're matching the game, not physics. */
function calibrateDragCoeff(weapon, releaseAltitude, vx0, vy0, targetRangeMeters, opts = {}) {
    const tolerance = opts.tolerance ?? 15;
    let lo = 0.01, hi = 200;
    for (let i = 0; i < 80; i++) {
        const mid = (lo + hi) / 2;
        const { range } = simulateImpactRange({ ...weapon, dragCoeff: mid }, releaseAltitude, vx0, vy0);
        if (Math.abs(range - targetRangeMeters) < tolerance) return mid;
        if (range > targetRangeMeters) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
}

/** Solves for glideRatio reproducing an observed test-drop range. Use for guided glide bombs. */
function calibrateGlideRatio(weapon, releaseAltitude, vx0, vy0, targetRangeMeters, opts = {}) {
    const tolerance = opts.tolerance ?? 25;
    let lo = 0, hi = 20;
    for (let i = 0; i < 50; i++) {
        const mid = (lo + hi) / 2;
        const { range } = simulateImpactRange({ ...weapon, glideRatio: mid }, releaseAltitude, vx0, vy0);
        if (Math.abs(range - targetRangeMeters) < tolerance) return mid;
        if (range < targetRangeMeters) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
}

// Decomposes current TAS/IAS + vertical speed into a release velocity
// vector, instead of assuming level flight - a diving or climbing release
// meaningfully changes both CCIP impact point and glide reach.
function computeReleaseVelocityComponents() {
    const speedKmh = latestState?.["TAS, km/h"] ?? latestState?.["IAS, km/h"] ?? 400;
    const speedMs = speedKmh / 3.6;
    const vyRaw = latestState?.["Vy, m/s"] ?? 0; // negative = descending
    // Clamped to the FULL speed magnitude, not an artificially reduced
    // fraction of it. The old 0.98 margin left a permanent ~20% residual
    // horizontal velocity even at true vertical (sqrt(1 - 0.98^2) ≈ 0.199),
    // which is why CCIP was observed shrinking on approach to vertical but
    // never actually collapsing to under the aircraft. Safe to remove:
    // simulateImpactRange already guards its own v=0 case
    // (Math.hypot(vx, vy) || 1e-6), so there's no division-by-zero this
    // margin was actually protecting against - it was just too cautious.
    const vyClamped = Math.max(-speedMs, Math.min(speedMs, vyRaw));
    const vx0 = Math.sqrt(Math.max(0, speedMs * speedMs - vyClamped * vyClamped));
    return { vx0, vy0: vyClamped };
}

// Comprehensive Realistic Ballistic & Weapon Database
// Moved out to weapons-config.js so it can be edited without touching
// this file - see that file for field reference and calibration notes.
// COUNTRY_WEAPONS is defined there; loaded before this script in mfd.html.

/**
 * Shared altitude/speed scaling factor - the same formula that already
 * drove missile range is now reused for weapons sourced from the aircraft
 * database too (see computeWeaponRangeMeters), since [stated] wants those
 * ranges to react to live flight telemetry as well, not just show a flat
 * community-sourced number.
 */
function computeDynamicRangeFactor() {
    const isDynamic = chkDynamicRange?.checked ?? true;
    const currentAlt = latestState?.["H, m"] ?? latestState?.["altitude_hour"] ?? 500;
    const currentSpeedKmh = latestState?.["TAS, km/h"] ?? latestState?.["IAS, km/h"] ?? 400;
    const altMultiplier = 1.0 + Math.min(1.5, (currentAlt / 8000) * 0.5);
    const speedMultiplier = 1.0 + Math.min(1.0, (currentSpeedKmh / 1100) * 0.4);
    return isDynamic ? (altMultiplier * speedMultiplier) : 1.0;
}

/**
 * Single source of truth for "how far can this weapon currently reach".
 *
 * Bomb/glide_bomb profiles - hand-entered (COUNTRY_WEAPONS) OR
 * database-sourced (buildDbWeaponProfile) - both run the exact same real
 * trajectory simulation against the aircraft's actual current velocity
 * vector, so CCIP and glide paths always react to live telemetry (dive
 * angle, altitude, speed), never a flat/static distance.
 *
 * Missile profiles - guided/powered, so they've always used a simpler
 * range+FOV envelope instead of a drop simulation - dynamically scaled by
 * current altitude/speed either way (hand-entered or DB-sourced).
 * @returns {number|null} range in meters, or null if no profile selected
 */
function computeWeaponRangeMeters(profile) {
    if (!profile) return null;

    if (profile.type === "bomb" || profile.type === "glide_bomb") {
        // NOTE: this is altitude above sea level / map reference plane, NOT
        // ground-relative height. War Thunder's local telemetry API has no
        // ground-relative altitude field at all - confirmed by directly
        // inspecting /state and /indicators' full field lists on multiple
        // aircraft (F-4C, A-10C), so there's currently no way to correct
        // for terrain height at the release OR impact point. See project
        // notes: terrain-elevation correction was investigated and shelved
        // for this reason.
        const releaseAltitude = Math.max(10, latestState?.["H, m"] ?? latestState?.["altitude_hour"] ?? 500);
        const { vx0, vy0 } = computeReleaseVelocityComponents();
        const { range } = simulateImpactRange(profile, releaseAltitude, vx0, vy0);
        return range;
    }

    // Missiles: unchanged simple lookup-formula model.
    return profile.rangeKm * computeDynamicRangeFactor() * 1000;
}

// ============================================================================
// Aircraft weapons/BR database (community War Thunder Vehicles API export)
// ----------------------------------------------------------------------------
// Bundled as mfd/aircraft-weapons-db.json (1,435 aircraft, built separately
// via the wt-vehicle-db scripts). Loaded once at startup below. This powers
// the vehicle dropdown ("backup" manual picker AND the auto-detect target
// once indicators.type comes in from the game) - NOT yet wired into the
// actual weapon-range calculation, since this database's weapon stats
// (speed/mass/explosive data) aren't calibrated drag/glide profiles like
// COUNTRY_WEAPONS - that mapping is a deliberate follow-up step, not done
// automatically here to avoid silently showing uncalibrated numbers.
// ============================================================================
// A weapon entry counts as "real" (vs a fuel tank / targeting pod / other
// non-armament) if it has AT LEAST ONE actual combat stat. Fuel tanks etc.
// come back with every one of these fields null.
function hasRealStats(weapon) {
    return weapon.speed !== null ||
           weapon.max_distance !== null ||
           weapon.explosive_type !== null ||
           weapon.explosive_mass !== null;
}

// Generic overlay defaults for weapons sourced from the aircraft database -
// the community API gives us real physical stats (mass, speed,
// max_distance, explosive data) but no FOV cone or turn-rate for missiles,
// and no drag coefficient for bombs, so those specific fields need a
// real-world-reference placeholder. See buildDbWeaponProfile below for how
// each type actually computes its range.
const DB_WEAPON_DEFAULTS = {
    missile: { fovDeg: 30, maxG: 25, color: "#00ffcc" },
    bomb: { color: "#ff3333" }
};

// Real-world reference drag coefficient for a generic bomb shape, used
// when we don't have a weapon-specific calibrated value. Real bombs are
// physically ~0.15-0.4 (see weapons-config.js's field reference) - 0.30 is
// a reasonable mid-range placeholder until individual DB-sourced bombs get
// their own calibrated value the same way MK 84 already has in
// COUNTRY_WEAPONS.
const DEFAULT_BOMB_DRAG_COEFF = 0.30;

// Classifies a database ammo entry as "missile" (has its own propulsion) or
// "bomb" (unguided/gravity - glide bombs are also detected as a subset of
// this, see GLIDE_BOMB_CATEGORIES below).
function classifyDbWeapon(ammo) {
    const t = (ammo.type || "").toLowerCase();
    const looksLikeMissile = ammo.speed !== null || t.includes("am") || t.includes("missile") || t.includes("rocket");
    return looksLikeMissile ? "missile" : "bomb";
}

// Real-world glide-bomb reference data, grouped by wing/airframe design
// (each design shape gives a characteristic glide ratio range - a small
// high-lift folding wing glides much further per meter of altitude than a
// standard bomb body with just fixed tail fins). glideRatio is the
// midpoint of the provided L/D range. The database has no glide-vs-dumb
// flag or glide-ratio field at all, so membership here is by matching
// known munition names against the DB identifier - anything not
// recognized here falls back to a plain drop bomb, same as before.
//
// maneuverHalfAngleDeg (the off-axis steering cone drawn on the map) is
// NOT part of this reference table - it's carried over from this
// project's existing convention for the same three rough categories
// (already used for GBU-39/GBU-8/Paveway II in weapons-config.js), not a
// value sourced from the table itself.
const GLIDE_BOMB_CATEGORIES = [
    {
        // High-lift / foldable wing - GBU-39 SDB, Grom-2, UPAB-1500
        keywords: ["gbu_39", "gbu39", "sdb", "grom", "upab"],
        glideRatio: 7.0, // midpoint of 6.0-8.0
        maneuverHalfAngleDeg: 55
    },
    {
        // Long-chord / extended wing - GBU-15, AGM-62 Walleye, GBU-24
        keywords: ["gbu_15", "gbu15", "walleye", "agm_62", "agm62", "gbu_24", "gbu24"],
        glideRatio: 4.0, // midpoint of 3.5-4.5
        maneuverHalfAngleDeg: 25
    },
    {
        // Standard fixed-fin - GBU-12, GBU-10, KAB-500L/Kr
        keywords: ["gbu_12", "gbu12", "gbu_10", "gbu10", "kab_500", "kab500"],
        glideRatio: 2.0, // midpoint of 1.5-2.5
        maneuverHalfAngleDeg: 15
    }
];

// Returns the matching glide-bomb category for a DB identifier, or null if
// it doesn't match any known glide munition (stays a plain drop bomb).
function matchGlideBombCategory(identifier) {
    const id = identifier.toLowerCase();
    return GLIDE_BOMB_CATEGORIES.find(cat => cat.keywords.some(kw => id.includes(kw))) ?? null;
}

// Builds a profile shaped like a COUNTRY_WEAPONS entry, sourced from the
// aircraft database's real-world stats.
//
// Missiles: guided/powered, so (same as hand-entered missiles) they use a
// simple range+FOV envelope rather than a drop trajectory - real
// max_distance, dynamically scaled by current altitude/speed.
//
// Bombs: feed the DB's REAL mass straight into the same physics trajectory
// simulation (simulateImpactRange) that hand-entered COUNTRY_WEAPONS bombs
// already use - CCIP now reacts to live dive angle/altitude/speed instead
// of a flat distance. refArea is estimated from the weapon's caliber field
// (which represents body diameter for bombs too, not just gun/missile
// caliber); dragCoeff uses the real-world reference default above, since
// the database itself doesn't expose an aerodynamic coefficient. If the
// identifier matches a known glide munition (see GLIDE_BOMB_CATEGORIES),
// glideRatio and maneuverHalfAngleDeg are added and the type becomes
// "glide_bomb" instead of a plain drop.
function buildDbWeaponProfile(ammo) {
    const type = classifyDbWeapon(ammo);

    if (type === "missile") {
        const defaults = DB_WEAPON_DEFAULTS.missile;
        return {
            type: "missile",
            rangeKm: (ammo.max_distance ?? 0) / 1000, // real community-sourced value
            color: defaults.color,
            fovDeg: defaults.fovDeg,
            maxG: defaults.maxG,
            _dbSource: true
        };
    }

    const massKg = ammo.mass ?? 250; // fallback only if a record is missing mass entirely
    const bodyDiameterM = ammo.caliber ?? 0.3;
    const refArea = Math.PI * Math.pow(bodyDiameterM / 2, 2);
    const glideCategory = matchGlideBombCategory(ammo.name);

    return {
        type: glideCategory ? "glide_bomb" : "bomb",
        mass: massKg, // real DB value
        refArea, // derived from the real DB caliber value
        dragCoeff: DEFAULT_BOMB_DRAG_COEFF, // real-world reference estimate, see note above
        glideRatio: glideCategory?.glideRatio, // real-world reference table value, or undefined for a plain drop bomb
        maneuverHalfAngleDeg: glideCategory?.maneuverHalfAngleDeg, // project convention, not from the reference table
        color: glideCategory ? "#9933ff" : DB_WEAPON_DEFAULTS.bomb.color, // matches COUNTRY_WEAPONS' glide-bomb color convention
        _dbSource: true
    };
}
// ============================================================================
// Vehicle -> real guided/glide bomb availability (War Thunder Wiki-sourced)
// ----------------------------------------------------------------------------
// aircraft-weapons-db.json's per-vehicle preset data does NOT track gravity/
// glide bombs at all (confirmed: only 1 "he_bomb"-typed entry exists across
// all 1,435 vehicles). This supplements it using the official War Thunder
// Wiki's per-weapon "vehicle collection" pages (wiki.warthunder.com/
// collections/weapon/<slug>), which list every vehicle that carries a given
// weapon. Every identifier below was verified against aircraft-weapons-db.json
// before being added - 155/155 matched (100%) across the 4 categories
// checked so far.
//
// NOT exhaustive - only 4 weapon families covered (the ones matching
// [stated]'s original 3-tier glide-ratio reference table). Extending to
// GBU-8/GBU-53/Paveway IV/Walleye/JSOW/KAB-1500/AASM Hammer/JDAM etc. is the
// same process (fetch the wiki collection page, verify against the DB,
// append here) but deferred for now.
//
// Real-world reference mass/caliber for each munition. Fields are shaped
// exactly like a database ammo record and fed through the SAME
// buildDbWeaponProfile() pipeline as real DB weapons - the "name" is chosen
// to match GLIDE_BOMB_CATEGORIES' keyword list so classification (and
// glideRatio/maneuverHalfAngleDeg) happens automatically, no separate code
// path needed. speed/max_distance/explosive_type left null/omitted where
// not well-established; explosive_mass is set so hasRealStats() recognizes
// these as real weapons, not fuel-tank-like clutter.
const SYNTHETIC_GLIDE_BOMBS = {
    gbu_39: { name: "gbu_39_sdb", type: "guided_bomb", caliber: 0.19, mass: 113, speed: null, max_distance: null, explosive_type: null, explosive_mass: 16.9 },
    paveway_ii: { name: "paveway_ii_gbu_12", type: "guided_bomb", caliber: 0.273, mass: 227, speed: null, max_distance: null, explosive_type: null, explosive_mass: 87 },
    paveway_iii: { name: "paveway_iii_gbu_24", type: "guided_bomb", caliber: 0.458, mass: 907, speed: null, max_distance: null, explosive_type: null, explosive_mass: 429 },
    kab_500: { name: "kab_500", type: "guided_bomb", caliber: 0.35, mass: 500, speed: null, max_distance: null, explosive_type: null, explosive_mass: 195 }
};

// vehicle identifier -> array of SYNTHETIC_GLIDE_BOMBS keys it can carry.
// Generated from wiki.warthunder.com/collections/weapon/{gbu_39,paveway_ii,
// paveway_iii,500kg_kab500} - see header comment above.
const VEHICLE_GLIDE_BOMBS = {
    "a_10c": ["gbu_39", "paveway_ii"],
    "a_6e_tram": ["paveway_ii"],
    "amx": ["paveway_ii", "paveway_iii"],
    "av_8b_na": ["paveway_ii"],
    "av_8b_plus": ["paveway_ii"],
    "av_8b_plus_italy": ["paveway_ii"],
    "buccaneer_s2b": ["paveway_ii"],
    "cf_188a_canada": ["paveway_ii", "paveway_iii"],
    "ef_2000_aesa": ["paveway_ii"],
    "ef_2000_block_10": ["paveway_ii"],
    "ef_2000_fgr4": ["paveway_ii"],
    "ef_2000_typhoon_aesa": ["paveway_ii"],
    "ef_2000a": ["paveway_ii"],
    "ef_2000a_aesa": ["paveway_ii"],
    "f-4e_kurnass_2000": ["paveway_ii"],
    "f_111c_raaf": ["paveway_ii", "paveway_iii"],
    "f_111f": ["paveway_ii", "paveway_iii"],
    "f_117": ["paveway_ii", "paveway_iii"],
    "f_14b": ["paveway_ii", "paveway_iii"],
    "f_14d": ["paveway_ii", "paveway_iii"],
    "f_15c_golden_eagle": ["gbu_39", "paveway_ii", "paveway_iii"],
    "f_15c_msip2": ["gbu_39"],
    "f_15e": ["gbu_39", "paveway_ii", "paveway_iii"],
    "f_15i_raam": ["gbu_39", "paveway_ii", "paveway_iii"],
    "f_16a_block_15_ocu_thailand": ["paveway_ii"],
    "f_16a_block_20_mlu": ["paveway_ii"],
    "f_16a_block_72v_china": ["gbu_39", "paveway_ii", "paveway_iii"],
    "f_16am_block_15_mlu_belgium": ["gbu_39", "paveway_ii", "paveway_iii"],
    "f_16am_block_20_mlu_netherlands": ["gbu_39", "paveway_ii", "paveway_iii"],
    "f_16am_block_20_mlu_norway": ["gbu_39", "paveway_ii", "paveway_iii"],
    "f_16c_block_40_barak_2": ["gbu_39", "paveway_ii"],
    "f_16c_block_50": ["gbu_39", "paveway_ii", "paveway_iii"],
    "f_16c_block_52_aesa": ["gbu_39", "paveway_ii", "paveway_iii"],
    "f_16d_block_40_barak_2": ["gbu_39", "paveway_ii"],
    "f_16i_sufa": ["gbu_39", "paveway_ii"],
    "fa_18a_hug_2_raaf": ["paveway_ii", "paveway_iii"],
    "fa_18c_early": ["paveway_ii", "paveway_iii"],
    "fa_18c_late": ["paveway_ii", "paveway_iii"],
    "fa_18c_late_switzerland": ["paveway_ii", "paveway_iii"],
    "fa_18c_switzerland": ["paveway_ii", "paveway_iii"],
    "fa_18d_late_malaysia": ["paveway_ii", "paveway_iii"],
    "fa_18e_block_2": ["paveway_ii", "paveway_iii"],
    "fa_18f_block_2_raaf": ["paveway_ii", "paveway_iii"],
    "harrier_gr7": ["paveway_ii", "paveway_iii"],
    "harrier_t10": ["paveway_ii", "paveway_iii"],
    "jaguar_a": ["paveway_ii"],
    "jaguar_gr1a": ["paveway_ii"],
    "jaguar_is": ["paveway_ii"],
    "jf_17": ["paveway_ii"],
    "kfir_c10_colombia": ["paveway_ii"],
    "m_346fa": ["paveway_ii"],
    "mig-21_bison": ["kab_500"],
    "mig_21_2000_iaf": ["paveway_ii"],
    "mig_27k": ["kab_500"],
    "mig_27m": ["kab_500"],
    "mig_29kr_9_41r": ["kab_500"],
    "mig_29m_9_15": ["kab_500"],
    "mig_29smt_9_19": ["kab_500"],
    "mirage_2000_5f": ["paveway_ii", "paveway_iii"],
    "mirage_2000d_r1": ["paveway_ii", "paveway_iii"],
    "mirage_2000d_rmv": ["paveway_ii", "paveway_iii"],
    "rafale_c_f3": ["paveway_ii", "paveway_iii"],
    "rafale_m_f3r": ["paveway_ii", "paveway_iii"],
    "saab_jas39a": ["paveway_ii", "paveway_iii"],
    "saab_jas39c": ["gbu_39", "paveway_ii", "paveway_iii"],
    "saab_jas39c_hungary": ["gbu_39", "paveway_ii", "paveway_iii"],
    "saab_jas39c_south_africa": ["gbu_39", "paveway_ii", "paveway_iii"],
    "saab_jas39c_thailand": ["gbu_39", "paveway_ii", "paveway_iii"],
    "saab_jas39d": ["gbu_39", "paveway_ii", "paveway_iii"],
    "saab_jas39e": ["gbu_39", "paveway_ii", "paveway_iii"],
    "su_24m": ["kab_500"],
    "su_25_558arz": ["kab_500"],
    "su_25sm3": ["kab_500"],
    "su_25t": ["kab_500"],
    "su_25tm": ["kab_500"],
    "su_27sm": ["kab_500"],
    "su_30mk2v_venezuela": ["kab_500"],
    "su_30mkk": ["kab_500"],
    "su_30mkm": ["paveway_ii", "kab_500"],
    "su_30sm": ["kab_500"],
    "su_30sm2": ["kab_500"],
    "su_34": ["kab_500"],
    "super_etendard_97": ["paveway_ii"],
    "tornado_gr1": ["paveway_ii", "paveway_iii"],
    "tornado_gr4": ["paveway_ii", "paveway_iii"],
    "tornado_ids_de_assta1": ["paveway_ii", "paveway_iii"],
    "tornado_ids_de_assta3_sle": ["paveway_ii", "paveway_iii"],
    "tornado_ids_it_mod95": ["paveway_ii", "paveway_iii"],
    "tornado_ids_it_ret8": ["gbu_39", "paveway_ii", "paveway_iii"],
    "yak_130_early": ["kab_500"]
};

// Returns this vehicle's known glide/guided bombs as ammo-shaped records
// (see SYNTHETIC_GLIDE_BOMBS), or an empty array if none are known for it.
function getSyntheticGlideBombsForVehicle(identifier) {
    const keys = VEHICLE_GLIDE_BOMBS[identifier] || [];
    return keys.map(k => SYNTHETIC_GLIDE_BOMBS[k]).filter(Boolean);
}

// Turns a raw identifier like "us_aim9m_sidewinder" into a readable label
// like "Us Aim9m Sidewinder" - not pretty, but there's no friendly-name
// field anywhere in the source data to draw from instead.
function formatDbWeaponLabel(identifier) {
    return identifier
        .split("_")
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
}

// True while the weapon dropdown is populated from a selected/detected
// vehicle's real loadout; false while it's the manual country/weapon list.
let usingVehicleWeapons = false;
// ammo.name -> ammo object, for the currently active vehicle's real weapons.
let currentVehicleWeaponsMap = new Map();

/**
 * Human-readable group labels for the "show all weapons" breakdown, keyed
 * by the database's raw `type` field (see the type-vocabulary check done
 * earlier: aam/rocket_tank/heat_fs_tank/atgm_tank/etc, plus our own
 * "guided_bomb" for the synthetic glide-bomb entries above). Anything not
 * listed falls back to a generic "Other" group rather than being dropped.
 */
const WEAPON_TYPE_LABELS = {
    aam: "Air-to-Air Missiles",
    guided_bomb: "Guided / Glide Bombs",
    atgm_tank: "ATGMs",
    atgm_tandem_tank: "ATGMs (Tandem Warhead)",
    atgm_vt_fuze_tank: "ATGMs (VT Fuze)",
    rocket_tank: "Rockets / Guided Missiles",
    heat_fs_rocket: "Rockets (HEAT-FS)",
    he_frag_fs_tank: "Cannon/Gun Ammo (HE-Frag)",
    heat_fs_tank: "Cannon/Gun Ammo (HEAT-FS)",
    ap_tank: "Cannon/Gun Ammo (AP)",
    apds_fs_long_tank: "Cannon/Gun Ammo (APDS-FS)",
    he_bomb: "Bombs",
    chff: "Chaff",
    flr: "Flares",
    smoke_tank: "Smoke",
    null: "Fuel Tanks / Pods / Other (no combat use)"
};

function weaponTypeLabel(type) {
    return WEAPON_TYPE_LABELS[type] ?? WEAPON_TYPE_LABELS[String(type)] ?? "Other";
}

/**
 * Populates the weapon dropdown from a specific vehicle's real loadout.
 * Always includes any known real guided/glide bombs (see
 * getSyntheticGlideBombsForVehicle) since those have genuine combat stats.
 *
 * Normal mode: hasRealStats-filtered flat list (fuel tanks/pods excluded) -
 * same behavior as before.
 * "Show ALL weapons" mode (chk-show-all-weapons): every entry the vehicle
 * has on record, INCLUDING fuel tanks/pods/chaff/flares, grouped into
 * <optgroup> sections by weapon type so the long list stays navigable.
 *
 * Falls back to the manual country/weapon list if the vehicle isn't in the
 * database or has no weapons to show under the current mode.
 */
function populateWeaponDropdownFromVehicle(identifier) {
    const vehicle = aircraftDb?.[identifier];
    if (!vehicle) {
        usingVehicleWeapons = false;
        populateWeaponDropdown();
        return;
    }

    const syntheticWeapons = getSyntheticGlideBombsForVehicle(identifier);
    const showAll = chkShowAllWeapons?.checked ?? false;
    const baseWeapons = showAll ? vehicle.weapons : vehicle.weapons.filter(hasRealStats);
    const allWeapons = [...baseWeapons, ...syntheticWeapons];

    if (allWeapons.length === 0) {
        usingVehicleWeapons = false;
        populateWeaponDropdown(); // old country/weapon fallback
        return;
    }

    usingVehicleWeapons = true;
    currentVehicleWeaponsMap = new Map(allWeapons.map(w => [w.name, w]));

    selWeapon.innerHTML = "";

    if (showAll) {
        // Group into <optgroup> sections by type so a full unfiltered list
        // (which can include a dozen+ fuel tanks/pods per vehicle) stays
        // navigable instead of one long undifferentiated dropdown.
        const groups = new Map(); // label -> [weapon, ...]
        for (const weapon of allWeapons) {
            const label = weaponTypeLabel(weapon.type);
            if (!groups.has(label)) groups.set(label, []);
            groups.get(label).push(weapon);
        }
        for (const [label, weapons] of groups) {
            const optgroup = document.createElement("optgroup");
            optgroup.label = label;
            for (const weapon of weapons) {
                const opt = document.createElement("option");
                opt.value = weapon.name;
                opt.textContent = formatDbWeaponLabel(weapon.name);
                optgroup.appendChild(opt);
            }
            selWeapon.appendChild(optgroup);
        }
    } else {
        for (const weapon of allWeapons) {
            const opt = document.createElement("option");
            opt.value = weapon.name;
            opt.textContent = formatDbWeaponLabel(weapon.name);
            selWeapon.appendChild(opt);
        }
    }

    const savedWeapon = localStorage.getItem("wtmfd_weapon");
    if (savedWeapon && currentVehicleWeaponsMap.has(savedWeapon)) {
        selWeapon.value = savedWeapon;
    }

    updateWeaponInfo();
}

/**
 * Single place that knows where the "current weapon" actually comes from -
 * either a selected/detected vehicle's real loadout, or the manual
 * country/weapon dropdown. Every render/logic function that previously did
 * COUNTRY_WEAPONS[selCountry.value]?.[selWeapon.value] directly should call
 * this instead, so vehicle-sourced weapons work everywhere automatically.
 */
function getCurrentWeaponProfile() {
    if (usingVehicleWeapons) {
        const ammo = currentVehicleWeaponsMap.get(selWeapon.value);
        return ammo ? buildDbWeaponProfile(ammo) : null;
    }
    return COUNTRY_WEAPONS[selCountry.value]?.[selWeapon.value];
}

let aircraftDb = null;
let currentDetectedVehicleId = null; // last identifier seen from indicators.type

async function loadAircraftDb() {
    try {
        const res = await fetch("aircraft-weapons-db.json");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        aircraftDb = await res.json();
        console.log(`[WT MFD] Loaded aircraft database: ${Object.keys(aircraftDb).length} vehicles`);
        populateVehicleDropdown();
    } catch (err) {
        console.error("[WT MFD] Failed to load aircraft-weapons-db.json:", err);
        if (selVehicle) selVehicle.innerHTML = '<option value="">-- database failed to load --</option>';
    }
}

// A weapon entry counts as "real" (vs a fuel tank / targeting pod / other
// non-armament) if it has AT LEAST ONE actual combat stat. Fuel tanks etc.
// come back with every one of these fields null.
function hasRealStats(weapon) {
    return weapon.speed !== null ||
           weapon.max_distance !== null ||
           weapon.explosive_type !== null ||
           weapon.explosive_mass !== null;
}

// Builds the vehicle <select>, grouped into 1.0-wide realistic_br brackets
// with a header (<optgroup>) per bracket, e.g. "BR 10.0 - 10.9". Sorted low
// to high, and alphabetically by identifier within each bracket.
function populateVehicleDropdown() {
    if (!selVehicle || !aircraftDb) return;

    // Group every vehicle identifier by the whole-number floor of its
    // realistic_br (10.3 and 10.7 both land in the "10" bracket).
    const groups = new Map(); // brFloor -> [identifier, ...]
    for (const [identifier, vehicle] of Object.entries(aircraftDb)) {
        const br = vehicle.realistic_br;
        if (br === null || br === undefined) continue; // shouldn't happen, but don't crash if it does
        const brFloor = Math.floor(br);
        if (!groups.has(brFloor)) groups.set(brFloor, []);
        groups.get(brFloor).push(identifier);
    }

    const sortedBrackets = [...groups.keys()].sort((a, b) => a - b);

    selVehicle.innerHTML = "";
    const defaultOpt = document.createElement("option");
    defaultOpt.value = "";
    defaultOpt.textContent = "-- manual: pick a vehicle --";
    selVehicle.appendChild(defaultOpt);

    for (const brFloor of sortedBrackets) {
        const optgroup = document.createElement("optgroup");
        optgroup.label = `BR ${brFloor}.0 - ${brFloor}.9`;

        const identifiers = groups.get(brFloor).sort((a, b) => a.localeCompare(b));
        for (const identifier of identifiers) {
            const vehicle = aircraftDb[identifier];
            const opt = document.createElement("option");
            opt.value = identifier;
            // No friendly display name exists in the source data - showing
            // the raw identifier plus country is the clearest option we have.
            opt.textContent = `${identifier} (${vehicle.country})`;
            optgroup.appendChild(opt);
        }
        selVehicle.appendChild(optgroup);
    }

    const savedVehicle = localStorage.getItem("wtmfd_vehicle");
    if (savedVehicle && aircraftDb[savedVehicle]) {
        selVehicle.value = savedVehicle;
    }
}

// Called every poll once telemetry is flowing. If the game's currently
// reported vehicle (indicators.type) matches an identifier in our database
// AND it's different from what we last detected, auto-select it in the
// dropdown. Silently does nothing if there's no match (game's format may
// not always line up 1:1 with the database's - confirmed working for
// "f-4c", not yet confirmed for every vehicle) so manual selection always
// still works as a fallback.
function tryAutoDetectVehicle() {
    if (!aircraftDb || !selVehicle) return;
    const liveId = latestIndicators?.type;
    if (!liveId || liveId === currentDetectedVehicleId) return;

    currentDetectedVehicleId = liveId;

    if (aircraftDb[liveId]) {
        selVehicle.value = liveId;
        localStorage.setItem("wtmfd_vehicle", liveId);
        populateWeaponDropdownFromVehicle(liveId);
        if (elVehicleSource) {
            elVehicleSource.textContent = `AUTO-DETECTED: ${liveId}`;
            elVehicleSource.style.color = "#00ffcc";
        }
    } else if (elVehicleSource) {
        // Detected a vehicle change but it's not in our database (e.g. a
        // brand-new patch addition) - leave the dropdown on manual/whatever
        // it was, but say so instead of silently doing nothing.
        elVehicleSource.textContent = `"${liveId}" not in database - pick manually`;
        elVehicleSource.style.color = "#ffaa00";
    }
}

if (selVehicle) {
    selVehicle.addEventListener("change", () => {
        localStorage.setItem("wtmfd_vehicle", selVehicle.value);
        if (selVehicle.value) {
            populateWeaponDropdownFromVehicle(selVehicle.value);
            if (elVehicleSource) {
                elVehicleSource.textContent = `MANUAL SELECTION: ${selVehicle.value}`;
                elVehicleSource.style.color = "#8b9bb4";
            }
        } else {
            // Blank/"-- manual --" option chosen: drop back to the plain
            // country/weapon dropdown entirely.
            usingVehicleWeapons = false;
            populateWeaponDropdown();
            if (elVehicleSource) {
                elVehicleSource.textContent = "-";
            }
        }
    });
}

loadAircraftDb();

function populateWeaponDropdown() {
    const country = selCountry.value;
    selWeapon.innerHTML = "";
    const weapons = COUNTRY_WEAPONS[country] || COUNTRY_WEAPONS.USA;
    Object.keys(weapons).forEach(wName => {
        const opt = document.createElement("option");
        opt.value = wName;
        opt.textContent = wName;
        selWeapon.appendChild(opt);
    });
    const savedWeapon = localStorage.getItem("wtmfd_weapon");
    if (savedWeapon && weapons[savedWeapon]) {
        selWeapon.value = savedWeapon;
    }
    updateWeaponInfo();
}

function updateWeaponInfo() {
    const profile = getCurrentWeaponProfile();
    if (!profile) return;

    const rangeMeters = computeWeaponRangeMeters(profile);
    const rangeKm = rangeMeters / 1000;

    if (profile.type === "glide_bomb") {
        const angleTxt = profile.maneuverHalfAngleDeg ? ` | ±${profile.maneuverHalfAngleDeg}°` : "";
        elRangeInfo.textContent = `GLIDE BOMB (${rangeKm.toFixed(1)} KM STANDOFF${angleTxt})`;
    } else if (profile.type === "missile") {
        elRangeInfo.textContent = `${rangeKm.toFixed(1)} KM (FOV: ${profile.fovDeg}° | G: ${profile.maxG})`;
    } else {
        // Bomb - both hand-entered and DB-sourced now run the same
        // physics-simulated CCIP (see computeWeaponRangeMeters), so they
        // share this label. DB-sourced ones get a small note since their
        // mass is real but dragCoeff is a real-world reference estimate,
        // not weapon-specific calibrated data.
        const sourceNote = profile._dbSource ? " · community mass, ref. CD" : "";
        elRangeInfo.textContent = `GRAVITY CCIP (~${Math.max(0.5, rangeKm).toFixed(1)} KM DROP${sourceNote})`;
    }
    updateTrajectoryDebug();
}

// ---------- Persisted UI state ----------
// Selections and overlay toggles survive a reload instead of resetting to
// defaults every time the MFD window is reopened.
const PERSISTED_CHECKBOX_IDS = [
    "chk-aa-rings", "chk-friendly-aa", "chk-range-arc",
    "chk-bomb-ccip", "chk-dynamic-range", "chk-grid-overlay", "chk-airfields",
    "chk-auto-calibrate", "chk-show-friendly-forces", "chk-show-enemy-forces"
];

function loadPersistedUI() {
    const savedCountry = localStorage.getItem("wtmfd_country");
    if (savedCountry && COUNTRY_WEAPONS[savedCountry]) {
        selCountry.value = savedCountry;
    }
    PERSISTED_CHECKBOX_IDS.forEach(id => {
        const el = document.getElementById(id);
        const saved = localStorage.getItem(`wtmfd_${id}`);
        if (el && saved !== null) el.checked = saved === "1";
    });
}

function persistCheckbox(id) {
    const el = document.getElementById(id);
    if (el) localStorage.setItem(`wtmfd_${id}`, el.checked ? "1" : "0");
}

loadPersistedUI();
PERSISTED_CHECKBOX_IDS.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("change", () => persistCheckbox(id));
});

selCountry.addEventListener("change", () => {
    localStorage.setItem("wtmfd_country", selCountry.value);
    // Manually touching the country dropdown means the person wants manual
    // control - drop back out of vehicle-sourced weapons even if one was
    // auto-detected or previously chosen.
    usingVehicleWeapons = false;
    if (selVehicle) selVehicle.value = "";
    populateWeaponDropdown();
});
selWeapon.addEventListener("change", () => {
    localStorage.setItem("wtmfd_weapon", selWeapon.value);
    updateWeaponInfo();
});
if (chkDynamicRange) chkDynamicRange.addEventListener("change", updateWeaponInfo);
populateWeaponDropdown();

// ---------- Layout mode (Desktop / Mobile, live-toggleable) ----------
// "sidebar" = Desktop - classic persistent sidebar (original layout).
// "toolbar" = Mobile  - ONLY the essentials (vehicle select, weapon
//             select, CENTER ON AIRCRAFT, FOLLOW JET, connection status,
//             AIR THREAT, fullscreen button) relocate into a slim sticky
//             bar across the top of the map. Everything else (map
//             control buttons, full telemetry, AA threat/nearest target,
//             tactical overlays, debug & calibration) stays exactly
//             where it already lives in #sidebar, which becomes the
//             hamburger-opened drawer.
//
// Relocation moves the REAL DOM elements (appendChild doesn't clone -
// same node, same id, same event listeners, just a new parent), so every
// bit of JS wiring elsewhere in this file keeps working unchanged
// regardless of which layout is currently active. Each element's original
// {parent, nextSibling} is captured once up front so "put it back" is
// exact, not a guess at where it used to be.
function captureOriginalPosition(el) {
    return el ? { el, parent: el.parentNode, nextSibling: el.nextSibling } : null;
}
function restoreOriginalPosition(pos) {
    if (!pos) return;
    pos.parent.insertBefore(pos.el, pos.nextSibling);
}

const originalPositions = {
    selVehicle: captureOriginalPosition(selVehicle),
    selWeapon: captureOriginalPosition(selWeapon),
    primaryStatusRow: captureOriginalPosition(primaryStatusRow),
    airThreatRow: captureOriginalPosition(airThreatRow),
    btnCenterPlayer: captureOriginalPosition(btnCenterPlayer),
    btnToggleFollow: captureOriginalPosition(btnToggleFollow)
};

const LAYOUT_MODE_LABELS = { sidebar: "🖥️ DESKTOP", toolbar: "📱 MOBILE" };

function applyLayoutMode(mode) {
    document.body.classList.remove("compact-mode", "toolbar-mode", "sidebar-open");

    if (mode === "toolbar") {
        document.body.classList.add("compact-mode", "toolbar-mode");
        // Don't yank the drawer away the instant a mode is picked - open it
        // once so whatever the person just clicked stays visibly reachable.
        document.body.classList.add("sidebar-open");

        // Dropdown on the left, buttons centered, dropdown+AIR THREAT+
        // status+fullscreen on the right - btn-fullscreen already lives
        // in #toolbar-right in the HTML. AIR THREAT is a normal flex
        // child here now (not a separately-positioned floating badge),
        // so its position is always correct relative to its actual
        // siblings - no pixel math to get wrong.
        if (toolbarLeft && selVehicle) toolbarLeft.appendChild(selVehicle);
        if (toolbarCenter && btnCenterPlayer) toolbarCenter.appendChild(btnCenterPlayer);
        if (toolbarCenter && btnToggleFollow) toolbarCenter.appendChild(btnToggleFollow);
        if (toolbarRight && selWeapon) toolbarRight.insertBefore(selWeapon, btnFullscreen);
        if (toolbarRight && airThreatRow) toolbarRight.insertBefore(airThreatRow, btnFullscreen);
        if (toolbarRight && primaryStatusRow) toolbarRight.insertBefore(primaryStatusRow, btnFullscreen);
    } else {
        // Desktop: put everything back exactly where it started.
        restoreOriginalPosition(originalPositions.selVehicle);
        restoreOriginalPosition(originalPositions.selWeapon);
        restoreOriginalPosition(originalPositions.primaryStatusRow);
        restoreOriginalPosition(originalPositions.airThreatRow);
        restoreOriginalPosition(originalPositions.btnCenterPlayer);
        restoreOriginalPosition(originalPositions.btnToggleFollow);
    }

    if (btnLayoutToggle) btnLayoutToggle.textContent = LAYOUT_MODE_LABELS[mode];

    resizeCanvas();
}

const savedLayoutMode = localStorage.getItem("wtmfd_layout") || "sidebar";
// Auto-detect phones: if the screen is narrow enough that the desktop
// sidebar would be unusable, force mobile layout regardless of what's
// saved — the person can still toggle back if they want, but the default
// experience on a phone should just work without manual switching.
const effectiveLayout = (window.innerWidth <= 600 && savedLayoutMode === "sidebar") ? "toolbar" : savedLayoutMode;
applyLayoutMode(effectiveLayout);

if (btnLayoutToggle) {
    btnLayoutToggle.addEventListener("click", () => {
        const currentMode = localStorage.getItem("wtmfd_layout") || "sidebar";
        const nextMode = currentMode === "sidebar" ? "toolbar" : "sidebar";
        localStorage.setItem("wtmfd_layout", nextMode);
        applyLayoutMode(nextMode);
    });
}

// ---------- Accessibility: Large Text Mode ----------
// Global flag other functions can check (see largeTextCanvasFont below) -
// the CSS override (mfd.css) handles every normal DOM element, but canvas-
// drawn text (the measuring tool's distance readout, map legends, etc.)
// is invisible to CSS entirely and needs its own explicit size bump.
let largeTextMode = false;

// Scales a canvas font-size declaration up when Large Text Mode is on -
// e.g. largeTextCanvasFont(16) returns "bold 16px monospace" normally, or
// a noticeably bigger size when the mode is active. Centralized here so
// every canvas text call can opt in with one line instead of each
// duplicating its own if/else.
function largeTextCanvasFont(basePx, weight = "bold") {
    const px = largeTextMode ? Math.round(basePx * 1.4) : basePx;
    return `${weight} ${px}px monospace`;
}

// Scales a canvas lineWidth up when Large Text Mode is on - used for the
// threat rings and CCIP/weapon-range indicators specifically (per
// request), not every stroke in the app.
function largeTextLineWidth(basePx) {
    return largeTextMode ? basePx * 1.8 : basePx;
}

function applyLargeTextMode(enabled) {
    largeTextMode = enabled;
    document.body.classList.toggle("large-text-mode", enabled);
    resizeCanvas();
}

const savedLargeTextMode = localStorage.getItem("wtmfd_large_text") === "1";
if (chkLargeText) {
    chkLargeText.checked = savedLargeTextMode;
    applyLargeTextMode(savedLargeTextMode);
    chkLargeText.addEventListener("change", () => {
        localStorage.setItem("wtmfd_large_text", chkLargeText.checked ? "1" : "0");
        applyLargeTextMode(chkLargeText.checked);
    });
}

// ---------- Fullscreen toggle (popup window / phone browser tab) ----------
// Inside the real extension: browser.windows.update(id, {state:
// "fullscreen"}) - Firefox popup windows are known to NOT support the
// native title-bar maximize button consistently (confirmed via Mozilla's
// own extension developer forum), so this button is the real control,
// not a backup for a native one.
// Outside the extension (phone browser, via mfd/serve.py): there's no
// window to resize - browser.windows doesn't exist there at all - so this
// falls back to the standard Fullscreen Web API instead, which is exactly
// what a phone browser DOES support well.
if (btnFullscreen) {
    btnFullscreen.addEventListener("click", async () => {
        try {
            if (IS_EXTENSION_CONTEXT && extensionApi?.windows) {
                const win = await extensionApi.windows.getCurrent();
                const goingFullscreen = win.state !== "fullscreen";
                await extensionApi.windows.update(win.id, {
                    state: goingFullscreen ? "fullscreen" : "normal"
                });
                btnFullscreen.textContent = goingFullscreen ? "🗗" : "⛶";
            } else if (document.fullscreenElement) {
                await document.exitFullscreen();
                btnFullscreen.textContent = "⛶";
            } else {
                await document.documentElement.requestFullscreen();
                btnFullscreen.textContent = "🗗";
            }
        } catch (err) {
            console.error("[WT MFD] Fullscreen toggle failed:", err);
        }
    });
}

if (btnToggleDrawer) {
    btnToggleDrawer.addEventListener("click", () => {
        document.body.classList.toggle("sidebar-open");
    });
}

// Map scale is now calibrated PER AXIS, not as one overall scale factor -
// a single factor can't fix the map's aspect ratio being wrong, which we
// have real reason to suspect (grid_size's X/Y ratio was never verified
// against anything real). Two distances measured in different directions
// get fit independently, so a genuine aspect-ratio error shows up as
// different X vs Y scales instead of being invisibly absorbed into one
// number. Falls back to one isotropic scale until there are enough
// directionally-diverse points to solve X and Y separately.
let calibratedSpanX = null; // meters per world-x-fraction-unit, once solved
let calibratedSpanY = null; // meters per world-y-fraction-unit, once solved
let mapScaleCalibrationPoints = []; // [{trueMeters, dx, dy, lockedRange?, altitude?}] - manual, individually reviewable
let autoCalibrationPoints = []; // same shape, collected passively from flight path - bulk, not individually listed
const MAX_AUTO_CALIBRATION_POINTS = 300;
let calibratedMapId = null;

function getMapSpanXMeters() {
    if (calibratedSpanX != null) return calibratedSpanX;
    return mapInfo?.grid_size?.[0] || 65000;
}
function getMapSpanYMeters() {
    if (calibratedSpanY != null) return calibratedSpanY;
    return mapInfo?.grid_size?.[1] || getMapSpanXMeters();
}
// Uncorrected span, used specifically for capturing new calibration points -
// calibrating against an already-corrected value would compound errors.
function getRawMapSpanXMeters() {
    return mapInfo?.grid_size?.[0] || 65000;
}
function getRawMapSpanYMeters() {
    return mapInfo?.grid_size?.[1] || getRawMapSpanXMeters();
}

function mapScaleStorageKey(mapId) {
    return `wtmfd_mapscale_${mapId}`;
}

function loadMapScaleCalibration(mapId) {
    calibratedMapId = mapId;
    try {
        const saved = localStorage.getItem(mapScaleStorageKey(mapId));
        const parsed = saved ? JSON.parse(saved) : null;
        mapScaleCalibrationPoints = parsed?.points ?? [];
        autoCalibrationPoints = parsed?.autoPoints ?? [];
    } catch (e) {
        mapScaleCalibrationPoints = [];
        autoCalibrationPoints = [];
    }
    recomputeMapScaleFit();

    // A map that already has a calibration from a previous session skips
    // straight to idle (with periodic revalidation) instead of redoing
    // the full initial collection - a fresh map waits for real airspeed
    // before starting the clock.
    if (calibratedSpanX != null) {
        calibrationState = "idle";
        nextRevalidationTime = performance.now() + REVALIDATION_INTERVAL_MS;
    } else {
        calibrationState = "waiting-for-speed";
        nextRevalidationTime = null;
    }
    collectingReason = null;
    collectingStartTime = null;
    revalidationSampleCount = 0;
    lastFlightSample = null;

    renderCalibrationPointsList();
}

function saveMapScaleCalibration() {
    if (calibratedMapId == null) return;
    localStorage.setItem(mapScaleStorageKey(calibratedMapId), JSON.stringify({
        points: mapScaleCalibrationPoints,
        autoPoints: autoCalibrationPoints
    }));
}

function getAllCalibrationPoints() {
    return mapScaleCalibrationPoints.concat(autoCalibrationPoints);
}

// Solves true_i^2 = dx_i^2 * spanX^2 + dy_i^2 * spanY^2 for spanX, spanY
// via linear least squares (linear in spanX^2/spanY^2) - this is what
// actually separates "overall scale is off" from "aspect ratio is off",
// which a single true=factor*raw fit structurally cannot do. Falls back
// to isotropic (spanX=spanY) when points don't have enough directional
// spread to solve for both independently (e.g. all roughly horizontal).
function recomputeMapScaleFit() {
    const points = getAllCalibrationPoints();
    if (points.length === 0) {
        calibratedSpanX = null;
        calibratedSpanY = null;
        return;
    }

    let Sxx = 0, Sxy = 0, Syy = 0, Sxt = 0, Syt = 0;
    for (const p of points) {
        const dx2 = p.dx * p.dx, dy2 = p.dy * p.dy, t2 = p.trueMeters * p.trueMeters;
        Sxx += dx2 * dx2;
        Sxy += dx2 * dy2;
        Syy += dy2 * dy2;
        Sxt += dx2 * t2;
        Syt += dy2 * t2;
    }

    const det = Sxx * Syy - Sxy * Sxy;
    const scale = Sxx * Syy || 1;
    // Relative threshold, not absolute - world-fraction deltas are 0..1,
    // so raised to the 4th power these numbers are naturally tiny (~1e-12)
    // regardless of how well-conditioned the system actually is. An
    // absolute cutoff would always trigger the fallback.
    if (Math.abs(det) / scale < 1e-6 || points.length < 2) {
        let sumTT = 0, sumDD = 0;
        for (const p of points) {
            const d2 = p.dx * p.dx + p.dy * p.dy;
            sumTT += d2 * (p.trueMeters * p.trueMeters);
            sumDD += d2 * d2;
        }
        const isoSpan = sumDD > 0 ? Math.sqrt(sumTT / sumDD) : (mapInfo?.grid_size?.[0] || 65000);
        calibratedSpanX = isoSpan;
        calibratedSpanY = isoSpan;
        return;
    }

    const a2 = (Sxt * Syy - Syt * Sxy) / det; // spanX^2
    const b2 = (Sxx * Syt - Sxy * Sxt) / det; // spanY^2
    calibratedSpanX = a2 > 0 ? Math.sqrt(a2) : (mapInfo?.grid_size?.[0] || 65000);
    calibratedSpanY = b2 > 0 ? Math.sqrt(b2) : calibratedSpanX;
}

let lastYScaleSource = "fallback";

function renderCalibrationPointsList() {
    if (!calibrationPointsListEl) return;
    let html = "";
    if (mapScaleCalibrationPoints.length === 0) {
        html += "No manual data points yet for this map.";
    } else {
        html += mapScaleCalibrationPoints.map((p, i) => {
            const slantNote = p.lockedRange != null
                ? ` (locked ${p.lockedRange.toFixed(0)}m @ ${p.altitude.toFixed(0)}m alt)`
                : "";
            const angleDeg = (Math.atan2(Math.abs(p.dy), Math.abs(p.dx)) * 180 / Math.PI).toFixed(0);
            return `#${i + 1}: ground ${p.trueMeters.toFixed(0)}m${slantNote} (${angleDeg}° off horizontal) `
                + `<button data-remove-index="${i}" style="font-size:9px; padding:1px 5px;">✕</button>`;
        }).join("<br>");
    }
    const stateNote = describeCalibrationState();
    if (autoCalibrationPoints.length > 0 || stateNote) {
        html += `<br><span style="color:#00ffcc;">+ ${autoCalibrationPoints.length} auto-collected from flight path${stateNote ? " (" + stateNote + ")" : ""}</span>`;
    }
    calibrationPointsListEl.innerHTML = html;

    calibrationPointsListEl.querySelectorAll("[data-remove-index]").forEach(btn => {
        btn.addEventListener("click", () => {
            const idx = parseInt(btn.getAttribute("data-remove-index"), 10);
            mapScaleCalibrationPoints.splice(idx, 1);
            recomputeMapScaleFit();
            saveMapScaleCalibration();
            renderCalibrationPointsList();
        });
    });

    if (elCalibrationFactor) {
        const totalPoints = mapScaleCalibrationPoints.length + autoCalibrationPoints.length;
        if (calibratedSpanX == null) {
            elCalibrationFactor.textContent = "not calibrated (using grid_size as-is)";
        } else {
            const aspectOff = Math.abs(calibratedSpanX - calibratedSpanY) / calibratedSpanX > 0.02;
            const aspectNote = aspectOff
                ? ` - X and Y differ (${calibratedSpanX.toFixed(0)}m vs ${calibratedSpanY.toFixed(0)}m/unit) - real aspect-ratio correction, not just overall scale`
                : "";
            const modeNote = totalPoints >= 2 && !aspectOff && calibratedSpanX === calibratedSpanY
                ? " [isotropic fallback - add a point in a different direction to solve X/Y separately]"
                : "";
            elCalibrationFactor.textContent = `spanX ${calibratedSpanX.toFixed(0)}m, spanY ${calibratedSpanY.toFixed(0)}m per unit (from ${totalPoints} point${totalPoints === 1 ? "" : "s"})${aspectNote}${modeNote}`;
        }
    }
}

if (btnAddCalibrationPoint) {
    btnAddCalibrationPoint.addEventListener("click", () => {
        const lockedRange = parseFloat(inputTrueDistance?.value);
        const altitude = parseFloat(inputCalibAltitude?.value) || 0;
        if (!lockedRange || lockedRange <= 0) {
            alert("Enter a valid locked range in meters first.");
            return;
        }
        if (lastRawMeasurementDelta == null) {
            alert("Take a measurement with the right-click tool first, then add the locked range for that same measurement.");
            return;
        }
        // A locked range against a boat (~sea level target) is a slant
        // distance through the air, not the ground/map distance the
        // ruler measures - correct via Pythagoras before using it as a
        // calibration target.
        const trueMeters = Math.sqrt(Math.max(0, lockedRange * lockedRange - altitude * altitude));
        mapScaleCalibrationPoints.push({
            trueMeters,
            dx: lastRawMeasurementDelta.dx,
            dy: lastRawMeasurementDelta.dy,
            lockedRange,
            altitude
        });
        recomputeMapScaleFit();
        saveMapScaleCalibration();
        renderCalibrationPointsList();
    });
}

// Wipes ALL calibration data for the current map (both manually-added
// points and auto-collected ones) and restarts the auto-calibration
// lifecycle from the beginning, as if this were a never-before-seen map.
// Factored out from what used to be two separate "Clear Manual Points" /
// "Clear Auto Points" buttons - combined into one action since in practice
// there was never a good reason to clear just one and not the other, and
// two overlapping buttons were more UI clutter than useful granularity.
function recalibrateMap() {
    mapScaleCalibrationPoints = [];
    autoCalibrationPoints = [];
    lastFlightSample = null;
    calibrationState = "waiting-for-speed"; // restart the full lifecycle, not just the timer
    collectingReason = null;
    collectingStartTime = null;
    nextRevalidationTime = null;
    recomputeMapScaleFit();
    saveMapScaleCalibration();
    renderCalibrationPointsList();
}

if (btnRecalibrateMap) {
    btnRecalibrateMap.addEventListener("click", recalibrateMap);
}

// ---------- Auto-calibration from flight path ----------
// State machine instead of a single fixed timer:
//   waiting-for-speed -> collecting (initial) -> idle -> collecting (revalidation) -> idle -> ...
// - A map that already has a saved calibration skips straight to idle -
//   no need to redo work that's already done.
// - A map with no calibration yet waits until airspeed is actually above
//   a real "flying" threshold before starting the clock, so taxiing/
//   takeoll roll doesn't burn the collection window on near-zero-speed
//   noise.
// - Once calibrated, a brief revalidation runs periodically to confirm
//   (or, if the data's actually changed, refine) the calibration - a
//   handful of samples, not a repeat of the full initial collection.
let lastFlightSample = null; // {x, y, speedMs, timestamp}
let calibrationState = "waiting-for-speed"; // "waiting-for-speed" | "collecting" | "idle"
let collectingReason = null; // "initial" | "revalidation"
let collectingStartTime = null;
let revalidationSampleCount = 0;
let nextRevalidationTime = null;

const SPEED_THRESHOLD_KMH = 200; // don't start initial calibration below this
const INITIAL_CALIBRATION_MS = 60000; // 60s collection window for a fresh map
const REVALIDATION_INTERVAL_MS = 5 * 60 * 1000; // re-check every 5 minutes
const REVALIDATION_MAX_MS = 30000; // cap a revalidation pass at 30s
const REVALIDATION_TARGET_SAMPLES = 6; // ...or stop early once this many good samples land

function describeCalibrationState() {
    const now = performance.now();
    if (calibrationState === "waiting-for-speed") {
        return `waiting for airspeed > ${SPEED_THRESHOLD_KMH}km/h to start calibrating`;
    }
    if (calibrationState === "collecting") {
        const maxDuration = collectingReason === "initial" ? INITIAL_CALIBRATION_MS : REVALIDATION_MAX_MS;
        const secsLeft = Math.max(0, Math.ceil((maxDuration - (now - collectingStartTime)) / 1000));
        return collectingReason === "initial"
            ? `collecting initial calibration - ${secsLeft}s left`
            : `revalidating - ${revalidationSampleCount}/${REVALIDATION_TARGET_SAMPLES} samples, ${secsLeft}s left`;
    }
    if (calibrationState === "idle" && nextRevalidationTime != null) {
        const minsLeft = Math.max(0, Math.ceil((nextRevalidationTime - now) / 60000));
        return `calibrated - next check in ~${minsLeft}min`;
    }
    return "";
}

function updateCalibrationState() {
    const now = performance.now();

    if (calibrationState === "waiting-for-speed") {
        const speedKmh = latestState?.["TAS, km/h"] ?? latestState?.["IAS, km/h"] ?? 0;
        if (speedKmh > SPEED_THRESHOLD_KMH) {
            calibrationState = "collecting";
            collectingReason = "initial";
            collectingStartTime = now;
            lastFlightSample = null;
        }
        return;
    }

    if (calibrationState === "idle") {
        if (nextRevalidationTime != null && now >= nextRevalidationTime) {
            calibrationState = "collecting";
            collectingReason = "revalidation";
            collectingStartTime = now;
            revalidationSampleCount = 0;
            lastFlightSample = null;
        }
        return;
    }

    if (calibrationState === "collecting") {
        const elapsed = now - collectingStartTime;
        const maxDuration = collectingReason === "initial" ? INITIAL_CALIBRATION_MS : REVALIDATION_MAX_MS;
        const sampleCap = collectingReason === "revalidation" ? revalidationSampleCount >= REVALIDATION_TARGET_SAMPLES : false;
        if (elapsed > maxDuration || sampleCap) {
            calibrationState = "idle";
            nextRevalidationTime = now + REVALIDATION_INTERVAL_MS;
            lastFlightSample = null;
        }
    }
}

function sampleFlightCalibration() {
    if (!chkAutoCalibrate?.checked) return;
    updateCalibrationState();
    if (calibrationState !== "collecting") return;

    const player = findPlayerObject();
    if (!player || typeof player.x !== "number" || lastPlayerLockState !== "exact") return;

    const now = performance.now();
    const { vx0 } = computeReleaseVelocityComponents(); // horizontal ground speed estimate, m/s

    if (lastFlightSample) {
        const dt = (now - lastFlightSample.timestamp) / 1000;
        // Skip gaps too large (pause, alt-tab, match transition) or too
        // small (dominated by poll-timing noise rather than real movement).
        if (dt > 0.15 && dt < 2.0) {
            const dx = player.x - lastFlightSample.x;
            const dy = player.y - lastFlightSample.y;
            const dist = Math.hypot(dx, dy);
            // Filter out near-zero movement (parked, or between-match
            // noise) where position quantization would dominate the signal.
            if (dist > 0.0003) {
                const avgSpeed = (vx0 + lastFlightSample.speedMs) / 2;
                const trueMeters = avgSpeed * dt;
                if (trueMeters > 5) {
                    autoCalibrationPoints.push({ dx, dy, trueMeters, auto: true });
                    if (autoCalibrationPoints.length > MAX_AUTO_CALIBRATION_POINTS) {
                        autoCalibrationPoints.shift();
                    }
                    if (collectingReason === "revalidation") revalidationSampleCount++;
                    recomputeMapScaleFit();
                    saveMapScaleCalibration();
                    renderCalibrationPointsList();
                }
            }
        }
    }
    lastFlightSample = { x: player.x, y: player.y, speedMs: vx0, timestamp: now };
}

// yScale is now just the ratio of the two independently-calibrated spans -
// once calibration has real data, this correctly reflects any genuine
// aspect-ratio difference instead of assuming grid_size's ratio is right.
function getMapYScaleFactor() {
    if (calibratedSpanX != null) {
        lastYScaleSource = "calibration";
        return calibratedSpanY / calibratedSpanX;
    }
    if (mapInfo?.grid_size?.[0] && mapInfo?.grid_size?.[1]) {
        lastYScaleSource = "grid_size (uncalibrated)";
        return mapInfo.grid_size[1] / mapInfo.grid_size[0];
    }
    if (mapImage && mapImage.naturalWidth && mapImage.naturalHeight) {
        lastYScaleSource = "image (grid_size unavailable!)";
        return mapImage.naturalHeight / mapImage.naturalWidth;
    }
    lastYScaleSource = "fallback=1 (neither available!)";
    return 1;
}

function updateMapScaleDebug() {
    if (!elZoom) return;
    elZoom.textContent = zoom.toFixed(2) + "x";
    elSpanX.textContent = mapInfo?.grid_size?.[0]
        ? `${getMapSpanXMeters().toFixed(0)} m (raw grid_size ${mapInfo.grid_size[0].toFixed(0)})`
        : "N/A (using 65000 default)";
    elYScale.textContent = `${getMapYScaleFactor().toFixed(4)} (${lastYScaleSource})`;
}

function resizeCanvas() {
    const rect = canvas.parentElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    // Only touch canvas.width/height when they actually changed - setting
    // them (even to the same value) clears the canvas, and we're about to
    // call this every frame instead of just on the "resize" event.
    if (canvas.width !== rect.width || canvas.height !== rect.height) {
        canvas.width = rect.width;
        canvas.height = rect.height;
    }
}
window.addEventListener("resize", resizeCanvas);
resizeCanvas();

function worldToScreen(wx, wy) {
    const yScale = getMapYScaleFactor();
    return [
        (wx * canvas.width * zoom) + panX,
        (wy * canvas.width * yScale * zoom) + panY
    ];
}

function screenToWorld(sx, sy) {
    const yScale = getMapYScaleFactor();
    return [
        (sx - panX) / (canvas.width * zoom),
        (sy - panY) / (canvas.width * yScale * zoom)
    ];
}

function updateFollowButtonStyle() {
    if (isJetCentered) {
        btnToggleFollow.textContent = "FOLLOW JET: ON";
        btnToggleFollow.style.background = "#00ffcc";
        btnToggleFollow.style.color = "#080c14";
    } else {
        btnToggleFollow.textContent = "FOLLOW JET: OFF";
        btnToggleFollow.style.background = "#22314a";
        btnToggleFollow.style.color = "#8b9bb4";
    }
}

// Single source of truth for centering the view on a world coordinate -
// must stay in sync with worldToScreen's actual projection (which uses
// canvas.width * yScale for Y, not canvas.height). Duplicating this math
// in multiple places is exactly what caused it to silently go stale when
// the projection was fixed - route everything through here instead.
function centerViewOn(wx, wy) {
    const yScale = getMapYScaleFactor();
    panX = (canvas.width / 2) - (wx * canvas.width * zoom);
    panY = (canvas.height / 2) - (wy * canvas.width * yScale * zoom);
}

function updatePlayerLockUI() {
    if (!elPlayerLock) return;
    if (lastPlayerLockState === "exact") {
        elPlayerLock.textContent = "OK";
        elPlayerLock.className = "telemetry-val status-safe";
    } else if (lastPlayerLockState === "fallback") {
        elPlayerLock.textContent = "UNCERTAIN";
        elPlayerLock.className = "telemetry-val status-caution";
    } else {
        elPlayerLock.textContent = "LOST";
        elPlayerLock.className = "telemetry-val status-danger";
    }
}

function centerOnPlayer() {
    const playerObj = findPlayerObject();
    if (playerObj && typeof playerObj.x === "number" && typeof playerObj.y === "number") {
        centerViewOn(playerObj.x, playerObj.y);
    }
}

btnToggleFollow.addEventListener("click", () => {
    isJetCentered = !isJetCentered;
    updateFollowButtonStyle();
    if (isJetCentered) centerOnPlayer();
});

canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const cursorX = e.clientX - rect.left;
    const cursorY = e.clientY - rect.top;
    const zoomFactor = e.deltaY < 0 ? 1.12 : 0.88;
    const newZoom = Math.min(Math.max(zoom * zoomFactor, 0.5), 12.0);
    panX = cursorX - (cursorX - panX) * (newZoom / zoom);
    panY = cursorY - (cursorY - panY) * (newZoom / zoom);
    zoom = newZoom;
});

canvas.addEventListener("mousedown", (e) => {
    const rect = canvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    if (e.button === 0) {
        isPanning = true;
        isJetCentered = false;
        updateFollowButtonStyle();
        startPanX = clickX - panX;
        startPanY = clickY - panY;
    } else if (e.button === 2) {
        isMeasuring = true;
        const [wx, wy] = screenToWorld(clickX, clickY);
        measureStartWorld = { x: wx, y: wy };
        measureCurrentWorld = { x: wx, y: wy };
        activeMeasurement = { start: measureStartWorld, current: measureCurrentWorld };
    }
});

canvas.addEventListener("mousemove", (e) => {
    const rect = canvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    if (isPanning) {
        panX = clickX - startPanX;
        panY = clickY - startPanY;
    } else if (isMeasuring) {
        const [wx, wy] = screenToWorld(clickX, clickY);
        measureCurrentWorld = { x: wx, y: wy };
        activeMeasurement.current = measureCurrentWorld;
    }
});

// Finalizes an in-progress measurement (logs the cross-check, stores the
// raw delta for calibration) - factored out so both the mouse (right-
// click release) and touch (measure-mode finger release) paths use the
// exact same logic instead of two copies that could quietly drift apart.
function finalizeMeasurement() {
    if (!activeMeasurement) return;
    const { start, current } = activeMeasurement;
    // Path A: same math the on-screen readout uses (world -> screen
    // pixels via zoom/pan, then pixels -> meters).
    const [sx, sy] = worldToScreen(start.x, start.y);
    const [cx, cy] = worldToScreen(current.x, current.y);
    const pixelPath = Math.hypot(cx - sx, cy - sy) / currentPixelsPerMeter;
    // Path B: straight from world-fraction coordinates and the
    // current calibrated span, bypassing zoom/pan/canvas entirely.
    const spanX = getMapSpanXMeters();
    const spanY = getMapSpanYMeters();
    const dxMeters = (current.x - start.x) * spanX;
    const dyMeters = (current.y - start.y) * spanY;
    const fractionPath = Math.hypot(dxMeters, dyMeters);
    console.log("[WT MFD] measurement cross-check - via screen/zoom/pan:", pixelPath.toFixed(1), "m | via raw world fraction:", fractionPath.toFixed(1), "m | zoom:", zoom.toFixed(2), "| yScale source:", lastYScaleSource);

    // Store the RAW world-fraction delta (not pre-scaled by any
    // span) - the per-axis calibration fit needs dx/dy directly to
    // solve for spanX and spanY independently. Also show an
    // uncorrected reference distance in the panel using raw
    // grid_size, for context while entering the locked range.
    lastRawMeasurementDelta = { dx: current.x - start.x, dy: current.y - start.y };
    const rawSpanX = getRawMapSpanXMeters();
    const rawSpanY = getRawMapSpanYMeters();
    const rawDisplayMeters = Math.hypot(lastRawMeasurementDelta.dx * rawSpanX, lastRawMeasurementDelta.dy * rawSpanY);
    if (elRawMeasure) {
        elRawMeasure.textContent = `${rawDisplayMeters.toFixed(1)} m`;
    }
}

window.addEventListener("mouseup", (e) => {
    if (e.button === 0) isPanning = false;
    if (e.button === 2) {
        isMeasuring = false;
        finalizeMeasurement();
    }
});

canvas.addEventListener("contextmenu", (e) => e.preventDefault());

// ---------- Touch controls (Mobile layout) ----------
// One finger drags - either pans the map (default) or draws the
// measuring tool, depending on Touch Measure Mode (toggled via the
// toolbar button in Mobile layout - touch has no left/right-click
// distinction the way a mouse does, so this toggle stands in for "which
// mouse button" here). Two fingers pinch to zoom, anchored at the
// midpoint between them (same "zoom toward where you're looking"
// technique as the wheel handler above, just touch-native).
let touchMeasureMode = false;

if (btnToggleTouchMeasure) {
    btnToggleTouchMeasure.addEventListener("click", () => {
        touchMeasureMode = !touchMeasureMode;
        btnToggleTouchMeasure.textContent = touchMeasureMode ? "📏 MEASURE" : "✋ PAN";
        btnToggleTouchMeasure.style.background = touchMeasureMode ? "#00ffcc" : "";
        btnToggleTouchMeasure.style.color = touchMeasureMode ? "#080c14" : "";
    });
}
let pinchStartDist = null;
let pinchStartZoom = null;
let pinchMidpoint = null;

function getTouchPos(touch) {
    const rect = canvas.getBoundingClientRect();
    return { x: touch.clientX - rect.left, y: touch.clientY - rect.top };
}

canvas.addEventListener("touchstart", (e) => {
    e.preventDefault(); // also suppresses the synthetic mouse events browsers fire after touch, avoiding double-handling
    if (e.touches.length === 1) {
        const pos = getTouchPos(e.touches[0]);
        if (touchMeasureMode) {
            isMeasuring = true;
            const [wx, wy] = screenToWorld(pos.x, pos.y);
            measureStartWorld = { x: wx, y: wy };
            measureCurrentWorld = { x: wx, y: wy };
            activeMeasurement = { start: measureStartWorld, current: measureCurrentWorld };
        } else {
            isPanning = true;
            isJetCentered = false;
            updateFollowButtonStyle();
            startPanX = pos.x - panX;
            startPanY = pos.y - panY;
        }
    } else if (e.touches.length === 2) {
        // Starting a pinch cancels any in-progress single-finger action.
        isPanning = false;
        isMeasuring = false;
        const p1 = getTouchPos(e.touches[0]);
        const p2 = getTouchPos(e.touches[1]);
        pinchStartDist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        pinchStartZoom = zoom;
        pinchMidpoint = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    }
}, { passive: false });

canvas.addEventListener("touchmove", (e) => {
    e.preventDefault();
    if (e.touches.length === 1) {
        const pos = getTouchPos(e.touches[0]);
        if (isPanning) {
            panX = pos.x - startPanX;
            panY = pos.y - startPanY;
        } else if (isMeasuring) {
            const [wx, wy] = screenToWorld(pos.x, pos.y);
            measureCurrentWorld = { x: wx, y: wy };
            activeMeasurement.current = measureCurrentWorld;
        }
    } else if (e.touches.length === 2 && pinchStartDist !== null) {
        const p1 = getTouchPos(e.touches[0]);
        const p2 = getTouchPos(e.touches[1]);
        const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        const newZoom = Math.min(Math.max(pinchStartZoom * (dist / pinchStartDist), 0.5), 12.0);
        panX = pinchMidpoint.x - (pinchMidpoint.x - panX) * (newZoom / zoom);
        panY = pinchMidpoint.y - (pinchMidpoint.y - panY) * (newZoom / zoom);
        zoom = newZoom;
    }
}, { passive: false });

canvas.addEventListener("touchend", (e) => {
    e.preventDefault();
    if (e.touches.length === 0) {
        // All fingers lifted.
        isPanning = false;
        pinchStartDist = null;
        pinchStartZoom = null;
        pinchMidpoint = null;
        if (isMeasuring) {
            isMeasuring = false;
            finalizeMeasurement();
        }
    } else if (e.touches.length === 1) {
        // Went from a pinch (2 fingers) down to 1 - treat the remaining
        // finger as a fresh touch rather than resuming a stale pan/measure
        // start point from before the pinch began.
        pinchStartDist = null;
        pinchStartZoom = null;
        pinchMidpoint = null;
        const pos = getTouchPos(e.touches[0]);
        if (!touchMeasureMode) {
            isPanning = true;
            startPanX = pos.x - panX;
            startPanY = pos.y - panY;
        }
    }
}, { passive: false });

btnResetView.addEventListener("click", () => {
    zoom = 1.0;
    panX = 0;
    panY = 0;
    isJetCentered = true;
    updateFollowButtonStyle();
});

btnCenterPlayer.addEventListener("click", () => {
    isJetCentered = true;
    updateFollowButtonStyle();
    centerOnPlayer();
});

if (btnClearMeasurer) {
    btnClearMeasurer.addEventListener("click", () => {
        activeMeasurement = null;
        measureStartWorld = null;
        measureCurrentWorld = null;
    });
}

async function fetchJSON(path) {
    // cache: "no-store" already prevents caching - no need for a
    // belt-and-suspenders "?_=timestamp" cache-buster on top of it.
    const res = await fetch(`${BASE}${path}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

// TEMPORARY - vehicle-detection field discovery
// ------------------------------------------------------------
// We don't yet know which field (if any) in /state or /indicators
// carries the current aircraft's identity, or whether its format
// lines up with the aircraft-weapons-db.json identifiers (e.g.
// "f_16c_block_50"). Logs the full object ONCE when the debug
// checkbox is on, so we can eyeball every field name instead of
// guessing. Re-run anytime from the browser console with:
//   logVehicleFieldsNow()
// Safe to delete this whole block once we've found the right field.
let loggedVehicleFieldsOnce = false;
function logVehicleFieldsNow() {
    console.log("[WT MFD] /state fields:", latestState);
    console.log("[WT MFD] /indicators fields:", latestIndicators);
}
window.logVehicleFieldsNow = logVehicleFieldsNow;

async function pollFast() {
    try {
        const [state, indicators] = await Promise.all([
            fetchJSON("/state"),
            fetchJSON("/indicators")
        ]);
        latestState = state;
        latestIndicators = indicators;
        isConnected = true;
        elStatus.textContent = "ONLINE";
        elStatus.style.color = "#00ffcc";

        if (chkDebugLog?.checked && !loggedVehicleFieldsOnce) {
            loggedVehicleFieldsOnce = true;
            logVehicleFieldsNow();
        }

        tryAutoDetectVehicle();

        updateTelemetryUI();
        updateWeaponInfo();
        updateTrajectoryDebug();
    } catch (e) {
        isConnected = false;
        elStatus.textContent = "OFFLINE";
        elStatus.style.color = "#ff3366";
    }
    setTimeout(pollFast, FAST_POLL_MS);
}

async function pollSlow() {
    if (isConnected) {
        try {
            const mapObj = await fetchJSON("/map_obj.json");
            latestMapObj = Array.isArray(mapObj) ? mapObj : [];

            // Airfields are regular objects within map_obj.json
            // (type: "airfield", with sx/sy/ex/ey line-segment fields) -
            // NOT a separate "airfields" array in map_info.json, which
            // doesn't have that field at all (confirmed schema: grid_size,
            // grid_steps, grid_zero, hud_type, map_generation, map_max,
            // map_min, valid). airfieldsList was reading from a field that
            // never existed, so airfields never rendered.
            airfieldsList = latestMapObj.filter(o => o.type === "airfield");
            sampleFlightCalibration();

            if (chkDebugLog?.checked) {
                for (const obj of latestMapObj) {
                    const sig = JSON.stringify(Object.keys(obj).sort()) + "|" + (obj.type ?? "") + "|" + (obj.icon ?? "");
                    if (!seenObjectSignatures.has(sig)) {
                        seenObjectSignatures.add(sig);
                        console.log("[WT MFD] new map object shape:", obj);
                    }
                }
            }
        } catch (e) {}
    }
    setTimeout(pollSlow, SLOW_POLL_MS);
}

async function pollMapMeta() {
    if (isConnected) {
        try {
            const info = await fetchJSON("/map_info.json");
            if (info && info.valid) {
                mapInfo = info;
                // Only reload the map image when the map actually changed -
                // previously this refetched+redecoded the full image every
                // single poll (every 1s), which is wasted bandwidth/CPU for
                // the entire match and a likely source of stutter.
                if (info.map_generation !== currentMapGeneration) {
                    currentMapGeneration = info.map_generation;
                    seenObjectSignatures.clear();
                    loadMapScaleCalibration(info.map_generation);
                    const img = new Image();
                    img.onload = () => { mapImage = img; };
                    img.src = `${BASE}/map.img?_=${Date.now()}`;
                }
            }
        } catch (e) {
            console.warn("Failed to fetch map_info.json meta:", e);
        }
    }
    setTimeout(pollMapMeta, MAP_META_POLL_MS);
}

// Surfaces the raw Vy value and what we derived from it, so the sign
// convention (does negative mean descending, as assumed, or the reverse?)
// can be checked directly against reality instead of guessed again.
function updateTrajectoryDebug() {
    if (!elVyRaw) return;
    const profile = getCurrentWeaponProfile();
    // Trajectory debug applies to any bomb/glide_bomb that runs the real
    // physics simulation - which is now both hand-entered (COUNTRY_WEAPONS)
    // AND database-sourced bombs (see computeWeaponRangeMeters). Missiles
    // never run the simulation, so they're excluded either way.
    if (!profile || (profile.type !== "bomb" && profile.type !== "glide_bomb")) {
        elVyRaw.textContent = "-";
        elV0.textContent = "-";
        elReleaseAlt.textContent = "-";
        return;
    }
    const vyRaw = latestState?.["Vy, m/s"];
    elVyRaw.textContent = (typeof vyRaw === "number") ? vyRaw.toFixed(1) : "N/A (field missing)";
    const { vx0, vy0 } = computeReleaseVelocityComponents();
    elV0.textContent = `${vx0.toFixed(0)} / ${vy0.toFixed(0)} m/s`;
    // Same altitude source as computeWeaponRangeMeters (sea-level/reference
    // altitude - no ground-relative field exists in the API, see note there).
    const releaseAltitude = Math.max(10, latestState?.["H, m"] ?? latestState?.["altitude_hour"] ?? 500);
    elReleaseAlt.textContent = `${releaseAltitude.toFixed(0)} m`;
}

function updateTelemetryUI() {
    if (!latestState) return;
    const alt = latestState["H, m"] ?? latestState["altitude_hour"] ?? 0;
    const speed = latestState["IAS, km/h"] ?? latestState["TAS, km/h"] ?? 0;
    elAlt.textContent = Math.round(alt);
    elSpeed.textContent = Math.round(speed);
    if (latestState["radar_target_range"]) {
        elRadar.textContent = `${Math.round(latestState["radar_target_range"])} M`;
        elRadar.style.color = "#ff3366";
    } else {
        elRadar.textContent = "NO LOCK";
        elRadar.style.color = "#fff";
    }
    // Auto-fill the calibration altitude field with live altitude, unless
    // the user currently has it focused (mid-edit) - don't fight typing.
    if (inputCalibAltitude && document.activeElement !== inputCalibAltitude) {
        inputCalibAltitude.value = Math.round(alt);
    }
}

// ---------- Safety / engagement status ----------
// This is the actual point of the tool: tell the pilot, at a glance,
// whether they're (a) inside an enemy AA threat ring right now, and
// (b) within their own weapon's reach of the nearest viable target -
// so "in range to hit, still safe from AA" is a fact you can read
// instead of eyeballing overlapping circles.
function updateSafetyStatus(playerObj) {
    computeAirThreats(playerObj);
    updateAirThreatUI();

    if (!playerObj || typeof playerObj.x !== "number") {
        elThreat.textContent = "NO DATA";
        elThreat.className = "telemetry-val";
        elTarget.textContent = "-";
        elInRange.textContent = "-";
        return;
    }

    const isDynamic = chkDynamicRange?.checked ?? true;
    const currentAlt = latestState?.["H, m"] ?? latestState?.["altitude_hour"] ?? 500;
    const altFactor = Math.max(0.3, 1.0 - (currentAlt / 8000));
    // Read fresh rather than the cached currentMapSpanMeters, since this
    // function now runs once per frame regardless of which view is active -
    // the cache is only guaranteed current while the map view itself runs.
    const mapSpanMeters = getMapSpanXMeters();

    // --- AA threat check (enemy only) ---
    // Two-tier: the drawn ring's edge (max envelope, scaled by altitude if
    // dynamic scaling is on) is CAUTION - you might be engaged depending on
    // which specific vehicle this generic icon represents. Inside the
    // profile's unscaled minimum is DANGER - most such vehicles can reach
    // you at this distance regardless of the dynamic multiplier.
    let nearestThreat = null;
    for (const obj of latestMapObj) {
        if (typeof obj.x !== "number") continue;
        const profile = classifyStrictAA(obj);
        if (!profile) continue;
        if (classifyTeam(obj) !== "enemy") continue;

        const distMeters = Math.hypot(obj.x - playerObj.x, obj.y - playerObj.y) * mapSpanMeters;
        const outerMeters = isDynamic ? (profile.maxRangeM * altFactor) : profile.minRangeM;
        if (distMeters > outerMeters) continue;

        const severity = (isDynamic && distMeters > profile.minRangeM) ? "caution" : "danger";
        if (!nearestThreat || distMeters < nearestThreat.distMeters) {
            nearestThreat = { profile, distMeters, severity };
        }
    }

    if (nearestThreat) {
        const tag = nearestThreat.severity === "danger" ? "DANGER" : "CAUTION";
        elThreat.textContent = `${tag}: ${nearestThreat.profile.label} ${(nearestThreat.distMeters / 1000).toFixed(1)}KM`;
        elThreat.className = nearestThreat.severity === "danger" ? "telemetry-val status-danger" : "telemetry-val status-caution";
    } else {
        elThreat.textContent = "CLEAR";
        elThreat.className = "telemetry-val status-safe";
    }

    // --- Nearest target appropriate to the currently selected weapon ---
    const profile = getCurrentWeaponProfile();

    let nearestTarget = null;
    for (const obj of latestMapObj) {
        if (typeof obj.x !== "number") continue;
        if (obj === playerObj) continue;
        if (classifyTeam(obj) === "friendly") continue;
        if (!isValidTargetForWeapon(obj, profile)) continue;
        const distMeters = Math.hypot(obj.x - playerObj.x, obj.y - playerObj.y) * mapSpanMeters;
        if (!nearestTarget || distMeters < nearestTarget.distMeters) {
            nearestTarget = { obj, distMeters };
        }
    }

    if (nearestTarget) {
        const label = nearestTarget.obj.icon || nearestTarget.obj.type || "contact";
        elTarget.textContent = `${label} @ ${(nearestTarget.distMeters / 1000).toFixed(1)}KM`;

        const weaponRangeMeters = computeWeaponRangeMeters(profile);
        if (weaponRangeMeters != null) {
            const inRange = nearestTarget.distMeters <= weaponRangeMeters;
            elInRange.textContent = inRange ? "YES" : "NO";
            elInRange.className = inRange ? "telemetry-val status-safe" : "telemetry-val";
        } else {
            elInRange.textContent = "-";
            elInRange.className = "telemetry-val";
        }
    } else {
        elTarget.textContent = "NONE VISIBLE";
        elInRange.textContent = "-";
        elInRange.className = "telemetry-val";
    }
}

function drawPlayerMarker() {
    // Normal player icon: a filled heading-pointing triangle, matching the
    // same shape convention as enemy aircraft (drawEnemyFighter) rather
    // than the hollow crosshair circle used temporarily for the
    // measurement tool's precision-calibration work - reverted now that
    // that's done. Bumped slightly (not dramatically) in Large Text Mode.
    const size = largeTextMode ? 11 : 9;
    ctx.beginPath();
    ctx.moveTo(size * 1.3, 0);
    ctx.lineTo(-size * 0.9, size * 0.9);
    ctx.lineTo(-size * 0.5, 0);
    ctx.lineTo(-size * 0.9, -size * 0.9);
    ctx.closePath();
    ctx.fillStyle = "#00ffcc";
    ctx.fill();
    ctx.stroke();
}

function drawEnemyFighter(size) {
    ctx.beginPath();
    ctx.moveTo(size * 1.2, 0);
    ctx.lineTo(-size, size * 0.8);
    ctx.lineTo(-size * 0.5, 0);
    ctx.lineTo(-size, -size * 0.8);
    ctx.closePath();
}

function drawEnemyHelo(size) {
    ctx.beginPath();
    ctx.moveTo(-size * 1.4, size * 0.2); ctx.lineTo(size * 1.4, -size * 0.2);
    ctx.moveTo(-size * 1.4, -size * 0.2); ctx.lineTo(size * 1.4, size * 0.2);
    ctx.moveTo(size * 0.6, 0); ctx.lineTo(-size * 0.6, size * 0.4); ctx.lineTo(-size * 0.6, -size * 0.4);
    ctx.closePath();
}

function drawSPAAGIcon(size) {
    ctx.beginPath();
    ctx.rect(-size * 0.8, -size * 0.8, size * 1.6, size * 1.6);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-size * 0.8, -size * 0.4); ctx.lineTo(-size * 1.6, -size * 0.4);
    ctx.moveTo(-size * 0.8, size * 0.4); ctx.lineTo(-size * 1.6, size * 0.4);
    ctx.stroke();
}

function drawSHORADIcon(size) {
    ctx.beginPath();
    ctx.moveTo(0, -size); ctx.lineTo(size, 0); ctx.lineTo(0, size); ctx.lineTo(-size, 0);
    ctx.closePath();
    ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, size * 0.3, 0, Math.PI * 2); ctx.fill();
}

function drawMSAMIcon(size) {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
        const angle = (i * Math.PI) / 3;
        const hx = Math.cos(angle) * size;
        const hy = Math.sin(angle) * size;
        if (i === 0) ctx.moveTo(hx, hy); else ctx.lineTo(hx, hy);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.fillRect(-size * 0.25, -size * 0.25, size * 0.5, size * 0.5);
}

function drawLSAMIcon(size) {
    ctx.beginPath();
    ctx.rect(-size, -size, size * 2, size * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-size, 0); ctx.lineTo(size, 0);
    ctx.moveTo(0, -size); ctx.lineTo(0, size);
    ctx.stroke();
}

function drawGroundTarget(size) {
    ctx.beginPath(); ctx.moveTo(-size * 0.8, -size * 0.8); ctx.lineTo(size * 0.8, size * 0.8);
    ctx.moveTo(size * 0.8, -size * 0.8); ctx.lineTo(-size * 0.8, size * 0.8); ctx.stroke();
}

function renderAirfields() {
    if (!chkAirfields?.checked || !airfieldsList.length) return;

    ctx.save();
    airfieldsList.forEach(af => {
        if (!isTeamVisible(af)) return;

        let cx = af.x ?? af.icenter?.[0] ?? af.enter?.[0] ?? af.pos?.[0];
        let cy = af.y ?? af.icenter?.[1] ?? af.enter?.[1] ?? af.pos?.[1];
        let angleRad = af.dir ? Number(af.dir) : 0;
        let lengthPx = 100 * Math.max(0.6, Math.min(2.0, zoom * 0.8));

        // Confirmed real schema: a flat sx/sy/ex/ey line segment (not
        // ep1/ep2 arrays) - keeping ep1/ep2 as a fallback in case a
        // different game version or map type uses that shape instead.
        let p1x, p1y, p2x, p2y;
        if (typeof af.sx === "number" && typeof af.ex === "number") {
            p1x = af.sx; p1y = af.sy; p2x = af.ex; p2y = af.ey;
        } else if (Array.isArray(af.ep1) && Array.isArray(af.ep2)) {
            p1x = af.ep1[0]; p1y = af.ep1[1]; p2x = af.ep2[0]; p2y = af.ep2[1];
        }

        if (p1x != null && p2x != null) {
            const [s1x, s1y] = worldToScreen(p1x, p1y);
            const [s2x, s2y] = worldToScreen(p2x, p2y);
            cx = (p1x + p2x) / 2;
            cy = (p1y + p2y) / 2;
            lengthPx = Math.hypot(s2x - s1x, s2y - s1y);
            angleRad = Math.atan2(s2y - s1y, s2x - s1x);
        }

        if (typeof cx !== "number" || typeof cy !== "number") return;

        const [screenX, screenY] = worldToScreen(cx, cy);

        ctx.save();
        ctx.translate(screenX, screenY);
        ctx.rotate(angleRad);

        const runwayWidth = Math.max(6, 10 * Math.min(zoom, 2.5));
        const runwayLength = Math.max(40, lengthPx);

        // Deliberately subdued - this used to be a solid, bright-outlined
        // block that competed visually with actual threats/targets on the
        // map. An airfield is just background context, not something that
        // needs to draw the eye.
        ctx.fillStyle = "rgba(40, 48, 64, 0.35)";
        ctx.strokeStyle = "rgba(0, 255, 204, 0.28)";
        ctx.lineWidth = 1;
        ctx.fillRect(-runwayLength / 2, -runwayWidth / 2, runwayLength, runwayWidth);
        ctx.strokeRect(-runwayLength / 2, -runwayWidth / 2, runwayLength, runwayWidth);

        ctx.beginPath();
        ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
        ctx.lineWidth = 1;
        ctx.setLineDash([6, 6]);
        ctx.moveTo(-runwayLength / 2 + 10, 0);
        ctx.lineTo(runwayLength / 2 - 10, 0);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.restore();

        // Label only at closer zoom - at zoomed-out views it was just
        // adding label clutter with little value.
        if (zoom > 1.5) {
            ctx.font = "8px monospace";
            ctx.fillStyle = "rgba(0, 255, 204, 0.55)";
            ctx.textAlign = "center";
            ctx.fillText(af.name || "airfield", screenX, screenY - (runwayWidth / 2) - 6);
        }
    });
    ctx.restore();
}

function renderMeasurementTool(pixelsPerMeter) {
    if (!activeMeasurement) return;
    const [sx, sy] = worldToScreen(activeMeasurement.start.x, activeMeasurement.start.y);
    const [cx, cy] = worldToScreen(activeMeasurement.current.x, activeMeasurement.current.y);
    const radiusPx = Math.hypot(cx - sx, cy - sy);
    if (radiusPx < 2) return;

    const radiusMeters = radiusPx / pixelsPerMeter;
    const radiusText = radiusMeters >= 1000 ? `${(radiusMeters / 1000).toFixed(2)} KM` : `${Math.round(radiusMeters)} M`;

    ctx.save();
    ctx.beginPath();
    ctx.arc(sx, sy, radiusPx, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255, 204, 0, 0.08)";
    ctx.fill();
    ctx.strokeStyle = "#ffcc00";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(cx, cy);
    ctx.setLineDash([]);
    ctx.strokeStyle = "rgba(255, 204, 0, 0.8)";
    ctx.stroke();

    ctx.fillStyle = "#ffcc00";
    ctx.beginPath(); ctx.arc(sx, sy, 3, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.fill();

    const midX = (sx + cx) / 2;
    const midY = (sy + cy) / 2;
    const textPadding = 5;
    // Base 16px (already bumped once for general readability) - scales up
    // further under Large Text Mode via largeTextCanvasFont.
    ctx.font = largeTextCanvasFont(16);
    const textWidth = ctx.measureText(radiusText).width;
    const boxHalfHeight = largeTextMode ? 18 : 13;
    const boxHeight = largeTextMode ? 30 : 22;

    ctx.fillStyle = "rgba(10, 16, 29, 0.9)";
    ctx.fillRect(midX - (textWidth / 2) - textPadding, midY - boxHalfHeight - textPadding, textWidth + (textPadding * 2), boxHeight + textPadding);
    ctx.strokeStyle = "#ffcc00";
    ctx.lineWidth = 1;
    ctx.strokeRect(midX - (textWidth / 2) - textPadding, midY - boxHalfHeight - textPadding, textWidth + (textPadding * 2), boxHeight + textPadding);

    ctx.fillStyle = "#ffcc00";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(radiusText, midX, midY - 2);
    ctx.restore();
}

function renderMapLegend() {
    const x = 16, y = 60, w = 155, h = 110;
    ctx.save();
    ctx.fillStyle = "rgba(10, 16, 29, 0.82)";
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = "rgba(0, 255, 204, 0.3)";
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, w, h);

    ctx.font = "bold 10px monospace";
    ctx.fillStyle = "#00ffcc";
    ctx.textAlign = "left";
    ctx.fillText("AA THREAT LEGEND", x + 10, y + 16);

    const items = [
        { label: "SPAAG (Cannon)", color: AA_RANGE_PROFILES.spaag.color, draw: drawSPAAGIcon },
        { label: "SHORAD (Short SAM)", color: AA_RANGE_PROFILES.shorad.color, draw: drawSHORADIcon },
        { label: "M-SAM (Medium SAM)", color: AA_RANGE_PROFILES.mrad.color, draw: drawMSAMIcon },
        { label: "L-SAM (Strategic SAM)", color: AA_RANGE_PROFILES.lrad.color, draw: drawLSAMIcon }
    ];

    items.forEach((item, idx) => {
        const rowY = y + 36 + (idx * 18);
        ctx.save();
        ctx.translate(x + 18, rowY);
        ctx.strokeStyle = item.color;
        ctx.fillStyle = item.color;
        ctx.lineWidth = 1.2;
        item.draw(5);
        ctx.restore();
        ctx.font = "9px monospace";
        ctx.fillStyle = "#fff";
        ctx.fillText(item.label, x + 34, rowY + 3);
    });
    ctx.restore();
}

function renderMapObjects() {
    if (!latestMapObj || !latestMapObj.length) return;

    const currentAlt = latestState?.["H, m"] ?? latestState?.["altitude_hour"] ?? 500;
    const altFactor = Math.max(0.3, 1.0 - (currentAlt / 8000));

    // Uses the live, per-map-calibrated correction factor (see the MAP
    // SCALE CALIBRATION panel / getMapSpanXMeters) rather than reading
    // grid_size directly - defaults to 1.0 (trust grid_size) until the
    // map has been calibrated against a real known distance.
    const mapSpanMeters = getMapSpanXMeters();
    const pixelsPerMeter = (canvas.width * zoom) / mapSpanMeters;
    const scaleFactor = Math.max(0.6, Math.min(2.5, Math.pow(zoom, 0.6)));

    currentMapSpanMeters = mapSpanMeters;
    currentPixelsPerMeter = pixelsPerMeter;

    const playerObj = findPlayerObject();
    updatePlayerLockUI();

    if (isJetCentered && playerObj && typeof playerObj.x === "number" && typeof playerObj.y === "number") {
        centerViewOn(playerObj.x, playerObj.y);
    }

    renderAirfields();
    renderMeasurementTool(pixelsPerMeter);

    if (chkAA?.checked) {
        ctx.save();
        const isDynamic = chkDynamicRange?.checked ?? true;
        const showFriendly = chkFriendlyAA?.checked ?? false;

        latestMapObj.forEach(obj => {
            if (typeof obj.x !== "number" || typeof obj.y !== "number") return;
            const profile = classifyStrictAA(obj);
            if (!profile) return;

            const team = classifyTeam(obj);
            if (team === "friendly" && !showFriendly) return;

            const targetRangeMeters = isDynamic ? (profile.maxRangeM * altFactor) : profile.minRangeM;
            const aaRadiusPx = Math.max(10, targetRangeMeters * pixelsPerMeter);
            const [sx, sy] = worldToScreen(obj.x, obj.y);

            ctx.beginPath();
            ctx.arc(sx, sy, aaRadiusPx, 0, Math.PI * 2);
            ctx.fillStyle = profile.fill;
            ctx.fill();

            ctx.strokeStyle = profile.color;
            ctx.lineWidth = largeTextLineWidth(1.5);
            ctx.setLineDash([6, 4]);
            ctx.stroke();

            ctx.setLineDash([]);
            ctx.font = "10px monospace";
            ctx.fillStyle = profile.color;
            ctx.textAlign = "center";
            ctx.fillText(`${profile.label} (${(targetRangeMeters / 1000).toFixed(1)}km)`, sx, sy - aaRadiusPx - 4);

            ctx.save();
            ctx.translate(sx, sy);
            ctx.strokeStyle = profile.color;
            ctx.fillStyle = profile.color;
            ctx.lineWidth = 1.5;
            if (profile === AA_RANGE_PROFILES.spaag) drawSPAAGIcon(6 * scaleFactor);
            else if (profile === AA_RANGE_PROFILES.shorad) drawSHORADIcon(6 * scaleFactor);
            else if (profile === AA_RANGE_PROFILES.mrad) drawMSAMIcon(6 * scaleFactor);
            else if (profile === AA_RANGE_PROFILES.lrad) drawLSAMIcon(6 * scaleFactor);
            ctx.restore();
        });
        ctx.restore();
    }

    latestMapObj.forEach((obj, idx) => {
        if (typeof obj.x !== "number" || typeof obj.y !== "number") return;
        if (classifyStrictAA(obj)) return;
        if (obj === playerObj) return;
        if (!isTeamVisible(obj)) return;

        const [sx, sy] = worldToScreen(obj.x, obj.y);
        ctx.save();
        ctx.translate(sx, sy);

        if (obj.type === "aircraft") {
            const entityId = obj.id || `npc_${idx}`;
            const history = npcHistory.get(entityId);
            ctx.rotate(history ? history.headingRad : 0);
            ctx.fillStyle = obj.color || "#ff3366";
            ctx.strokeStyle = obj.color || "#ff3366";
            if (obj.icon === "helo") { drawEnemyHelo(8 * scaleFactor); ctx.stroke(); }
            else { drawEnemyFighter(8 * scaleFactor); ctx.fill(); }
        } else {
            ctx.strokeStyle = obj.color || "#ff3366";
            ctx.fillStyle = obj.color || "#ff3366";
            const icon = String(obj.icon || "").toLowerCase();
            if (icon.includes("artillery") || obj.type === "ground_model") { drawGroundTarget(5 * scaleFactor); }
            else { ctx.fillRect(-3.5 * scaleFactor, -3.5 * scaleFactor, 7 * scaleFactor, 7 * scaleFactor); }
        }
        ctx.restore();
    });

    // Note: heading tracking itself now happens once per frame in
    // updateNpcHeadings(), called from render() regardless of view mode -
    // this loop only reads the result.

    if (playerObj && typeof playerObj.x === "number" && typeof playerObj.y === "number") {
        const [px, py] = worldToScreen(playerObj.x, playerObj.y);
        let headingDeg = Number(latestIndicators?.["compass"] ?? latestIndicators?.["compass1"] ?? latestIndicators?.["heading"]) || 0;
        const playerRad = (headingDeg * Math.PI / 180) - (Math.PI / 2);

        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(playerRad);

        const profile = getCurrentWeaponProfile();
        if (profile) {
            const rangeMeters = computeWeaponRangeMeters(profile);
            const rangePx = rangeMeters * pixelsPerMeter;

            if (profile.type === "missile" && chkRangeArc?.checked) {
                const halfFovRad = (profile.fovDeg / 2) * (Math.PI / 180);
                ctx.beginPath();
                ctx.moveTo(0, 0);
                ctx.arc(0, 0, rangePx, -halfFovRad, halfFovRad);
                ctx.closePath();
                ctx.fillStyle = "rgba(0, 255, 204, 0.08)";
                ctx.fill();
                ctx.strokeStyle = profile.color;
                ctx.lineWidth = largeTextLineWidth(1.5);
                ctx.stroke();
            }
            else if (profile.type === "glide_bomb" && chkRangeArc?.checked) {
                // Filled reachable wedge (0 to computed max range) instead of
                // a bare boundary arc - the shaded area is "you can hit
                // anywhere in here", sized to this weapon's actual
                // maneuvering basket rather than one hardcoded angle for
                // every glide weapon.
                const halfAngleRad = (profile.maneuverHalfAngleDeg ?? 30) * (Math.PI / 180);
                ctx.beginPath();
                ctx.moveTo(0, 0);
                ctx.arc(0, 0, rangePx, -halfAngleRad, halfAngleRad);
                ctx.closePath();
                ctx.fillStyle = "rgba(153, 51, 255, 0.08)";
                ctx.fill();
                ctx.strokeStyle = profile.color;
                ctx.lineWidth = largeTextLineWidth(1.5);
                ctx.stroke();
            }
            else if (profile.type === "bomb" && chkBombCCIP?.checked) {
                const dropPx = rangePx;
                ctx.beginPath();
                ctx.moveTo(8 * scaleFactor, 0);
                ctx.lineTo(dropPx, 0);
                ctx.strokeStyle = profile.color;
                ctx.lineWidth = largeTextLineWidth(2.0);
                ctx.setLineDash([5, 4]);
                ctx.stroke();
                ctx.setLineDash([]);

                ctx.beginPath();
                ctx.arc(dropPx, 0, 7 * scaleFactor, 0, Math.PI * 2);
                ctx.fillStyle = "rgba(255, 51, 51, 0.08)";
                ctx.fill();
                ctx.stroke();
            }
        }

        ctx.strokeStyle = "#00ffcc";
        ctx.lineWidth = 1.5;
        drawPlayerMarker();
        ctx.restore();
    }

    renderMapLegend();
}

function renderGrid() {
    if (!chkGridOverlay?.checked) return;
    ctx.save();
    ctx.strokeStyle = "#101d2e";
    ctx.lineWidth = 1;
    const gridSize = 50 * zoom;
    for (let x = panX % gridSize; x < canvas.width; x += gridSize) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
    }
    for (let y = panY % gridSize; y < canvas.height; y += gridSize) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
    }
    ctx.restore();
}

// ---------- Weapon MFD (alternate view) ----------
// A dedicated weapons-page display instead of the tactical map - a
// heading-up scope centered on the aircraft, scaled to the CURRENT
// weapon's computed range rather than the map's real-world size. Same
// underlying data (computeWeaponRangeMeters, findPlayerObject,
// classifyTeam, the calibrated span for real target distances) as the
// map view - this is a different way of looking at the same numbers, not
// a separate calculation path.
function renderWeaponMFD() {
    ctx.fillStyle = "#05070a";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const scopeRadius = Math.min(canvas.width, canvas.height) * 0.40;

    const profile = getCurrentWeaponProfile();
    const rangeMeters = computeWeaponRangeMeters(profile);
    const player = findPlayerObject();

    if (!rangeMeters || rangeMeters <= 0) {
        ctx.fillStyle = "#ffcc00";
        ctx.font = "bold 13px monospace";
        ctx.textAlign = "center";
        ctx.fillText("NO WEAPON RANGE AVAILABLE", cx, cy);
        return;
    }

    const pxPerMeter = scopeRadius / rangeMeters;
    let headingDeg = Number(latestIndicators?.["compass"] ?? latestIndicators?.["compass1"] ?? latestIndicators?.["heading"]) || 0;
    const headingRad = (headingDeg * Math.PI / 180) - (Math.PI / 2); // same convention as the map view's weapon-overlay rotation

    // Range rings at 25/50/75/100% of current weapon range, unrotated
    // (a circle looks the same either way).
    ctx.save();
    ctx.translate(cx, cy);
    ctx.strokeStyle = "rgba(0, 255, 204, 0.25)";
    ctx.font = "9px monospace";
    ctx.fillStyle = "rgba(0, 255, 204, 0.6)";
    ctx.textAlign = "left";
    [0.25, 0.5, 0.75, 1.0].forEach(frac => {
        ctx.beginPath();
        ctx.arc(0, 0, scopeRadius * frac, 0, Math.PI * 2);
        ctx.lineWidth = frac === 1.0 ? 1.5 : 1;
        ctx.stroke();
        ctx.fillText(`${((rangeMeters * frac) / 1000).toFixed(1)}km`, 4, -scopeRadius * frac - 3);
    });
    ctx.restore();

    // Weapon employment overlay and targets, in the heading-rotated frame -
    // "forward" (current heading) always points up on this scope.
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(headingRad);

    if (profile) {
        if (profile.type === "missile" && chkRangeArc?.checked) {
            const halfFovRad = (profile.fovDeg / 2) * (Math.PI / 180);
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.arc(0, 0, scopeRadius, -halfFovRad, halfFovRad);
            ctx.closePath();
            ctx.fillStyle = "rgba(0, 255, 204, 0.08)";
            ctx.fill();
            ctx.strokeStyle = profile.color;
            ctx.lineWidth = 1.5;
            ctx.stroke();
        } else if (profile.type === "glide_bomb" && chkRangeArc?.checked) {
            const halfAngleRad = (profile.maneuverHalfAngleDeg ?? 30) * (Math.PI / 180);
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.arc(0, 0, scopeRadius, -halfAngleRad, halfAngleRad);
            ctx.closePath();
            ctx.fillStyle = "rgba(153, 51, 255, 0.08)";
            ctx.fill();
            ctx.strokeStyle = profile.color;
            ctx.lineWidth = 1.5;
            ctx.stroke();
        } else if (profile.type === "bomb" && chkBombCCIP?.checked) {
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(0, -scopeRadius);
            ctx.strokeStyle = profile.color;
            ctx.lineWidth = 2;
            ctx.setLineDash([5, 4]);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.beginPath();
            ctx.arc(0, -scopeRadius, 6, 0, Math.PI * 2);
            ctx.fillStyle = "rgba(255, 51, 51, 0.2)";
            ctx.fill();
            ctx.stroke();
        }
    }

    // Plot nearby contacts at their real bearing/distance, scaled to this
    // weapon's range instead of the map's real-world size - respects the
    // same friendly/enemy visibility and weapon-appropriateness filters
    // used elsewhere.
    if (player) {
        const spanX = getMapSpanXMeters();
        const spanY = getMapSpanYMeters();
        for (const obj of latestMapObj) {
            if (typeof obj.x !== "number" || obj === player) continue;
            if (!isTeamVisible(obj)) continue;
            if (!isValidTargetForWeapon(obj, profile)) continue;

            const dxMeters = (obj.x - player.x) * spanX;
            const dyMeters = (obj.y - player.y) * spanY;
            const distMeters = Math.hypot(dxMeters, dyMeters);
            if (distMeters > rangeMeters * 1.15) continue; // off-scope

            const px = dxMeters * pxPerMeter;
            const py = dyMeters * pxPerMeter;
            const team = classifyTeam(obj);
            ctx.beginPath();
            ctx.arc(px, py, 4, 0, Math.PI * 2);
            ctx.fillStyle = team === "enemy" ? "#ff3366" : (team === "friendly" ? "#33ff57" : "#e0e0e0");
            ctx.fill();
        }
    }
    ctx.restore();

    // Player marker fixed at scope center - the scope itself is egocentric,
    // so the player never moves from the middle.
    ctx.save();
    ctx.translate(cx, cy);
    ctx.strokeStyle = "#00ffcc";
    ctx.lineWidth = 1.5;
    drawPlayerMarker();
    ctx.restore();

    // Header text - weapon name, computed range, live threat status,
    // pulled from the same safety-status computation the map view uses.
    ctx.fillStyle = "#00ffcc";
    ctx.font = "bold 13px monospace";
    ctx.textAlign = "center";
    const weaponLabel = usingVehicleWeapons ? formatDbWeaponLabel(selWeapon.value) : selWeapon.value;
    ctx.fillText(weaponLabel || "NO WEAPON SELECTED", cx, 24);
    ctx.font = "11px monospace";
    ctx.fillText(`RANGE: ${(rangeMeters / 1000).toFixed(2)} km`, cx, 42);
    if (elThreat) {
        ctx.fillStyle = elThreat.classList.contains("status-danger") ? "#ff3366"
            : elThreat.classList.contains("status-caution") ? "#ffcc00" : "#33ff57";
        ctx.fillText(elThreat.textContent, cx, 60);
    }
}

// ---------- Check-six / 360 air threat indicator ----------
// Fixed in the top-right corner, heading-up (your nose is always "up" on
// this ring, same convention as the Weapon MFD scope), drawn on top of
// whichever view is active. Deliberately small and stays out of the way
// when clear - it only gets loud when there's something to actually see.
function drawCheckSixIndicator() {
    const cx = canvas.width - 55;
    const cy = 65;
    const ringRadius = 32;

    let headingDeg = Number(latestIndicators?.["compass"] ?? latestIndicators?.["compass1"] ?? latestIndicators?.["heading"]) || 0;
    const playerHeadingRad = (headingDeg * Math.PI / 180) - (Math.PI / 2);

    const hasDanger = latestAirThreats.some(t => t.severity === "danger");
    const hasThreat = latestAirThreats.length > 0;

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0); // guarantee fixed-corner placement regardless of any transform left over upstream

    ctx.beginPath();
    ctx.arc(cx, cy, ringRadius, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(8, 12, 20, 0.75)";
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = hasDanger ? "#ff3366" : hasThreat ? "#ffcc00" : "rgba(139, 155, 180, 0.5)";
    ctx.stroke();

    // Pulsing outer ring when something's actively aimed at you - the
    // "noticeable" part of the ask, without needing audio.
    if (hasDanger) {
        const pulse = 0.35 + 0.35 * Math.sin(performance.now() / 180);
        ctx.beginPath();
        ctx.arc(cx, cy, ringRadius + 4, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255, 51, 102, ${pulse})`;
        ctx.lineWidth = 2;
        ctx.stroke();
    }

    // Own-ship nose marker - dead ahead is always the top of this ring.
    ctx.fillStyle = "#00ffcc";
    ctx.beginPath();
    ctx.moveTo(cx, cy - 6);
    ctx.lineTo(cx - 4, cy + 4);
    ctx.lineTo(cx + 4, cy + 4);
    ctx.closePath();
    ctx.fill();

    // Threat blips at real relative bearing.
    latestAirThreats.forEach(threat => {
        const relativeAngle = threat.bearingRad - playerHeadingRad;
        const screenAngle = relativeAngle - Math.PI / 2;
        const bx = cx + ringRadius * Math.cos(screenAngle);
        const by = cy + ringRadius * Math.sin(screenAngle);
        ctx.beginPath();
        ctx.arc(bx, by, threat.severity === "danger" ? 4.5 : 3.5, 0, Math.PI * 2);
        ctx.fillStyle = threat.severity === "danger" ? "#ff3366" : "#ffcc00";
        ctx.fill();
    });

    if (hasThreat) {
        ctx.font = "bold 9px monospace";
        ctx.textAlign = "center";
        ctx.fillStyle = hasDanger ? "#ff3366" : "#ffcc00";
        ctx.fillText(hasDanger ? "CHECK SIX" : "BANDIT", cx, cy + ringRadius + 14);
    }

    ctx.restore();
}

function render() {
    resizeCanvas();
    updateMapScaleDebug();
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // These run every frame regardless of which view is showing, so safety
    // status and the check-six widget stay live even on the Weapon MFD
    // screen instead of freezing at whatever they last showed in map view.
    updateNpcHeadings();
    updateSafetyStatus(findPlayerObject());

    try {
        if (viewMode === "controls") {
            // The controls page is a plain HTML overlay (see
            // controls-page-overlay), not canvas-drawn - real DOM buttons
            // give proper native touch feedback and hit-testing for free.
            // Its own live telemetry/radar updates happen here each frame.
            ctx.fillStyle = "#080c14";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            updateControlsScreenLive();
        } else if (viewMode === "weapon") {
            renderWeaponMFD();
        } else if (mapImage && isConnected) {
            ctx.drawImage(mapImage, panX, panY, canvas.width * zoom, canvas.width * getMapYScaleFactor() * zoom);
            renderGrid();
            renderAirfields();
            renderMapObjects();
        } else {
            ctx.fillStyle = "#080c14"; ctx.fillRect(0, 0, canvas.width, canvas.height);
            renderGrid();
            ctx.fillStyle = "#ffcc00"; ctx.font = "bold 13px monospace"; ctx.textAlign = "center";
            ctx.fillText("WAITING FOR WAR THUNDER (LOCALHOST:8111)...", canvas.width / 2, canvas.height / 2);
        }
    } catch (err) {
        // A single bad frame (e.g. malformed data from a transient API
        // hiccup) used to permanently freeze the ENTIRE canvas forever,
        // since the requestAnimationFrame(render) call below never ran if
        // anything upstream threw. Log it and keep the loop alive instead.
        console.error("[WT MFD] render() error (frame skipped, loop continues):", err);
        ctx.fillStyle = "#ff3366";
        ctx.font = "bold 11px monospace";
        ctx.textAlign = "center";
        ctx.fillText("RENDER ERROR - see console - frame skipped", canvas.width / 2, 20);
    }

    // Drawn last, on top of whichever view rendered above, in its own
    // try/catch so a bug here can't freeze the map/weapon view and a bug
    // in either of those can't take the threat indicator down with it.
    try {
        drawCheckSixIndicator();
    } catch (err) {
        console.error("[WT MFD] check-six indicator error (skipped this frame):", err);
    }

    requestAnimationFrame(render);
}

pollFast();
pollSlow();
pollMapMeta();
requestAnimationFrame(render);
