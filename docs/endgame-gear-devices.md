# Endgame Gear devices × exposed features

Every mouse OpenMouse recognizes, with the settings each driver exposes.
"R/W" = readable and writable; "R" = decoded into status, no writer yet.
"Vendor-only" lists what the official tool has and OpenMouse does not (yet).
VID is 0x3367 throughout. No OT entry is hardware-verified.

## OT platform — EggOtHidClient (`endgame-gear-ot`)

| Mouse | PID | Max CPI | R/W | R only | Vendor-only |
|---|---|---|---|---|---|
| XM1r | 0x1903 | 19,000 | profiles, CPI stages (X/Y), polling 125–1000, LOD 1/2 mm, angle snap, ripple, slamclick, motion sync ×2, firmware query/flash/reset | sensitivity, acceleration, jitter, LED stages, button mapping, battery telemetry (null on wired) | button-remap write, macros, profile activation, keyboard bindings, LED-effect write |
| OP1 | 0x1906 | 26,000 | same as XM1r | same as XM1r | same as XM1r |
| OP1 RGB | 0x1905 | 26,000 | same as XM1r + RGB effect | same as XM1r | same as XM1r |

Flash/reset implement the vendor flow byte-for-byte but never ran on hardware;
reset is a separate call so it cannot ride along silently.

## K26/W26 platform — EggOp1HidClient (`endgame-gear-op1`)

Base for all ten PIDs: CPI stages (X/Y), polling, LOD, motion sync, angle
snap, ripple, slamclick, SPDT modes, CPI levels, multiclick filters, button
mapping, left-handed mode, factory reset, firmware version.

| Mouse | PID | Adds | Vendor-only |
|---|---|---|---|
| OP1 8K | 0x1964 | motion-jitter filter | LED zone control, on-board profiles |
| OP1 8K Purple Frost | 0x1976 | + glass mode | same |
| OP1 8K v2 (+ RIN, same PID) | 0x1978 | + glass mode, angle tuning, force max FPS, LED lift-off disable | same + CPI-downshift/smoothing presets (primitives exposed) |
| XM2 8K | 0x1966 | motion-jitter filter | same as OP1 8K |
| XM2 8K v2 | 0x1980 | same v2 set as OP1 8K v2 | same as OP1 8K v2 |
| OP1w 4K | 0x1972 + dongle 0x1970 | motion-jitter filter (no glass, no v2 controls) | pairing UI, battery display, on-board profiles, LED |
| XM2w 4K | 0x1968 + dongle 0x1970 | same as OP1w 4K | same |
| OP1w 4K v2 | 0x1984 + dongle 0x1970 | v2 set + glass mode, no jitter filter | same |
| XM2w 4K v2 | 0x1982 + dongle 0x1970 | same as OP1w 4K v2 | same |
| 4K dongle (neutral) | 0x1970 | resolves to the paired mouse's profile via mouse-info | — |

Polling caps: 8000 Hz wired, 4000 Hz wireless. CPI: 50–26,000 (v1, 50-step),
10–30,000 (v2, 10-step ≤10K, 50 above).

## WE platform — EggWeHidClient (`endgame-gear-we`)

| Mouse | PID | Exposed (R/W) | Vendor-only |
|---|---|---|---|
| OP1we | 0x1961 + 0x1962 | battery, DPI stages, polling 125–1000, LOD Medium/High | macros, profile management, LED control, debounce/sleep tuning |
| XM2we | 0x1960 | same | same |

## Not mappable

- **XM1 / XM1 RGB**: InstallShield-locked installers; PIDs unknown.
- **0x1910**: accepted by the 2021 vendor app's wireless page, no device name
  in the binaries; deliberately unmapped.
