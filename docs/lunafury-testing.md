# LunaFury LUNA33 / TYPE33 protocol evidence

This integration is based on the public LunaFury WebHID configurator at
<https://mouse.lunafury.games/>. The site and its source map were inspected on
2026-10-05:

- `/js/app.14b76f96.js` and `/js/app.14b76f96.js.map` contain the device table
  and UI-side command calls.
- `/js/output.xvi3.min.js` contains the `XviUpdater` transport and the concrete
  feature-report packets.

The owner completed full-function testing on LUNA33 with firmware
`0.0.26.0`, over both cable and 8K receiver connections. This verifies the
LUNA33 runtime identities `0x0032` and `0x0033` on that firmware. TYPE33
identities and packet layouts are source-verified but have not been tested
on hardware.

The owner has not supplied separate results for power-cycle persistence,
other firmware versions, or native-Bridge end-to-end testing. The stated
Corded/20 kHz behavior has not been independently measured.

## Runtime identities

All devices use the shared CompX VID `0x373e`.

| Model | Connection | PID | Polling rates exposed by LunaFury |
| --- | --- | --- | --- |
| LUNA33 | cable | `0x0032` | 125, 250, 500, 1000 Hz |
| LUNA33 | 8K receiver | `0x0033` | 125, 250, 500, 1000, 2000, 4000, 8000 Hz |
| TYPE33 | cable | `0x0054` | 125, 250, 500, 1000, 2000, 4000, 8000 Hz |
| TYPE33 | 8K receiver | `0x0084` | 125, 250, 500, 1000, 2000, 4000, 8000 Hz |

The configurator also lists `0xb032`, `0xb033`, `0xb054`, and `0xb084` as
bootloader PIDs. They are intentionally excluded: firmware-update identities
must not be claimed by the normal settings driver.

Both models advertise a 30,000 DPI ceiling. LUNA33 exposes up to six DPI
stages and TYPE33 up to five. The stage-read request carries that model limit,
so each product profile supplies the correct maximum while the reply still
determines the active stage list at runtime.

## Protocol match

The configurator sends report ID 0 with a 64-byte payload. That is the same
CompX/XVI envelope implemented by `src/compx/codec.ts` and
`src/drivers/lamzu/hid.ts`.

| Setting | Read | Write / encoding |
| --- | --- | --- |
| Firmware | page `0x00`, command `0x81` | read only |
| Battery | page `0x00`, command `0x83` | read only |
| Active profile | page `0x00`, command `0x85` | read only |
| Polling rate | page `0x01`, command `0x80` | command `0x00`; `08/04/02/01/20/40/80` = 125 through 8000 Hz |
| Sleep | page `0x00`, command `0x87` | command `0x07` |
| Debounce | page `0x00`, command `0x88` | command `0x08` |
| Lift-off distance | page `0x01`, command `0x88` | command `0x08`; `87/01/02` = low/medium/high |
| DPI stages | page `0x01`, command `0x81` | command `0x01` |
| Angle snap | page `0x01`, command `0x84` | command `0x04` |
| Motion sync | page `0x01`, command `0x89` | command `0x09` |
| Ripple control | page `0x01`, command `0x8a` | command `0x0a` |
| Competitive Mode / 竞技模式 | page `0x01`, command `0x8b` | command `0x0b`; vendor `setHyperMode`, shared field `hyperMode` |
| Tracking Mode / 追踪模式 | page `0x01`, command `0x93` | command `0x13`; vendor `setTrackingMode`, shared field `performanceMode` |
| Sensor angle | page `0x01`, command `0x94`, length 2 | command `0x14`; signed byte, −30° through +30° |
| Lightning Trigger | page `0x00`, command `0x98`, length 4 | command `0x18`; 0 = off, 1 = left priority, 2 = right priority |
| Per-button latency | page `0x00`, command `0x92`, length 19 | command `0x12`; button IDs 1/2/3 = left/right/middle |
| Wheel anti-mistouch | page `0x00`, command `0x99`, length 4 | command `0x19`; enable byte and big-endian window in milliseconds |

The cable transport rewrites mouse target `0x02` to target `0x00`. The 2.4 GHz
receiver keeps mouse commands on target `0x02`, while receiver firmware remains
on target `0x00`. These are represented by the product profiles rather than a
forked LunaFury protocol implementation.

### LunaFury-specific controls

