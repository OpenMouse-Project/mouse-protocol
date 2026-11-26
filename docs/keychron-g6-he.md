# Keychron G6 HE Launcher controls

Inspected on 2026-11-17 with REA against https://launcher.keychron.com/#/mouse/he.
The live page redirected to `#/not-connect` without a paired device. Commands
below come from the shipped JavaScript, not a capture from a physical G6 HE.

## Source identity

| Launcher artifact | SHA-256 |
| --- | --- |
| `main.9597847ee340b1c7.js` | `c0d660c60eb74c4f50c2db1440d9a602f2b2c74d09198bbca64fa051de75089b` |
| `common.f59398e631a24e1c.js` | `fb507c912c5e40abfc1f4c8fe1f4777326ed22ef468c74629629575354a0485b` |
| `810.819eff90b9bbaedb.js` | `e8a66cc2d614705dd77362709e7be3045103991fdc6eefaa6a8631c50be3fddd` |
| `690.e82e62fccdf1e18c.js` | `50bbd52d229ce998c9fd9b1bc54e9dd6c785b5d833cf9f973b73f566af027979` |
| `static/device/875876486/json/v3.json` | `05504e9ba070c2b19242f9ce830125dd91dbe2f5c23b939b6e942b6a09ed5883` |

REA main-bundle graph: `ev_52f2b265461d9dcbd5afc642668e9543717fc2825c9da7b7d3d71b72b6f6feed`.
Focused HE UI/scale graph: `ev_ff8f74baea0a43cc1484b349ea78c635d320d1de32f4947f1198a364f2050333`.
Both have bounded, incomplete static semantic coverage; unresolved relationships
are not evidence of absent features. No vendor bootstrap code was evaluated by
the static analysis.

The session's REA evidence was exported to
`C:/Users/snekxs/AppData/Local/Temp/openmouse-keychron-rea-evidence.json`.
Vendor bundles and screenshots remain outside the source repository.

## HE records

Command report `0xb3`, response `0xb4`, 63-byte payload. `0x65` reads;
`0x55` writes and returns `[0xe4, status, 0x55]`. Payload byte 1 is the record
count. Records start at byte 2 and have a stride of 22. Physical index 0 is
left, 2 is right. Do not use UI button index 1 as the wire index for right.

| Record offset | Meaning |
| --- | --- |
| 0 | Physical button index |
| 1–2 | Dead bands |
| 3–4 | Percent points |
| 5–8 | Press/release scale points, two little-endian uint16s |
| 9 | Percent value |
| 10–11 | Current travel scale, little-endian uint16 |
| 12 | Low nibble: 1 optical, 2 magnetic. High nibble: rapid trigger enable |
| 13–16 | Rapid press/release distances, two little-endian uint16s |
| 17–21 | Read-only ADC/optical state |

The G6 JSON has no scale override. Launcher's common module defaults to
12 actuation levels with raw values `[10,15,...,65]`. Rapid trigger has an
off level at 0, then raw values `[5,10,...,55]`; both rapid distances are set
together. Rapid distance cannot exceed `65 - actuation`. Changing actuation
sets the ordinary release point to `max(5, actuation - 10)` and clamps rapid
trigger to the remaining travel. Values are scale levels, not millimetres.

Feature byte 2 bits 3/5/6 advertise ALL/optical/magnetic respectively. Only
ALL exposes the optical/magnetic selector. These are status byte 53 before
protocol version 6, version-response byte 12 from version 6 onward.

Launcher polls HE every 50 ms while its view is visible. OpenMouse likewise
polls only while subscribed, skips hidden documents and busy requests, and
serializes requests with writes. Travel is normalized to percent of 65 for
the shared interface. The G6 chart converts that back to actuation levels 0–12,
so the threshold and trace share the same scale. The time axis redraws on browser
animation frames, independently of the 50 ms device query interval. Travel beyond
the configured threshold is shaded in the current theme accent. Charts show received samples over three seconds;
stale/failed data clears rather than inventing zero travel. The chart does
not claim to count firmware click events or reproduce Launcher's derived
rapid-trigger click/hold simulation.

Independent/shared editing is a UI choice. The firmware stores separate left
and right records. Writes preserve both records' other configuration fields
and verify configuration readback, excluding live input fields.

## Other controls

