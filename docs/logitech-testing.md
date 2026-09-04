# Logitech hardware test checklist

Test in Chrome or Edge over HTTPS. Close Logitech G HUB and Logitech Gaming
Software first — they hold the same vendor interface open and the mouse will
stop answering. Select the vendor collection (`usagePage 0xff00`, `usage
0x0001`), not the plain pointer collection.

Supported identifiers:

- `046d:c54d`, `046d:c547` — Lightspeed receivers
- `046d:c539` — HERO-era Lightspeed receiver
- `046d:c53f`, `046d:c543` — Nano Lightspeed 1.1 / 1.2 receivers (G305)
- `046d:c548` — Logi Bolt receiver (MX Master 3S, MX Master 4, and other Bolt mice)
- `046d:c0a8` — PRO X 2 Superstrike (USB)
- `046d:c07e` — G402 / G402 Hyperion Fury (wired)
- `046d:c08f` — G403 HERO (wired)
- `046d:c087` — G703 (wired)
- `046d:c08b` — G502 HERO (wired)
- `046d:c07d` — G502 / G502 Proteus Core (wired)
- `046d:c095` — G502 X PLUS (USB cable; wireless identity `4099` uses its Lightspeed receiver)
- `046d:c099` — G502 X (wired)

G502 X-family firmware advertises lift-off support through extended DPI
feature `0x2202`; gaming-surface and Lightforce modes use `0x8090`. The G502 X
PLUS additionally advertises RGB zones and effects through `0x8071`. OpenMouse
enumerates those capabilities at runtime rather than enabling them by product
name, and releases software RGB control when the device is closed.

For Logi Bolt, authorize **both** HID++ collections when the picker offers them
(`usagePage 0xff00`, `usage 0x0001` and `usage 0x0002`). Device feature traffic
uses the long-report collection (`usage 0x0002`). Close Logi Options+ first —
it holds the same vendor interface.

## Receiver-attached and Superstrike devices

1. Confirm the model, battery, connection type, DPI, polling rate, and
   lift-off distance are read correctly.
2. Change one setting at a time and confirm each write, then reload and confirm
   it persisted.

**Superstrike polling rate (format 8, direct-connect over USB, PID `0xc0a8`).**
Format 8's profile layout has never been confirmed on real hardware, so it is
not in `WRITABLE_FORMATS` and profile-content writes still throw for it.
`setPollingRate` now tries the live `0x8060`/`0x8061` report-rate feature
first on every direct-connect mouse — the same thing Solaar and libratbag do
unconditionally — and only falls back to the profile write if that live write
is explicitly rejected on-device. If the Superstrike's live write succeeds,
its polling rate is settable with no profile write involved at all; confirm
this on real hardware and report back either way, since previously it always
failed outright (format 8 blocked the fallback profile write it always used
to fall to).

## G402 (direct-connect, HID++ device index `0xFF`)

The G402 is addressed as the mouse itself rather than a receiver slot, and it
exposes only the legacy feature set: Adjustable DPI `0x2201` and Report Rate
`0x8060`. It has no lift-off, gaming-surface, battery, or hall-effect controls,
so those cards stay hidden.

1. Confirm the sidebar and title show the mouse, and that the connection reads
   **Wired**.
2. Confirm the firmware list and the HID++ device details section populate.
3. Confirm the DPI presets offer 420 / 840 / 1596 / 3192 — the nearest steps on
   the G402's 84-DPI grid — and that the reported DPI matches what Logitech
   Gaming Software shows, allowing for its rounding (2436 is shown as "2400").
4. Stage a DPI change and flash it. The driver writes `0x2201` function 3 as a
   short request and re-reads the value; a mismatch is reported as an error
   rather than being assumed to have worked.
5. Confirm the sensor card (lift-off distance) is hidden — the G402 has no
   `0x2202` feature to drive it.
6. Confirm the polling-rate buttons show the active rate but are **disabled**,
   with the note explaining the rate lives in the onboard profile.
7. Confirm the mouse stays in onboard mode: its own DPI-stage buttons must keep
   working after OpenMouse writes a DPI value. The driver deliberately does not
   switch the G402 into host-control mode.
8. Reload the page and confirm the DPI written in step 4 is still reported.

## G403 HERO (direct-connect, HID++ device index `0xFF`)

The G403 HERO reports HID++ 4.2 and takes the same direct-connect path as the
G402: legacy Adjustable DPI `0x2201` and legacy Report Rate `0x8060`, no
`0x2202`, so the lift-off/sensor card stays hidden. Its sensor range is much
wider (100–25,600 DPI in steps of 50) and its onboard profile uses format `2`
with seven 256-byte sectors, so none of the G402's profile offsets apply to it.

