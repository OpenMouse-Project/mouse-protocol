# ROCCAT Kone Pro Air testing

How the `src/roccat/` protocol and the `src/drivers/roccat/` driver were put
together, what was proven on hardware, and what stays open. The captures live
in `captures/roccat-kone-pro-air/`.

## Device

One ROCCAT Kone Pro Air, firmware as shipped, wireless mode on its Stellar
Wireless dongle (`1e7d:2c8e`). The first capture session ran with ROCCAT
Swarm uninstalled, so the bytes there are probes and vendor-replayed frames.
A second session (`captures/roccat-kone-pro-air/profiles-and-write-path-2026-10-16.txt`)
ran with Swarm installed and driving the mouse, to watch the vendor path from
outside. Wired mode (`1e7d:2c92`) is mapped from the same protocol family but
was not exercised on this unit.

## Transport

The config channel is the composite's vendor interface — interface 2 of the
dongle (interface 1 wired), usage page `0xFF00` usage `0x0001` — and it
speaks plain **unnumbered 64-byte output reports**. Windows GET sweeps for
every report id answer nothing on any interface
(`captures/roccat-kone-pro-air/feature-sweep.txt`), so everything below is
`sendReport(0, …)`-shaped, and the mouse answers on the same interface's
interrupt-IN stream. On Windows node-hid the echo arrived on the same handle.
A WebHID `inputreport` listener on the same device object matches it the
same way.

Frame vocabulary, all in device coordinates (the vendor's 64-byte frames,
report id excluded):

```text
10 50 14 00 01 <polling> <angle> 00 <stage table 8..17> <lod> 00 80 <ledTimeout> 00 <debounce>   settings write
10 50 14                                                                                            settings query (no args)
10 50 18 04                                                                                         commit tail
10 10 0b 00 09 64 64 64 06 <r g b> <r g b>                                                          lighting write (two zones)
90 0a                                                                                               status probe
```

Echoes repeat frame byte 1 (the class byte) verbatim, which is how the driver
matches replies. Byte 2 of performance echoes was `0x03` every time; the
echo's later bytes are not established.

Polling codes are the **opposite** of the Burst Core dict
(`Roccat_Burst_Core_Mouse.js`) used on ROCCAT's older OEM mice: here
125 Hz → `0x03`, 1000 Hz → `0x00`. The second session confirmed the mapping
from the other direction: switching the edited profile's polling to 125 Hz in
Swarm moved exactly the polling byte of that profile's reply page to `0x03`.

The settings block is the **SignalRGB plugin's layout**: polling at offset 6,
one axis of five u16 little-endian DPI slots at offsets 9–18 (50/unit), lift
off at 19, `80` at 21, LED timeout at 22, debounce at 24. The mouse's own
reply pages line up with that block shifted right five bytes — polling at the
page's `b11`, the five u16 stages at `b14-23`, lift off at `b24` — and the
five `90 00 26` pages are the five onboard profiles, `b10` being the profile
index (see the 2026-10-16 capture). The earlier guess of two interleaved byte
lists at offsets 8..17 with lift off at 18 did not reproduce against the
mouse's stored tables and is superseded.

## What is verified on hardware

- **The vendor-replayed settings write and its commit tail are accepted** and
  echo the expected class frame (`10 50 03 …`). Acceptance is all the echo
  shows: no settings write sent by hand — this plugin layout or the earlier
  interleaved guess — ever changed a stored stage table in a reply read back
  afterwards. See "Write path" below.
- **The mouse's reply pages are the five onboard profiles**, decoded in the
  2026-10-16 capture: polling at `b11`, five u16 stage slots at `b14-23`,
  lift-off at `b24`, LED timeout at `b27`, profile index at `b10`, and a
  status byte at `b13` (00 empty / 01 valid / 02 being edited). The UI's own
  DPI card and polling radios line up with those fields byte for byte.
- **The status probe answers every poll** (`90 0a 04 00 00 <b5> <b6> 00
  <u16> <b10>` when awake; `90 0a 03 00 ec fa 0d 00` with an all-zero body
  while the mouse is asleep). Byte 5 tracked Swarm's own battery log across
  sessions — `0x5a` read "battery level: 90", `0x64` read "battery level:
  100" — so it is the battery percent; the trailing u16 still only moves up in
  a session and has no confirmed meaning. The driver still surfaces no
  battery reading: the success runs are from Swarm's log rather than from this
  capture, and the asleep body must not be read as 0 %.
- **The lighting write is idempotent** on repeat (three identical writes
  returned identical answers), and leaves the mouse's LEDs stable. There is
  no known read-back, so the codec ships lighting write-only — and the
  2026-10-16 reply pages also carry per-zone lighting frames (`90 01 0b …`),
  which may or may not be a usable read-back and are not decoded.

## Deliberately not shown on the UI

Polling rate read-back, lift-off, angle snapping and debounce have no
established echo positions, so those UI values surface from the driver's own
last write and the shared cards stay consistent with other
write-only-cached drivers (this mirrors the Razer driver's approach).

## Write path

The settings frame replaces the whole block, so each setter runs the repo's
read-patch-write-confirm cycle (as in the AJAZZ driver): read the mouse's
current table, patch the one field, write and commit, then read the table back
and confirm the mouse kept it. The pre-read preserves the stored DPI stages —
a polling-only change must not silently re-scale the mouse — and a write is
refused if the mouse will not report its table rather than substituting
defaults. A read-back that disagrees is reported as a failure, not success.
DPI is capped at 12,750 (255 × 50), the largest value the single slot byte can
carry; the vendor software's higher numbers were never captured and do not fit
this byte.

**Hardware status of the write path.** On the 2026-10-16 session, frames sent
by hand on interface 2 with stage 1 set to 500 were accepted and echoed, but
the reply pages afterwards still read the stored stage 1 at 400 in every
profile, and a listener on all four interfaces during Swarm edits saw the
vendor's read polls but no settings write on any of them. The vendor's device
DLL is a hidapi fork with no settings-write code — its `hid_write` is used
only by the calibration module. The honest reading is that a user-mode HID
write to this unit is acknowledged but not applied, and the vendor applies
settings over a channel a user-mode capture cannot see. The write path is
therefore best treated as **unverified on hardware**; the read-patch-write
machinery is the right shape, but nobody has watched a write land.

## Open questions (any owner can settle these with a replug)

- Why a user-mode settings write is acknowledged but does not apply, and
  which channel the vendor uses instead (the 2026-10-16 capture narrows it to
  "not any HID interface a user-mode listener can open").
- Which of the five u16 stage slots is sensor X and which is Y, if the unit
  keeps separate axes at all — the reply pages print one list.
- `b13`'s exact states and `b26`'s values in the reply pages.
- The wired generation's parity: interface index shifts by one per the
  community plugin; nothing was captured on the cable.
- Whether the per-zone lighting replies (`90 01 0b …`) are a usable read-back.