| Control | Protocol / implementation |
| --- | --- |
| Lift-off 0.7–1.7 mm | Existing model table and level-byte sensor writer |
| Ripple, angle snap, motion sync | Existing `0x42` sensor writer |
| Scroll direction | Status byte 15 bit 6, `0x42` byte 6: 1 forward, 2 reverse; preserves other sensor options |
| Debounce / sleep | Existing driver; sleep is stored in minutes |
| Left click lock | Local remapping guard, as in Launcher; no firmware command |
| System mouse settings | OS settings URI, Windows/macOS only |
| Pairing shortcut | Feature byte 2 bit 1. `0x0b,2` reads mask/time; `0x0b,1,mask,time` writes. One to three buttons; preserve hold time |
| Dynamic DPI | Feature byte 4 bit 5. `0x4f,profile` reads; `0x4e` writes without waiting for an ACK, followed by readback |
| Factory reset | Restore debounce to 8 ms, then `0x0f,0xff` on settings report `0xb5`; wait three seconds as Launcher does |

Dynamic DPI payload: profile at 1, enabled bit at 2, mode at 3, count at 5;
points at 6 with stride 4: uint16 speed (IPS), gain byte, reserved byte.
UI gain is gain/16, max 3.5; speed max 200 IPS. Modes are custom, classic,
natural and jump, with the three preset point tables recovered from chunk 690.
Pairing and dynamic controls are exposed only after a successful feature-gated
device read. The current G6 descriptor alone does not prove firmware advertises
Dynamic DPI.

## Validation

Protocol tests exercise feature gating, left/right record preservation,
readback failure, travel limits, real sample decoding, polling cleanup and
request serialization, scroll preservation, pairing constraints and dynamic
DPI read/write validation. Browser preview exercises the shared/independent
controls and optical disabling in Emerald and Arabic RTL/NieR, plus the dynamic
editor in Light. Preview data is simulated and is explicitly labelled as such.

Physical wired and receiver operation, persistence across power cycles, OS URI
handling and factory reset still require hardware validation. Do not interpret
mock protocol or browser-preview success as physical-device confirmation.

## TurboLink controls on the mouse page

The connected Windows device was enumerated read-only as `3434:d05a`.
Its descriptor declares four receiver buttons, independently of the mouse:
polling cycle (0), lighting cycle (1), optical/magnetic toggle (2), DPI cycle (3).
REA's receiver UI graph is
`ev_700de899e9a81e76d3102f1e71fe29a733b6e330d527b19963ab17b82d708df8`.

Launcher module 98004 uses 63-byte command reports `0xb3`: `0x31,index` reads
one receiver assignment; `0x30,index,0,type,data...` writes it. Success is
`e4,0,30`. This is separate from the mouse's `0x62`/`0x52` commands. Receiver
lighting uses settings report `0xb5`: `0x20,0` reads, with mode/brightness/speed
at reply offsets 4/5/6 and RGB at 7–9. `0x24,0,mode,brightness,speed,r,g,b`
writes, followed by readback. The second byte is the receiver lighting target,
not the mouse's lighting mode. Extra receiver actions include lighting cycling
and custom function `15,3,target,action` for optical/magnetic control, where
target is 204 (both), 0 (left), or 2 (right), and action is 0/1/2 (toggle/optical/magnetic).

OpenMouse exposes this as `MouseStatus.keychronReceiver` inside the paired
mouse's page. It does not create a second device entry. Receiver reads and writes
share the mouse client's request queue to prevent live travel queries colliding
with configuration. Receiver button writes verify only the receiver's records.
Receiver lighting does not change the mouse's lighting state. Tests cover those
separate commands and nesting; physical settings writes have not been performed.

Receiver keyboard actions use function type 2, followed by the modifier mask
and USB keyboard usages. These are distinct from function type 8 shortcut
presets. Module 98004's `keyboard` method constructs this record; chunk 808's
editor was retained in REA evidence
`ev_e044b4061bbfe04da69c3b167051dd50910b8ced13528e8017e7124753fe2a54`.
Readback preserves keyboard combinations rather than treating them as unknown.

The examined TurboLink receiver class (`Oe` in module 98022) reads firmware,
button assignments and lighting. Its monitor handles lighting event 0xe1.
Module 98004 contains no dock-battery query or percentage decoder, and the
receiver class does not expose a spare-battery field. This establishes no
Launcher readout in this examined code path; it does not rule out an
undocumented firmware command. OpenMouse therefore does not substitute the
mouse's battery percentage for the battery charging in the dock.