LunaFury labels follow its official `language.js` and `patternModule.vue`:
`angleSnapping` is 直线修正, `hyperMode` is 竞技模式, and `performanceMode`
is 追踪模式. Motion Sync and Ripple Control use 运动同步 and 波纹控制 in
Chinese. These are display overrides for LunaFury only; commands and labels
for other brands remain unchanged.

The owner clarified the hardware semantics on 2026-10-05: Competitive Mode
is Corded mode and Tracking Mode locks sensor sampling at 20 kHz. This
description is owner-provided, not an independently measured result.
The UI mirrors the vendor's `v-if="competition"`: tracking is shown only
while competitive mode is confirmed on. Hiding it preserves its stored
value. For staged changes, competitive mode enables before tracking edits
and disables after them; other brands retain their existing ordering.

`XviUpdater.hidIndex` is 1: received WebHID buffers do not include the report
ID. Decoders use the payload after the six-byte CompX header. Lightning mode
and sensor angle are payload byte 1; button ID is byte 2 and button latency
is bytes 3–4; wheel enable is byte 1 and its window is bytes 2–3.

Left/right latency uses 0–15 ms in 1 ms steps; middle-button debounce uses
1–30 ms. The 19-byte latency write payload is
`[profile, 0, buttonId, hi, lo, 0, 0, hi, lo, 0, 0, 0, 20, 0, 0, 0, 20, 0, 0]`.
Wheel guard uses 20–200 ms in 20 ms steps. A disabled zero window is a valid
read, not a guessed default; enabling it from that state proposes 100 ms.
Writing a disabled zero window is supported so restoring a Games profile
does not invent a different prior value.

All added setters read back the value and reject a mismatch. Optional reads
that fail or return invalid values leave their controls absent, while basic
device settings remain available. Only the LunaFury product profiles issue
these extra commands; other CompX brands are unchanged.

LunaFury extension reads accept a reply only when its payload echoes the
requested profile; button-latency reads also match the button ID. A successful
reply for another profile or button is ignored while the same request waits
for a matching reply, within its existing attempt limit. This applies to both
initial reads and write readbacks. Generic CompX requests and write
acknowledgments retain their existing matching rules.

The UI places Lightning Trigger, independent left/right latency, middle
debounce, and wheel guard on the Buttons tab. Sensor angle is in Processing
on the Performance tab. As in the vendor UI, left/right priority disables
the corresponding latency slider. Turning priority off is applied before
staged latency edits, and enabling priority is applied after them. These
settings can also be saved in Games profiles as a partial LunaFury namespace.
Each profile restores only the controls it changed, preserving unrelated
settings and valid zero values.

## Required hardware check

Connect each available cable/receiver identity in Chromium and confirm:

1. OpenMouse labels it `LunaFury LUNA33` or `LunaFury TYPE33`, never Attack
   Shark.
2. Firmware, battery, DPI stages, polling, LOD, sleep, debounce, motion sync,
   angle snap, and ripple control read successfully.
3. Change one reversible setting at a time, read it back, then restore the
   original value.
4. Confirm only the rates in the table are offered for that connection.
5. Confirm the driver refuses bootloader/DFU identities. The shared broad
   VID filter may still let Chromium show them in its native picker; do not
   select or send settings commands to an upgrade-mode interface.
6. With Lightning Trigger off, test independent left/right latencies and
   middle debounce, refresh/reconnect, and compare their values with the
   vendor configurator. Test each priority mode separately, restoring the
   initial mode afterward.
7. Test sensor angles −1°, 0°, and +1° first. Confirm direction and persistence
   on hardware, then restore the original angle.
8. Test wheel guard off and on at 20/100/200 ms. Confirm the actual firmware
   behavior, then restore both the original enable state and window.
9. Save a Games profile with a single LunaFury control, apply it, and restore
   the prior settings. Confirm unrelated controls remain unchanged, including
   the originally disabled zero wheel window if reported by this firmware.
10. Confirm Competitive Mode controls Tracking Mode's visibility, including
    staged on/off changes, without silently resetting its stored value.

Automated coverage includes all four runtime IDs, cable/receiver targeting,
profile 3, full packet fixtures, signed angles, invalid ranges, unsupported
reads, ignored writes, and the other-brand guard. LUNA33 hardware testing
is recorded above; TYPE33 still needs a real-device pass. The owner's
full-function report does not include item-by-item results for this checklist.
