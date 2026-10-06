# AJAZZ AJ179 PRO

The AJ179 PRO uses the existing GearHub-V5 driver, not a separate AJAZZ
driver. GET_USB_VERSION device id **1851** identifies the model; the
shared VID/PID does not. The profile supplies its PAW3395 limits and button
layout. No application-specific UI or native service is required.

## Evidence

Hardware verification: Windows 11, firmware v3.03, 2026-10-05. Identity and
settings were exercised through the built WebHID driver and registry, using
a local HIDAPI adapter. The installed AJAZZ Driver (R) catalog independently
maps device id 1851 to AJ179 PRO / PAW3395. Analysis of its BLE backend
established the Bluetooth framing and battery request. No vendor binaries,
proprietary source, HID paths, or serial numbers are included.

`captures/ajazz-aj179-pro.json` contains sanitized receiver replies used
as regression fixtures. The official AJAZZ driver catalog is at
<https://www.a-jazz.com/h-col-156.html>.

## Transports

| Connection | VID:PID | Control collection | Reports |
| --- | --- | --- | --- |
| 2.4 GHz receiver | 3151:402D | FFFF:0002 | Unnumbered 64-byte feature |
| USB cable | 3151:4026 | FFFF:0002 | Unnumbered 64-byte feature |
| Bluetooth | 3151:402C | FF55:0202 | ID 6, 65-byte input/output payload |

Receiver commands use the existing F6/05 target selection, F7 readiness,
checksummed mouse command, F7 readiness, FC notice-read, feature-read
sequence. USB skips the relay. All three paths resolve the same device id.
The charging dock has no configurable controls claimed by this integration.

Bluetooth payloads are `[0x55, ...64-byte USB block]`; the report id is
supplied separately to WebHID. Replies arrive through `inputreport`, not
feature reports. A listener is attached before sending, commands are queued,
and unrelated report ids/envelopes/echoed command ids are ignored. Request
loopbacks are rejected rather than decoded as settings. SET packets have
no read-back exchange; a short delay separates them from subsequent GETs.

Bluetooth battery uses a separate raw payload `[0x77, ...64 zero bytes]`,
without the 0x55 envelope or USB checksum. The reply begins with 0x77 and
the percentage; 0x88 indicates sleep. Values 0..100 are accepted; loopbacks
and invalid values are rejected. Battery read failure does not prevent
reading settings. Charging state remains **Unknown** on this model: no
reliable charging flag has been established, including on the dock.

Bluetooth descriptor:
`0655ff0a0202a10185060902150026ff007508954181000902150026ff00750895419100c0`.

## Settings and model-specific layout

- DPI: 50..26000 in 50-DPI increments, including 1000; separate X/Y values,
  active-stage selection, and stage indicator colors.
- GET_DPI reports eight-slot capacity. Trailing stages disabled on both axes
  are omitted only from status; all eight slots and colors survive writes.
- Stored polling: 125/250/500/1000/2000/4000/8000 Hz on the receiver; USB
  is capped at 1000 Hz. Stored Bluetooth polling is **not** a measurement
  or guarantee of the BLE link's physical input rate.
- Low/High lift-off, debounce 0..10 ms, angle snapping, ripple correction,
  and sleep. Sleep writes preserve the existing driver policy of setting
  both link timers; status reads the timer for the connected wireless link.
- Button remapping reuses the shared six-button editor and nine mouse/DPI
  actions. AJ179 has Forward in slot 3 and Back in slot 4, reversed from
  the default GearHub layout. GET D0 returns a raw matrix; SET 50 changes
  only one slot. Both commands use the existing Bit7 checksum.

Stage-count editing, onboard profile switching, keyboard bindings, macros,
firmware updates, reset, pairing, and calibration are not implemented or
claimed. The vendor UI hides separate DPI axes and starts debounce at 2 ms;
successful readback of lower debounce and separate axes does not establish
their physical effect.

## Hardware verification results

| Check | Receiver | USB | Bluetooth |
| --- | --- | --- | --- |
| Settings write/readback | 49 cases | 46 cases | 49 cases |
| Side-button actions write/readback | 18 cases | 18 cases | 18 cases |
| Back/Forward physically reassigned to Middle Click | Passed | Not measured | Not measured |
| Physical DPI-button stage advance | Passed | Not measured | Not measured |
| Windows-delivered motion report rate | 500 / 1000 Hz passed | Not measured | Not measured |

Settings cases cover all exposed polling values, enabled-stage value/color/
selection, DPI boundaries, separate axes, lift-off, debounce, corrections,
and sleep. Button cases cover nine actions on each side button and preserve
every other matrix byte. Complete option payloads, all eight DPI slots/
colors/active index, and the full key matrix were restored and compared.
These same settings persisted after removing charging power and switching
the mouse off for ten seconds, then reconnecting through Bluetooth.

Physical side-button tests used user-assisted Windows button-state
observation, not device-specific Raw Input. The DPI button advanced stage
2 to 3 without changing the table; both stages had 1000 DPI, so this proves
selection rather than a measured sensitivity change. Foreground Raw Input
filtered by device VID/PID measured 500 Hz (4001 reports / 8 s) and 994.5 Hz
median at configured 1000 Hz (7947 reports / 8 s). Background measurements
were delivery-limited and are not evidence of a mouse rate fault.

Actual sensor resolution, correction effects, lift-off height, LED appearance,
standby timing, receiver rates above 1000 Hz, and physical button/output
effects on USB/Bluetooth remain unmeasured. Inconsistent reads were observed
while other HID clients were open during initial experiments; concurrent
access is a plausible cause, not a proven root cause. Close other configurators
and wake the mouse before manual verification.

## Automated verification

Run `npm run check` in this repository. Follow `CONTRIBUTING.md` to install
the local package into OpenMouse without changing its manifest or lockfile,
then run the application's `npm run check`. Regression tests cover captured
status decoding, model quirks, shared-family behavior, framing, discovery,
write preservation, malformed/unrelated replies, listener cleanup, queue
recovery, and optional Bluetooth battery failures. Development-only native
observers and vendor reverse-engineering tools are not part of this package.
