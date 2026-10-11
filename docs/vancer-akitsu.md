# Vancer x Arbiter Studio Akitsu protocol evidence

I own the Akitsu Medium 3950 and tested it over both its cable and its 8K
receiver. The mouse enumerates with manufacturer string `Vancer` and product
string `Vancer Akitsu Mouse`, so OpenMouse labels it with the `Vancer` brand.

The protocol details come from Arbiter Studio's WebHID configurator, the
"Arbiter Web HUB" at <https://webapp.arbiterstudio.com/>. I inspected version
1.0.2.3 on 2026-10-11:

- `/Config/env-models.json` is the device table: product ids, polling rates,
  DPI ceiling, lift-off choices and per-model feature flags.
- `/static/js/index-4718c809.js` holds the HID helper class with the concrete
  feature-report packets.
- `/static/js/index-d706f167.js` is the settings page that decides which
  controls each model shows.

## Runtime identities

The Akitsu Medium 3950 uses the shared CompX VID `0x373e`.

| Model              | Connection  | PID      | Polling rates | DPI max | Lift-off     |
| ------------------ | ----------- | -------- | ------------- | ------- | ------------ |
| Akitsu Medium 3950 | cable       | `0x0066` | 500, 1000 Hz  | 30,000  | 0.7, 1, 2 mm |
| Akitsu Medium 3950 | 8K receiver | `0x0067` | 500–8000 Hz   | 30,000  | 0.7, 1, 2 mm |

The polling rates, DPI ceiling and lift-off choices come from the Web HUB's
device table, which also gives five DPI stages in 50 DPI steps. It lists no
bootloader PIDs for this model.

Before these entries existed, the Attack Shark driver's broad `0x373e` branch
would have claimed the Akitsu and labelled it an Attack Shark. Cataloguing the
ids routes them to the CompX driver instead.

## Protocol match

The Web HUB's mouse helper is the same XVI/CompX helper LunaFury ships. It
sends report ID 0 with a 64-byte payload, `[status, 0, target, length, page,
command, ...args]`, and waits for status `0xa1`. That is the envelope in
`src/compx/codec.ts`. Every read and write the driver uses has the same page,
command and encoding in the Web HUB. I confirmed every read and every write below on
hardware, the writes by read-back:

| Setting           | Read                        | Write / encoding                                       |
| ----------------- | --------------------------- | ------------------------------------------------------ |
| Firmware          | page `0x00`, command `0x81` | read only                                              |
| Battery           | page `0x00`, command `0x83` | read only                                              |
| Active profile    | page `0x00`, command `0x85` | read only                                              |
| Sleep             | page `0x00`, command `0x87` | command `0x07`; big-endian seconds, 1–30 min           |
| Debounce          | page `0x00`, command `0x88` | command `0x08`; 0–15 ms                                |
| Polling rate      | page `0x01`, command `0x80` | command `0x00`; `02/01/20/40/80` = 500 through 8000 Hz |
| DPI stages        | page `0x01`, command `0x81` | command `0x01`                                         |
| Lift-off distance | page `0x01`, command `0x88` | command `0x08`; `87/01/02` = 0.7/1/2 mm                |
| Angle snap        | page `0x01`, command `0x84` | command `0x04`                                         |
| Motion Sync       | page `0x01`, command `0x89` | command `0x09`                                         |
| Ripple Control    | page `0x01`, command `0x8a` | command `0x0a`                                         |
| 20K FPS           | page `0x01`, command `0x93` | command `0x13`; shared field `performanceMode`         |

The Web HUB always addresses the mouse as target `0x02`, on the cable as well
as through the receiver. On the cable my mouse answered both `0x02` and
`0x00`, so no `mouseTarget` override is needed. Through the 8K receiver, target `0x02`
reaches the mouse and target `0x00` is the dongle itself. The dongle answered
only the firmware read (page `0x00`, command `0x81`) and ignored every other
command.

The Web HUB sends lift-off as three bytes, `[profile, lod, extra]`, and echoes
back a trailing byte it read. My mouse answers the lift-off read with only two
bytes, so the echoed byte is 0, and the driver's two-byte write is
equivalent.

### Controls left out

The Web HUB's device table sets `DPIXYEnable` and `HyperModeEnable` to `0` for
this mouse, so the app offers neither separate X/Y DPI nor High-Speed Mode,
although the firmware still answers page `0x01` command `0x8d`
(separate X/Y) and `0x8b` (High-Speed Mode). To match, the product profiles set
`separateDpiAxes: false` and `hyperMode: false`, so the driver neither reads
nor writes either one.

The table sets `_20KFPS` to `1`, so the Web HUB shows a 20K FPS toggle. Its
helper calls this `TrackingMode`, command `0x93`, the same command as
LunaFury's 20 kHz Tracking Mode (see `docs/lunafury-testing.md`). The driver
reads it as `performanceMode` for both brands.

## Hardware verification

I tested the Akitsu Medium 3950 on macOS through node-hid with the real
`LamzuHidClient`, over the cable (`0x0066`) and the 8K receiver (`0x0067`).
Mouse firmware was `0.0.7.2` and receiver firmware `0.0.7.0`.

- On both connections, `readStatus()` decoded firmware, battery, active
  profile, sleep, debounce, DPI stages, polling rate, lift-off, angle snap,
  Motion Sync, 20K FPS and Ripple Control. The receiver also reported its own
  firmware. I recorded both sessions in `captures/vancer-akitsu-medium/`
  (`wired.json`, `receiver.json`), and `src/drivers/lamzu/vancer.test.ts`
  replays them.
- Over the cable, I confirmed 1000 → 500 → 1000 Hz by read-back.
- Through the receiver, I confirmed each of 500, 2000, 4000 and 8000 Hz by
  read-back, then restored 1000 Hz. Motion Sync stayed on after the 8000 Hz
  write. The Web HUB turns Motion Sync off in its UI at 8000 Hz, but the
  firmware did not.
- On both connections, I confirmed 2400 → 2450 → 2400 DPI and 0.7 → 1 → 0.7 mm
  lift-off by read-back. A fresh `readStatus()` afterwards matched the
  original settings.
- Through the receiver, I changed sleep (300 → 600 s), debounce (12 → 8 ms),
  angle snap, Motion Sync, Ripple Control and 20K FPS, confirmed each by
  read-back and restored it. A fresh `readStatus()` afterwards matched the
  original settings.
- `setHyperMode` was refused without sending a packet.

I also ran OpenMouse in Chromium against this build, and the settings worked.
Settings I changed were still in place after a power cycle, so the mouse
stores them rather than holding them only until it loses power.

The mouse blinks its LED red or green after a settings change. The Web HUB
triggers the same blinks, so this is firmware feedback, not something the
driver causes. I don't know what each colour means.
