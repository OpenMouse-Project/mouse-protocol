# Corsair NIGHTSWORD RGB fixtures

Hardware-verified reference material for `src/corsair/` and
`src/drivers/corsair/`. Everything here was read from a NIGHTSWORD RGB
(VID `0x1b1c`, PID `0x1b5c`) on firmware 3.41 / bootloader 3.08 over Chrome
WebHID on Windows 11, 2026-09-05. No serial numbers or personal data are
included.

| File | What it is |
|---|---|
| `PROTOCOL.md` | The protocol write-up: interfaces and picker filter, feature-report transport, packet layout, profile flag, the asymmetric DPI byte order, read-only and write commands, open questions, and the codec sketch the code follows. |
| `ident.hex` | Reply to `0e 01 00` (identify): firmware `0x0341`, bootloader `0x0308`, VID/PID little-endian, poll interval 1 ms. |
| `dpi-mask.hex` | Reply to `0e 13 05 00`: enabled-stage bitmask `0x0f` (stages 0–3). |
| `dpi-current.hex` | Reply to `0e 13 02 00`: active stage 2, X/Y 2400 big-endian (`09 60`). |
| `lift.hex` | Reply to `0e 13 03 00`: lift-off height 5. |
| `snap.hex` | Reply to `0e 13 04 00`: angle snapping off. |
| `stages-icue.hex` | Replies to `0e 13 d0..d5 00` with iCUE's software profile loaded: d0 = Sniper 400 (yellow), d1–d3 = iCUE Stage 1–3 at 800 / 2400 / 5700 (cyan), d4–d5 empty. |
| `stages-factory.hex` | Replies to `0e 13 d0..d5 00` after replug with iCUE stopped (onboard profile): d0 = Sniper 800, d1–d3 = 1500 / 3000 / 6000. Slot 1 (Stage 1) was active, mask `0x0f`, lift 5, snap 0. |
| `write-probe.txt` | Live SET probe with read-backs: stage select (`07 13 02`) switches live, angle snap (`07 13 04`) works with and without the trailing `0x05`, lift height (`07 13 03`) accepts 1–5. All restored afterwards. |

Each `.hex` file holds one reply per line as spaced hex, request bytes 0–3
echoed at the front, trailing zeros of the 64-byte buffer omitted. Lines
starting with `#` are comments. The tests in `src/corsair/index.test.ts` and
`src/drivers/corsair/hid.test.ts` carry these same bytes inline.

Not captured: the profile-ID reply (`0e 15 01`) is listed in `PROTOCOL.md`
but not interpreted, and no SET command has a reply to record.
