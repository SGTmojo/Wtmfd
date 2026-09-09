// ============================================================================
// WT Tactical MFD - Weapon Ballistics Config
// ============================================================================
// Edit this file to add weapons, fix stats, or recalibrate drag/glide values
// - no need to touch mfd.js. Reload the extension after saving.
//
// FIELD REFERENCE
// ----------------
// All weapons:
//   type   - "missile" | "bomb" | "glide_bomb"
//   color  - hex string used for its overlay on the map
//
// Missiles (type: "missile"):
//   rangeKm     - max engagement range, km
//   fovDeg      - seeker/employment cone half-width... actually full FOV, deg
//   burnoutSec  - motor burn time, sec (affects range-ring shading)
//   maxG        - max sustained turn, G (affects maneuver envelope)
//
// Bombs (type: "bomb") and glide bombs (type: "glide_bomb"):
//   mass        - kg
//   refArea     - frontal cross-section, m^2
//   dragCoeff   - drag coefficient. THIS IS THE MAIN CALIBRATION KNOB.
//                 Real bombs are physically ~0.15-0.4, but War Thunder's
//                 simplified flight model doesn't match real aerodynamics,
//                 so use the in-app calibrateDragCoeff() console helper
//                 against an actual in-game test drop rather than guessing.
//   glideRatio  - glide_bomb only. 0 (or omit) for unguided bombs. Higher
//                 = flies further per meter of altitude. Use
//                 calibrateGlideRatio() the same way as dragCoeff.
//   maneuverHalfAngleDeg - glide_bomb only. Off-axis steering basket the
//                 bomb can reach after release (0 = flies straight, no
//                 turning). Drawn as a wedge on the map instead of a circle.
//
// These starting values are real-world reference estimates, NOT calibrated
// to War Thunder's actual in-game ballistics - see README.md for the
// calibration workflow. Only the MK 84 has been properly calibrated so far
// (dragCoeff: 0.117, see the note next to it below) - treat every other
// bomb's dragCoeff/glideRatio as a rough placeholder until you calibrate it.
// ============================================================================

// ============================================================================
// Air-to-Air Threat Detection (check-six indicator)
// ============================================================================
// The API never tells us an enemy aircraft's actual loadout, so "in his
// missile range" can't be computed exactly like it is for ground AA.
// Instead this approximates it from proximity + whether he's roughly
// pointed at you (a real RWR does something similar in the absence of a
// full missile-launch signal). Tune these to taste:
//
//   dangerRangeKm  - close enough that it doesn't matter which way he's
//                    facing; almost anything can reach you from here.
//   cautionRangeKm - beyond dangerRangeKm but still worth tracking; shown
//                    as a lower-severity blip on the check-six ring.
//   aspectConeDeg  - if an enemy within cautionRangeKm has his nose within
//                    this many degrees of pointing back at you, that's
//                    upgraded to DANGER even outside dangerRangeKm.
const AIR_THREAT_CONFIG = {
    dangerRangeKm: 6,
    cautionRangeKm: 20,
    aspectConeDeg: 45
};

