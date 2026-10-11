# Vancer x Arbiter Studio Akitsu protocol evidence

The Akitsu is configured through Arbiter Studio's WebHID configurator, the
"Arbiter Web HUB" at <https://webapp.arbiterstudio.com/>. Version 1.0.2.3 was
inspected on 2026-10-11:

- `/Config/env-models.json` is the device table: product ids, polling rates,
  DPI ceiling, lift-off choices and per-model feature flags.
- `/static/js/index-4718c809.js` holds the HID helper class with the concrete
  feature-report packets.
- `/static/js/index-d706f167.js` is the settings page that decides which
  controls each model shows.

The mouse enumerates with manufacturer string `Vancer` and product string
`Vancer Akitsu Mouse`, so OpenMouse labels it with the `Vancer` brand.

## Runtime identities

All Akitsu models use the shared CompX VID `0x373e`.

| Model | Connection | PID | Polling rates | DPI max | Lift-off |
| --- | --- | --- | --- | --- | --- |
| Akitsu 3395 | cable | `0x0009` | 500, 1000 Hz | 26,000 | 1, 2 mm |
| Akitsu 3395 | 8K receiver | `0x000a` | 500–8000 Hz | 26,000 | 1, 2 mm |
| Akitsu 3950 | cable | `0x0038` | 500, 1000 Hz | 30,000 | 0.7, 1, 2 mm |
| Akitsu 3950 | 8K receiver | `0x0039` | 500–8000 Hz | 30,000 | 0.7, 1, 2 mm |
| Akitsu Medium 3950 | cable | `0x0066` | 500, 1000 Hz | 30,000 | 0.7, 1, 2 mm |
| Akitsu Medium 3950 | 8K receiver | `0x0067` | 500–8000 Hz | 30,000 | 0.7, 1, 2 mm |

Every model has five DPI stages in 50 DPI steps. The table also lists
`0xb009`, `0xb00a`, `0xb038` and `0xb039` as bootloader PIDs. Firmware-update
identities are not catalogued here.

Before these entries existed, the Attack Shark driver's broad `0x373e` branch
would have claimed an Akitsu and labelled it an Attack Shark. Cataloguing the
ids routes them to the CompX driver instead.

## Protocol match

The Web HUB's mouse helper is the same XVI/CompX helper LunaFury ships. It
sends report ID 0 with a 64-byte payload, `[status, 0, target, length, page,
command, ...args]`, and waits for status `0xa1`. That is the envelope in
`src/compx/codec.ts`. Every read and write the driver uses has the same page,
command and encoding in the Web HUB:

| Setting | Read | Write / encoding |
| --- | --- | --- |
| Firmware | page `0x00`, command `0x81` | read only |
| Battery | page `0x00`, command `0x83` | read only |
| Active profile | page `0x00`, command `0x85` | read only |
| Sleep | page `0x00`, command `0x87` | command `0x07`; big-endian seconds, slider 1–30 min |
| Debounce | page `0x00`, command `0x88` | command `0x08`; slider 0–15 ms |
| Polling rate | page `0x01`, command `0x80` | command `0x00`; `02/01/20/40/80` = 500 through 8000 Hz |
| DPI stages | page `0x01`, command `0x81` | command `0x01` |
| Lift-off distance | page `0x01`, command `0x88` | command `0x08`; `87/01/02` = 0.7/1/2 mm |
| Angle snap | page `0x01`, command `0x84` | command `0x04` |
| Motion Sync | page `0x01`, command `0x89` | command `0x09` |
| Ripple Control | page `0x01`, command `0x8a` | command `0x0a` |
| 20K FPS (`TrackingMode`) | page `0x01`, command `0x93` | command `0x13`; shared field `performanceMode` |

The Web HUB always addresses the mouse as target `0x02`, on the cable as well
as through the receiver. On hardware the Akitsu Medium cable answered both
`0x02` and `0x00`, so no `mouseTarget` override is needed.

The Web HUB sends lift-off as three bytes, `[profile, lod, extra]`, and echoes
back a trailing byte it read. The Akitsu Medium returns only two bytes, so the
echoed byte is 0, and the driver's two-byte write is equivalent.

### Controls the Web HUB hides

For every Akitsu model the table sets `DPIXYEnable` and `HyperModeEnable` to
`0`. The firmware still answers page `0x01` command `0x8d` (separate X/Y) and
`0x8b` (High-Speed Mode). The product profiles set `separateDpiAxes: false`
and `hyperMode: false`, so the driver neither reads nor writes either one.

`_20KFPS` is `1` only for the Akitsu Medium, so the 20K FPS toggle (command
`0x93`) appears only there. The Akitsu 3395 and 3950 profiles set
`performanceMode: false` to match.

The Web HUB also shows UI-only warnings on the Akitsu Medium when debounce is
0 ms ("might cause double click") or lift-off is 0.7 mm. These do not change
any packet.

## Hardware verification

The Akitsu Medium 3950 cable (`0x0066`, mouse firmware `0.0.7.2`) was tested
on macOS through node-hid with the real `LamzuHidClient`:

- `readStatus()` decoded firmware, battery, active profile, sleep, debounce,
  DPI stages, polling rate, lift-off, angle snap, Motion Sync, 20K FPS and
  Ripple Control. The session is recorded in
  `captures/vancer-akitsu-medium/wired.json` and replayed by
  `src/drivers/lamzu/vancer.test.ts`.
- 1000 → 500 → 1000 Hz, 2400 → 2450 → 2400 DPI and 0.7 → 1 → 0.7 mm lift-off
  were each confirmed by read-back. A fresh `readStatus()` afterwards matched
  the original settings.
- `setHyperMode` was refused without sending a packet.

Not yet exercised: the Akitsu Medium 8K receiver (`0x0067`), the Akitsu 3395
and 3950 at all, persistence across a power cycle, and testing in Chromium
through OpenMouse. The receiver and other-model entries come from the vendor
table only.
