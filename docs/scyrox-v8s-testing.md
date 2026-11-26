# Scyrox V8S hardware notes

This document records the values and transport behavior verified on real
hardware for the Scyrox driver, which reuses the Lamzu Atlantis client on
CompX's shared report-8 stack. Evidence: two OpenMouse diagnostics logs taken
against firmware v5.07 hardware (wired mouse and dongle), the Scyrox web
configurator itself (scyrox.net, "S-center" 3.1.0: its JavaScript rate encoder,
cfg.json, sensor.json and the English UI strings), and a side-by-side of that
configurator against a frontend running this driver.

## Identity and transports

- Mouse: "Scyrox V8S", wired VID/PID `0x3554:0xf515`.
- Receiver: "Scyrox Turbo 8k dongle", VID/PID `0x3554:0xf517`.
- Mouse firmware: v5.07 (command `0x12` returned `05 07` on both transports).
- Identity from the command `0x01` handshake (wired only): CID `0x3e`,
  MID `0x05`.
- Configuration collection: usage page `0xff02`, usage `2`, report id 8 in
  and out. The composite device also exposes `0xff04:2` (feature report 6)
  and `0xff06:2` (report 9), neither used by the driver.

## Protocol family

The V8S speaks CompX's report-8 flash protocol, the same stack as the Lamzu
Atlantis generation, the Pulsar 4K receiver, VGN and Teevolution. Every flash
field the Atlantis client reads decoded cleanly on both transports, with the
0x55 trailing seal intact on each field. One exception: the DPI stage values,
which the 3955 sensor keeps in a region of its own (see below):

- System row at `0x0000`: rate byte `01` (1,000 Hz), DPI stage count `01`,
  active stage `00`.
- DPI stage 0 at `0x000c`: `07 07 00 47` → 400 × 400 DPI; stages 1-3 decoded
  as 800, 1600 and 3200 DPI in the wired full-image sweep. These are the
  factory defaults, not live values; the 3955 region below holds the real
  ones.
- Stage 0 colour at `0x002c`: `00 FF 00 56` → `#00ff00`.
- Lift-off field at `0x000a`: value `2` (0.9 mm on the 3955 scale).
- 20K byte at `0x0008`: `00 55`, off (wired sweep).
- Sleep at 173 and the timer at 183 both `06` (wired sweep).
- Advanced row: debounce `0`, motion sync `1` (on), sleep `6` (60 s in
  ten-second units), angle snapping, ripple control, performance state and
  high performance all `0`.
- Battery (command `0x04`): 60% / 3,931 mV discharging on the dongle, 85% /
  4,031 mV charging on cable.
- Profile query (command `0x0e`) answered profile 1 on both transports.

The wired and dongle endpoints presented an identical settings image, so one
client serves both.

### Rate bytes

The rate byte uses neither Lamzu table. Scyrox's configurator encodes
`rate <= 1000 ? 1000 / rate : rate / 2000 * 16`, so 2,000/4,000/8,000 Hz are
0x10/0x20/0x40 - CompX's own encoding, the one `pulsarEncodePollingRate`
implements - and both products declare rate family "pulsar". Confirmed on
hardware: the mouse held 0x01 at 1,000 Hz on both transports, and held 0x20
while the configurator showed 4,000 Hz (a build decoding 0x20 with the Lamzu
table displayed 2,000). Neither Lamzu family fits: "wired" would write 0x20
for 2,000 Hz, which this firmware reads as 4,000, and the write-then-read-back
would confirm a rate the mouse is not on; "receiver" would write 0x10 for
1,000 Hz, which it reads as 2,000.

### DPI stage values