const COUNTRY_WEAPONS = {
    USA: {
        "AIM-9M Sidewinder": { type: "missile", rangeKm: 9.5, fovDeg: 45, color: "#ffcc00", burnoutSec: 3.2, maxG: 20 },
        "AIM-120C-5 AMRAAM": { type: "missile", rangeKm: 75.0, fovDeg: 15, color: "#00ffcc", burnoutSec: 8.0, maxG: 35 },
        "AGM-65D Maverick": { type: "missile", rangeKm: 14.0, fovDeg: 35, color: "#ff6600", burnoutSec: 6.0, maxG: 10 },
        "GBU-39 SDB (Glide)": { type: "glide_bomb", mass: 93, refArea: 0.09, dragCoeff: 0.22, glideRatio: 8, maneuverHalfAngleDeg: 55, color: "#9933ff" },
        "GBU-8 HOBOS (Glide)": { type: "glide_bomb", mass: 907, refArea: 0.40, dragCoeff: 0.30, glideRatio: 3, maneuverHalfAngleDeg: 25, color: "#9933ff" },
        "MK 82 (500lb) Bomb": { type: "bomb", mass: 227, refArea: 0.28, dragCoeff: 0.30, color: "#ff3333" },
        // High-drag "Snakeye" - Mk14 retarding fins deploy after release to
        // dramatically increase drag for safe low-altitude delivery. No
        // public calibrated Cd exists (this is the kind of number that
        // isn't published), but real-world sources consistently describe
        // retarded bombs as several times draggier than the slick/low-drag
        // config - roughly 3x the low-drag MK 82 above is a reasonable
        // real-world-reference placeholder, same uncalibrated-until-tested
        // status as every bomb here except the one MK 84 data point.
        "MK 82 Snakeye (High-Drag)": { type: "bomb", mass: 231, refArea: 0.28, dragCoeff: 0.90, color: "#ff3333" },
        "MK 83 (1000lb) Bomb": { type: "bomb", mass: 454, refArea: 0.33, dragCoeff: 0.30, color: "#ff3333" },
        // dragCoeff calibrated from a properly map-scale-calibrated
        // reading: 1277m, vx0=237 vy0=1 m/s (near-level), 3.71km in-game
        // CCIP. Result (0.117) is physically plausible for a real bomb
        // shape, unlike the old 4.75 - strong evidence the old ruler
        // really was under-measuring distances before per-map calibration
        // existed (cross-checked: this coefficient predicts ~4.27km for
        // the old test's conditions, nowhere near its claimed 1.66km,
        // confirming that old reading was corrupted). Still only one
        // trustworthy data point though, and this map's own scale
        // calibration had a wide spread (2.4x-4.0x) as of this test - a
        // second reading (ideally after tightening that spread further)
        // would confirm this holds before fully trusting it.
        "MK 84 (2000lb) Bomb": { type: "bomb", mass: 907, refArea: 0.40, dragCoeff: 0.117, color: "#ff3333" },
        "GBU-12 Paveway II": { type: "glide_bomb", mass: 230, refArea: 0.28, dragCoeff: 0.28, glideRatio: 2, maneuverHalfAngleDeg: 15, color: "#33ff57" }
    },
    USSR: {
        "R-73": { type: "missile", rangeKm: 10.5, fovDeg: 60, color: "#ffaa00", burnoutSec: 3.0, maxG: 40 },
        "R-27ER": { type: "missile", rangeKm: 60.0, fovDeg: 25, color: "#00bfff", burnoutSec: 7.0, maxG: 25 },
        "R-77": { type: "missile", rangeKm: 65.0, fovDeg: 15, color: "#00ffcc", burnoutSec: 7.5, maxG: 35 },
        "Grom-2 (Glide)": { type: "glide_bomb", mass: 280, refArea: 0.20, dragCoeff: 0.22, glideRatio: 7, maneuverHalfAngleDeg: 50, color: "#9933ff" },
        "KAB-500Kr (Glide)": { type: "glide_bomb", mass: 500, refArea: 0.34, dragCoeff: 0.28, glideRatio: 3, maneuverHalfAngleDeg: 20, color: "#9933ff" },
        "FAB-250 Bomb": { type: "bomb", mass: 250, refArea: 0.28, dragCoeff: 0.32, color: "#ff3333" },
        // High-drag Soviet equivalent to the Snakeye - same real-world-
        // reference placeholder approach (see MK 82 Snakeye note above).
        "FAB-250M-62 (High-Drag)": { type: "bomb", mass: 260, refArea: 0.28, dragCoeff: 0.95, color: "#ff3333" },
        "FAB-500 Bomb": { type: "bomb", mass: 500, refArea: 0.34, dragCoeff: 0.32, color: "#ff3333" },
        "FAB-1500 Bomb": { type: "bomb", mass: 1500, refArea: 0.45, dragCoeff: 0.32, color: "#ff3333" },
        "KAB-500L": { type: "glide_bomb", mass: 500, refArea: 0.34, dragCoeff: 0.30, glideRatio: 2, maneuverHalfAngleDeg: 15, color: "#33ff57" }
    },
    GERMANY: {
        "IRIS-T": { type: "missile", rangeKm: 14.0, fovDeg: 90, color: "#ffaa00", burnoutSec: 3.5, maxG: 50 },
        "SC250 Bomb": { type: "bomb", mass: 250, refArea: 0.28, dragCoeff: 0.32, color: "#ff3333" },
        "SC500 Bomb": { type: "bomb", mass: 500, refArea: 0.34, dragCoeff: 0.32, color: "#ff3333" }
    },
    BRITAIN: {
        "ASRAAM": { type: "missile", rangeKm: 18.0, fovDeg: 80, color: "#ffaa00", burnoutSec: 4.0, maxG: 50 },
        "Paveway IV (Glide)": { type: "glide_bomb", mass: 227, refArea: 0.28, dragCoeff: 0.26, glideRatio: 4, maneuverHalfAngleDeg: 35, color: "#9933ff" },
        "1000lb GP Bomb": { type: "bomb", mass: 454, refArea: 0.33, dragCoeff: 0.30, color: "#ff3333" }
    },
    SWEDEN: {
        "RB99 (AMRAAM)": { type: "missile", rangeKm: 55.0, fovDeg: 15, color: "#00ffcc", burnoutSec: 7.0, maxG: 30 },
        "m/70 120kg Bomb": { type: "bomb", mass: 120, refArea: 0.18, dragCoeff: 0.30, color: "#ff3333" }
    },
    FRANCE: {
        "MICA EM": { type: "missile", rangeKm: 58.0, fovDeg: 20, color: "#00ffcc", burnoutSec: 7.2, maxG: 35 },
        "AASM Hammer (Glide)": { type: "glide_bomb", mass: 250, refArea: 0.20, dragCoeff: 0.22, glideRatio: 9, maneuverHalfAngleDeg: 60, color: "#9933ff" },
        "Samp 250kg Bomb": { type: "bomb", mass: 250, refArea: 0.28, dragCoeff: 0.32, color: "#ff3333" }
    }
};
