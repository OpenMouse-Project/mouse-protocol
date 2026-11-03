# Scyrox V8 hardware notes

This document records what was verified on real hardware for the older Scyrox
V8 on its "SCYROX 8K Dongle". The driver is the same `ScyroxHidClient` that
serves the V8S (see [scyrox-v8s-testing.md](scyrox-v8s-testing.md)); the V8
differs in its sensor, and so in where its DPI stages live. Evidence: raw
report-8 exchanges and full `readStatus` reads through node-hid on Windows,
one polling-rate round trip, a full flash dump of 0-191, and the Scyrox web
configurator (scyrox.net, "S-center": cfg.json, sensor.json and the English
UI strings), including a screenshot of it connected to the same mouse.

## Identity and transports

- Receiver: "SCYROX 8K Dongle", VID/PID `0x3554:0xf5f7`, release `0x0216`.
- Dongle version (command `0x1d`): `02 16`.
- Mouse firmware (command `0x12`): `02 22`, v2.22.
- Configuration collection: usage page `0xff02`, usage `2`, report id 8 in
  and out, on interface 1. The same interface exposes `0xff05`, `0xff03`,
  `0x000c:1`, `0x0001:0x80`, `0xff04:2` and `0xff06:2`; a report-8 write to
  any of them fails with `WriteFile` error 1. Interface 0 is a keyboard and
  interface 2 the mouse.
- The handshake (command `0x01`) was not sent, so CID and MID are unread.
  The configurator's device table lists the V8 (upgrade tool firmware v2.22)
  under CID 62, MID 1, 10 and 11, and the V6 (v2.24) under MID 2, 12 and 13,
  with the same 3950 sensor and 30,000 DPI ceiling. The firmware version is
  what names this mouse a V8.
- Command `0x03` answers whether the mouse is awake behind the dongle
  (byte 6: `01` awake, `00` asleep). While it reads `00`, every other command
  goes unanswered.

## Protocol family

The V8 speaks the same CompX report-8 flash protocol as the V8S, and every
field the Atlantis client reads carried its 0x55 seal. The flash dump,
address by address:

| Flash | Bytes | Meaning |
| --- | --- | --- |
| 0 | `10 45` | Rate byte `0x10`, 2,000 Hz |
| 2 | `05 50` | Five DPI stages |
| 4 | `02 53` | Active stage 2 (1,600 DPI) |
| 8 | `00 55` | 20K switch off |
| 10 | `03 52` | Lift-off code 3, 0.7 mm on the 3950 |
| 12-31 | `07 07 00 47`, `0f 0f 00 37`, `1f 1f 00 17`, `3f 3f 00 d7`, `7f 7f 00 57` | Stages 400, 800, 1,600, 3,200 and 6,400 DPI |
| 169 | `00 55` | Debounce 0 ms |
| 171 | `00 55` | Motion sync off |
| 173 | `b4 a1` | Sleep 180, 30 minutes |
| 175, 177 | `00 55` | Angle snapping and ripple control off |
| 181 | `01 54` | Performance state on |
| 183 | `b4 a1` | Timer, same value as 173 |
| 185 | `00 55` | SensorMode |
| 189-191 | `ff ff ff` | Angle tuning fields, unsealed |

Battery (command `0x04`) read 75% to 80% at about 4,005 mV, discharging. The
profile query (command `0x0e`) answered profile 1.

The full `readStatus` of the new catalog entry returned "Scyrox V8", stages
400/800/1,600/3,200/6,400 with stage 2 active, 2,000 Hz, the stage colours
`#ff0000`, `#00ffff`, `#00ff00`, `#ffffff` and `#ffff00`, sleep 1,800 s,
performance mode on and firmware "Mouse v2.22".

### Rate bytes

The configurator offers the V8S's seven rates for the V8 and showed 2,000 Hz
while the rate byte held `0x10`, which is CompX's own table, so the V8 also
declares rate family "pulsar". Written on hardware through
`ScyroxHidClient.setPollingRate`: 2,000 → 1,000 Hz (read back 1,000), then
1,000 → 2,000 Hz (read back 2,000). The 125-500 Hz and 4,000/8,000 Hz bytes
come from the configurator's encoder, as on the V8S.

### DPI stage values

The 3950 keeps its stages in the legacy four-byte fields at flash 12, which
held the five stages the configurator showed. Reading the 3955 region at
6912, as the V8S does, failed with a corrupt stage. The catalog entry
therefore keeps the default legacy layout.

The ceiling is 30,000 DPI in 50-DPI steps. Both numbers are the
configurator's: its device table gives the V8 `"sensor": "3950",
"maxDpi": 30000`, and its 3950 table starts with a 50-30,000 band in steps of
50. That table also has a doubled band (30,100-60,000 in steps of 100,
DPIex 17), which the device's own 30,000 cap keeps out of reach, so the
driver does not encode it.

The legacy field holds ten bits per axis, enough for 51,200 DPI, but
`pulsarVgnEncodeDpi` stops at Pulsar's 26,000. The Atlantis client now
writes legacy stages through `lamzuAtlantisEncodeDpiStage`, which produces the
same bytes up to 26,000 and covers the whole field; each product's `maxDpi`
still bounds what is written.

## Vendor configurator mapping

The configurator's V8 entry matches the V8S's controls with these
differences, which the catalog follows:

- Lift-off: the 3950 offers three heights coded 3, 1 and 2 for 0.7, 1 and
  2 mm. That order fits neither the Atlantis two-stop write nor the 1-to-n
  scale the V8S uses, so lift-off is not offered (`supportsLiftOffDistance:
  false`, no `liftOffMillimetres`).
- Angle tuning: the configurator shows it only when 189 and 191 are sealed,
  and both read `ff`, so `supportsAngleTuning` stays off.
- Key response time: the configurator allows up to 30 ms on the V8; the
  Atlantis client offers 0-15 ms.
- Sleep: 173 and 183 held the same value, as the configurator's Scyrox sleep
  setter writes them, so `mirrorSleepToPerformanceTime` stays on.
- SensorMode at 185 is left alone (`supportsHyperMode: false`), as on the
  V8S.
- The 20K switch at flash 8 is shown for the V8 too (`FpsScanShow: true`) and
  read `00 55`.

## Not yet verified

- DPI, lift-off, angle tuning, sleep, debounce, the 20K switch, profiles,
  buttons and Restore were never written to the V8. Only the polling rate
  was, as a round trip ending on the rate read first.
- The sleep reading: the flash held 180 (30 minutes), while the configurator
  screenshot showed "1min", likely its default before the device read.
- Whether the V6 enumerates with the same dongle id. It would read the same
  fields (same sensor, same ceiling) but be named "Scyrox V8".
- The 4,000 and 8,000 Hz bytes on the V8: the configurator offers them, but
  neither has been read from this mouse.

## Product-id ownership

`0xf5f7` joins `SCYROX_PRODUCT_IDS`, so Pulsar's catch-all `0x3554` claim and
the Lamzu Atlantis client both leave it to the Scyrox client.

## Validation

- `npm run build`: passing.
- `npm test`: 2,745/2,747 passing. The two failures are Corsair tests that
  match a comma-grouped number (`18,000`) and fail under a French locale,
  where `toLocaleString` groups with a space; this change does not touch
  them.
- `npm pack --dry-run`: 900 files.