1. Confirm the sidebar and title show the mouse and the connection reads
   **Wired**.
2. Confirm the firmware list and the HID++ device details section populate.
3. Confirm the DPI presets offer 400 / 800 / 1600 / 3200 / 6400 / 8000 — all
   exact multiples on the 50-DPI grid — and that the reported DPI matches G HUB.
4. Stage a DPI change and flash it. The driver writes `0x2201` function 3 as a
   short request and re-reads the value; a mismatch is reported as an error.
5. Confirm the polling-rate controls are **enabled** and that changing the rate
   writes the active onboard profile's report-rate byte (format 2/LOGAN), then
   reloads as the new rate. The write is the CRC-checked sector rewrite; run the
   write-probe once on this hardware before release.
6. Confirm the mouse stays in onboard mode: its own DPI-stage button must keep
   working after OpenMouse writes a DPI value.
7. Reload the page and confirm the DPI written in step 4 is still reported.

RGB lighting (`0x8070`) is enumerated at runtime. Each advertised zone gets its
own control (the G502 family commonly reports logo and side/DPI zones), its
current effect is read when supported, and writes use the zone's advertised
effect index. Confirm each zone changes independently and reloads correctly.

Persistent polling-rate changes write the profile sector and are implemented for
format 2 (LOGAN); DPI-stage changes still are not (the v1 format has no stage
table). Record the device identifier, protocol version, and any failing setting
in the issue or pull request. Do not use factory reset during initial testing.

## G703 (direct-connect, HID++ device index `0xFF`)

The original G703 on its USB cable (`046d:c087`) takes the same direct-connect
path as the G403 HERO: legacy Adjustable DPI `0x2201` and legacy Report Rate
`0x8060`. Extended DPI `0x2202` is absent, so the lift-off/sensor card stays
hidden. Identity reports USB transport `C087` and firmware `MPM 14.02` /
`BOT 64.00` / `RQI 04.00`.

Its onboard profile is format `3` (HEAT). A 2026-08-16 guided write probe on
this cable unit passed: name `OM_VERIFY`, default-slot DPI 1000, and 500 Hz
were stored exactly, confirmed live, and restored. Polling-rate and DPI-slot
edits therefore write the active onboard profile. The sensor advertises
50–12,000 DPI in steps of 50 and 125 / 250 / 500 / 1000 Hz. Battery is
reported from the voltage feature (`0x1001`). RGB lighting (`0x8070`)
enumerates Primary and Logo zones as write-only.

A cable capture confirmed Wired USB, 450 DPI, 1000 Hz, charging, active
onboard profile 3, four of five DPI slots in use (450 / 800 / 1600 / 12000).
The Lightspeed dongle was not present; wireless remains untested on this unit.

1. Confirm the sidebar and title show the mouse and the connection reads
   **Wired**.
2. Confirm the firmware list and the HID++ device details section populate.
3. Confirm DPI reads back and that a staged DPI write re-reads as the value
   sent (`0x2201` function 3, short request).
4. Confirm the polling-rate controls are **enabled** and that changing the rate
   writes the active onboard profile's report-rate byte, then reloads as the
   new rate.
5. Open a stored profile and change the DPI slot table. Confirm the physical
   DPI button cycles the new values and that unused slots stay unused.
6. Confirm the sensor card (lift-off distance) is hidden.
7. Confirm battery percentage and charging state populate while the cable is
   attached.
8. Confirm Primary and Logo lighting zones are offered. Writes are
   write-only — the current effect is not read back.

Do not use factory reset. Format 3 has no factory-reset image.

## G502 HERO (direct-connect, HID++ device index `0xFF`)

The wired G502 HERO follows the same direct-connect path as the G403 HERO:
legacy `0x2201` DPI and `0x8060` report rate, profile format 2 (LOGAN).

1. Repeat the G403 checklist. The polling-rate controls must be enabled and
   write the active onboard profile's report-rate byte, then reload as the new
   rate — this is the fix for "cannot click the 1 kHz polling rate option".
2. Confirm the rate actually changed in the OS (e.g. a mouse-rate tester), not
   just in the profile read-back, so the reload-on-write behaviour is understood.
3. Open a stored profile and change normal and G-Shift assignments. Confirm the
   physical button follows each layer and that unrelated assignments survive.

## G309 LIGHTSPEED (receiver-attached, Model ID `B03C40B10000`)