The 3955 sensor does not keep stage values in the legacy 4-byte fields at
flash 12 at all: those hold the factory defaults (400/800/1600/3200/6400)
indefinitely. The live values are 6-byte records at flash 6912
(`Sensor3955DPI` in the vendor configurator's flash map): `[xLo, xHi, yLo,
yHi, flags, seal]`, with the value stored as `dpi / multiplier - 1`, flags
bits 2-3 carrying x's value bits 16-17 and bits 6-7 y's, and bits 0-1 / 4-5
carrying one doubling per set bit. The vendor sensor table defines two bands:
1-42,000 DPI (multiplier 1) and 42,002-84,000 DPI (multiplier 2, marker 0x11
in both nibbles). So 1,600 DPI is `3f 06 3f 06 00 cb` and 50,000 is
`a7 61 a7 61 11 34`. Stage colours did not move: the vendor reads them at
`e*4 + DPIValue + 32`, the legacy 44 region.

This was the 400-vs-1,600 mismatch in the side-by-side: a build reading the
legacy region displayed the stage-0 factory default 400 while the mouse and
the configurator were on 1,600. The layout and bands are transcribed from the
configurator's own read and write routines (its d5/S0 decode and C5/E0
encode); the read side follows the routine that produced the 1,600 the
configurator displayed, and the write side still needs hardware.

### The 20K switch

"20K" in the configurator's advanced settings ("20,000 FPS requires
Competition Mode to be turned on") is a sealed one-byte field at flash 8, the
byte the vendor map names Scyrox20K (other CompX models keep a KeyOperation
bitmask at that address). The configurator disables the switch until
Competitive Mode is on; the driver mirrors that by refusing to enable turbo
mode while performance mode is off, rather than flipping both switches. The
read is raw, not seal-checked, because the vendor reads the byte without its
checksum too and a never-written byte may carry no seal. Exposed as
`turboMode`, so the app's shared Turbo mode card appears unchanged. The wired
full-image sweep read it as `00 55`: off, seal intact.

## Vendor configurator mapping

Scyrox's web configurator offers: motion sync, highest performance, sensor
angle (-30 to 30), key response time, mouse pair, restore, DPI (up to 50,000,
at most 5 presets), polling 125-8,000 Hz, lift-off 0.7-1.6 mm, ripple control,
angle snapping, sleep (10 s to 30 min), and a "20K" toggle.

Mapped to the driver, each against the configurator routine that writes it:

| Configurator control | Flash / command | Driver control |
| --- | --- | --- |
| Highest performance (reads "Competitive Mode" once on) | 181 | `performanceMode` |
| Motion sync | 171 | `motionSync` |
| Angle snapping | 175 | `angleSnapping` |
| Ripple control | 177 | `rippleControl` |
| Key response time (0-15 ms on the V8S) | 169 | `debounceMs` |
| Sleep time (10 s to 30 min) | 173, mirrored to 183 | `sleepTimeout` |
| DPI (5 presets, 50-50,000 in this driver) | 6912 records, colours at 44 | DPI stages |
| Polling rate | 0, CompX bytes | `pollingRateHz` |
| LOD (0.7-1.6 mm) | 10, codes 1-5 | `liftOffScale` |
| Mouse Angle Mode (-30 to 30) | 189, enable flag at 191 | `angleTuning` |
| 20K | 8, gated on 181 | `turboMode` |
| Restore | command `0x09` | `factoryReset()` |

"Highest performance" is the configurator's PerformanceMode switch: it writes
PerformanceState (flash 181), which is the Atlantis client's
`performanceMode`. Flash 183 is a timer, and the configurator's Scyrox sleep
setter writes every sleep value to both 173 and 183 (the V8S held `06` in
each), so the driver does the same (`mirrorSleepToPerformanceTime`).

The 3955 lift-off heights come from the configurator's per-sensor strings:
codes 1-5 are 0.7, 0.9, 1.2, 1.4 and 1.6 mm. The steps are uneven, so the
status carries each code's height (`millimetresByCode`) rather than letting
the app interpolate between the ends, and `liftOffDistance` holds the nearest
coarse stop. The two-stop `setLiftOffDistance` stays refused.

Mouse Angle Mode is a signed byte at 189. The configurator shows it only when
both 189 and 191 carry their seal, and before its first angle write it sets
191 to 1; the driver does both.

Restore sends `0x09` with no address or payload, then waits up to six seconds
for the echo, as the configurator does, and does not resend it.

Mouse pair (`0x05`/`0x06`) is not implemented: the app has no pairing control
to drive it. The Atlantis client's "high performance" toggle is switched off
for Scyrox (`supportsHyperMode: false`): the register it would write, flash
185, is SensorMode on this firmware, an LP/HP/Corded enum the vendor tool
switches by itself except when wireless at 1 kHz or below, not a boolean.

## Not yet verified

- No write has been exercised on Scyrox hardware. The setters inherit the
  Atlantis client's write-then-read-back behavior, so a wrong encoding fails
  loudly instead of sticking, but each still needs hardware confirmation.
  That includes the sleep mirror to 183, the lift-off scale, angle tuning and
  the restore command, which are the vendor routines transcribed.
- The 3955 stage region: the layout and encoding are transcribed from the
  vendor configurator's own routines, and the legacy-region mismatch confirms
  the live values live there, but neither this driver's read of 6912 nor its
  write has run against hardware yet.
- The driver seal-checks each 3955 record; the configurator does not. If the
  records for stages the user has not enabled were never written, raising the
  stage count would make every later read fail as a corrupt stage. Raising the
  count to 5 and reading back settles it.
- The angle fields at 189 and 191 lie past the wired sweep (which stopped at
  0xb8), so their seals have not been read. The configurator showing the
  Mouse Angle Mode slider for this mouse implies both are intact.
- Only the 1,000 Hz (`0x01`) and 4,000 Hz (`0x20`) rate bytes have been read
  from hardware. The 125-500 Hz and 2,000/8,000 Hz bytes come from the vendor
  configurator's encoder; setting each rate and cross-checking the vendor tool
  would confirm them, and would also be the first write test.
- The SensorMode register (flash 185) is left alone: whether the vendor tool's
  automatic LP/HP/Corded switching tolerates a manual write is unknown.
- CID/MID over the dongle and the profile count (4 assumed from the family
  default) are unconfirmed. The configurator offers profiles because the
  mouse answers `0x0e` with status 0, as the V8S did on both transports.
- The battery reading differs slightly from the configurator's (55% here
  against 51% there in one side-by-side). The driver reports the mouse's own
  percentage byte; the configurator derives its figure from the voltage and
  smooths it over time.

## Product-id ownership

`0xf517` was previously an unverified entry in the Lamzu Atlantis receiver
list (sourced from Lamzu's shipped device table). Hardware shows it
enumerating as a Scyrox dongle, so it moved to `src/scyrox/index.ts`. Both
Scyrox ids are excluded from Pulsar's catch-all `0x3554` claim, and the
registry overlap tests keep the three drivers disjoint.

## Validation

- `npm run build`: passing.
- `npm test`: 2,669/2,669 passing, including the registry overlap sweep,
  12 Scyrox driver tests and the Atlantis client tests for the lift-off
  scale, angle tuning, the sleep mirror and restore.
- `npm pack --dry-run`: `dist/scyrox/` and `dist/drivers/scyrox/` included.