The G309 exposes Extended Adjustable DPI `0x2202` and Mode Status `0x8090`, but
only the power-mode half of Mode Status is meaningful: the status1 byte that
would carry the gaming-surface and LightForce fields is reserved and reads 0.
The `0x2202` sensor likewise reports lift-off level 0, the feature's "no
lift-off control" value. OpenMouse treats both as absent, so those cards stay
hidden.

1. Confirm the model, battery, connection type, DPI, and polling rate are read
   correctly.
2. Confirm the sensor card (lift-off distance), the gaming-surface card, and
   the LightForce switch are all hidden.
3. Change the DPI and polling rate and confirm each write persists after a
   reload.

## G305 LIGHTSPEED (receiver-attached, Model ID `407400000000`)

Like the G309, the G305 exposes Mode Status `0x8090` but only the power-mode
half is meaningful: the status1 byte that would carry the gaming-surface and
LightForce fields is reserved and reads 0. The G305 also has no lift-off
control. OpenMouse treats all three as absent, so those cards stay hidden.

1. Confirm the model, battery, connection type, DPI, and polling rate are read
   correctly.
2. Confirm the sensor card (lift-off distance), the gaming-surface card, and
   the LightForce switch are all hidden.
3. Change the DPI and polling rate and confirm each write persists after a
   reload.

## MX Master 3S (Logi Bolt `046d:c548`, WPID `B034`)

The MX Master 3S pairs to a Logi Bolt receiver. HID++ 2.0 feature calls use
**long** reports on pairing slot 1–6 (often slot 2), not device index `0xFF`.
It exposes Adjustable DPI `0x2201` and Unified Battery `0x1004`, and has no
`0x8060`/`0x8061` report-rate feature and no lift-off / onboard-profile path.

1. Close Logi Options+. Authorize both Bolt HID++ collections if offered.
2. Confirm the sidebar shows the Bolt receiver / MX Master 3S, connection
   **Wireless**, battery percentage, and DPI.
3. Confirm the sensor (lift-off) card and polling-rate buttons stay inactive /
   noted as unavailable — this mouse has no HID++ polling control.
4. Stage a DPI change and flash it. Confirm read-back matches and the value
   persists after a reload.
5. If connect fails with "invalid command", the short collection alone was
   selected — reconnect and include usage `0x0002`.

## MX Master 4 (Logi Bolt `046d:c548`, WPID `B042`)

Same Bolt transport as the MX Master 3S: HID++ 2.0 feature calls use **long**
reports on a pairing slot (slot 2 on the unit this was written against), not
device index `0xFF`. Firmware `LD 04.00` / `RBM 27.00`.

It is the only Logitech mouse known to carry Haptic `0x19B0`. It has no
`0x2202`, `0x8060`/`0x8061`, `0x8100`, `0x1001` or `0x1F20`, so the polling,
lift-off and onboard-profile paths stay inactive.

1. Close Logi Options+. Authorize both Bolt HID++ collections if offered.
2. Confirm the sidebar shows the Bolt receiver / MX Master 4, connection
   **Wireless**, battery percentage, and DPI.
3. Confirm haptic strength reads back as one of Subtle / Low / Medium / High.
   A factory-default mouse reports Medium (60).
4. Change the strength and confirm the mouse buzzes at the new setting, then
   reload and confirm the value persisted.
5. Turn haptic feedback off. Confirm the strength control goes inactive and
   pressing the Actions Ring panel no longer buzzes. Turn it back on.
6. Toggle haptic battery saving and confirm the strength setting is unchanged
   — the two share one byte, so a write that loses the other field shows up
   here.
7. Cross-check against Logi Options+ by changing the strength preset **there**
   and confirming OpenMouse reads the new value. Options+ caches its own view
   and will not re-read a change made outside it, so verify in that direction.

### Button remapping (`0x1B04`)

This unit reports nine controls. Left and right click report a group mask of
zero, so the firmware itself offers no targets for them.

Reading the table costs two round-trips per control, so it is deliberately not
part of the status refresh: read it on connect and after a write.

1. Confirm all nine controls are listed, and that **left and right click offer
   no targets at all** — that restriction comes from the device, so a mouse
   that started offering them would mean the group mask is being misread.
2. Remap a button — the gesture button to middle click, say — and confirm the
   physical button performs the new action. Reload and confirm it persisted.
3. Set it back to itself and confirm the original action returns.
4. Confirm a remap does not change any button's diverted state. The write
   marks no flag valid, so diversion should be untouched either way.
5. With Logi Options+ **running**, confirm the buttons it has taken over read
   as diverted. Close Options+ and confirm the mouse clears that itself —
   Options+ uses the temporary flag, not the persistent one.
6. Use "restore to hardware control" on a mouse with nothing diverted and
   confirm it writes nothing rather than rewriting every control.
