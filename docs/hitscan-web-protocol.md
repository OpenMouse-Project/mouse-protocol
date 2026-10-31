# Hitscan web control protocol (control.hitscan.com)

Second Hitscan protocol generation, recovered from the production web app at
`control.hitscan.com` (release `1.0.15-fe600431`, `<meta name="hitscan-app-version"
content="1.0.15">`). It is unrelated to the native `Hitscan Utility 1.0.2`
protocol in [`hitscan-protocol.md`](hitscan-protocol.md) except for the shared
vendor id. No hardware validation is implied.

| Generation | Vendor / products | Transport | Entry point |
| --- | --- | --- | --- |
| Native Utility 1.0.2 | `0x3770` / `0x0100`, `0x0200`, `0x0300` | output **report 8**, 16-byte bodies, checksummed flash | [`hitscan-protocol.md`](hitscan-protocol.md) |
| Web control 1.0.15 | `0x3770` / `0x0136`, `0x0194`, `0x0300` | **feature report 0**, 64 bytes, `0xa1` status | this file |

`0x0300` is the shared 8K receiver. Both generations may therefore expose
interfaces on one dongle; `HitscanXviHidClient` only claims an interface that
declares a 64-byte feature report 0, and `HitscanHidClient` only claims the
report-8 input/output pair.

## Device selection

| Product | Transport | Name |
| --- | --- | --- |
| `0x0136` | Wired | Hyperlight X |
| `0x0194` | Wired | Hyperlight N |
| `0x0300` | Receiver | Paired mouse id comes from `GetDevicePID` |

The picker uses vendor/product only. `hitscanXviReply` selects the control
interface by descriptor shape, exactly like the vendor app (`featureReports`
with report id 0 and 512 bits).

Requests use mouse device id `2` in byte 2. The dongle's own firmware query
(`GetFirmwareVersion` for the receiver) uses device id `0`.

## Transport

* Requests and replies are 64-byte feature reports with report id 0.
* Status byte: `0xa1` success, `0x02` mouse asleep or out of range, anything
  else stale. Some platforms prepend the report id, so replies are normalized
  before parsing.
* Every reply echoes the request's class (byte 4) and command (byte 5); only a
  matching `0xa1` reply is accepted.
* The vendor app delays 20 ms after each send, then polls up to 30 times per
  send and retries the send up to five times. `HitscanXviHidClient` keeps that
  budget behind one serialized queue.
* Unsolicited state changes arrive on **input report 4** (see
  [Notifications](#notifications)).

Request: `[0, 0, device, length, class, command, data...]`
Reply (after normalization): `[0xa1, 0, 0, length, class, command, payload...]`

Payload offsets below start at reply byte 6.

## Commands

`class 0` is configuration, `1` sensor, `2` stage colours, `3` buttons, `4`
macros. A command value may repeat across classes.

| Class | Command | Operation | Request data | Reply payload |
| --- | --- | --- | --- | --- |
| 0 | `0x81` | Firmware | none (device 0 for dongle) | `major.minor.patch.build` at `[0..3]` |
| 0 | `0x83` | Battery | none | `[charging, percent]` |
| 0 | `0xa7` | Signal | none | `[level, rssi]`, level 1 strong/2 medium/3 weak/0 none |
| 0 | `0x8b` on device 1 | Paired mouse id | `[2]` | VID `[2..3]`, PID `[4..5]` |
| 0 | `0x85` | Active profile | none | `[profile]` |
| 0 | `0x86` | Profile count | none | `[count]`, 1-10 |
| 0 | `0x05` | Select profile | `[profile]` | `[profile]` |
| 0 | `0x8e` | Read profile name | `[profile]`, length 58 | `[profile, length, GBK bytes]` |
| 0 | `0x0e` | Write profile name | `[profile, length, bytes]` | status only |
| 0 | `0x0d` | Reset profile | `[profile]` | status only |
| 0 | `0x87` | Read auto-sleep | `[profile]` | `[profile, hi, lo]` |
| 0 | `0x07` | Write auto-sleep | `[profile, hi, lo]` | status only |
| 0 | `0x99` | Read tournament scroll | `[profile]` | `[profile, flag]` |
| 0 | `0x19` | Write tournament scroll | `[profile, flag, hi, lo]` | status only |
| 0 | `0x88` | Read click timings | `[profile, 0, 0, 0, 0, 0]` | `[profile, 4 timings, 3]` |
| 0 | `0x08` | Write click timings | `[profile, 4 timings, 3]` | status only |
| 1 | `0x80` / `0x00` | Read/write polling rate | `[profile]` / `[profile, code]` | `[profile, code]` |
| 1 | `0x88` / `0x08` | Read/write lift-off | `[profile]` / `[profile, encoded]` | `[profile, encoded]` |
| 1 | `0x94` / `0x14` | Read/write sensor angle | `[profile]` / `[profile, signed byte]` | `[profile, signed byte]` |
| 1 | `0x89` / `0x09` | Read/write Motion Sync | `[profile]` / `[profile, flag]` | `[profile, flag]` |
| 1 | `0x8b` / `0x0b` | Read/write Performance mode | `[profile]` / `[profile, flag]` | `[profile, flag]` |
| 1 | `0x93` / `0x13` | Read/write Competitive mode | `[profile]` / `[profile, flag]` | `[profile, flag]` |
| 1 | `0x8d` / `0x0d` | Read/write split X/Y DPI | `[profile]` / `[profile, flag]` | `[profile, flag]` |
| 1 | `0x81` | Read DPI stages | `[profile, capacity]` | `[profile, count, x/y pairs]` |
| 1 | `0x01` | Write DPI stages | `[profile, count, x/y pairs]`, length always 26 | status only |
| 1 | `0x82` / `0x02` | Read/write active stage | `[profile]` / `[profile, 1-based stage]` | `[profile, stage]` |
| 1 | `0x8c` | Maximum DPI | none | 16-bit maximum |
| 2 | `0x81` / `0x01` | Read/write stage colours | `[profile]` / `[profile, 18 bytes]` | `[profile, 18 bytes]` |
| 3 | `0x83` / `0x03` | Read/write SPDT flags | `[profile]` / `[profile, left, right]` | `[profile, left, right]` |
| 3 | `0x80` | Read button | `[profile, id, 0, 0xff, length]` | `[profile, id, 0, function, length, data]` |
| 3 | `0x00` | Write button | `[profile, id, 0, function, length, data]` | status only |
| 4 | `0x85` | Macro list | `[capacity hi, lo]` | `[count hi, lo, 0, 0, ids...]` |
| 4 | `0x81` | Macro byte size | `[id hi, lo]` | `[id hi, lo, size (32-bit)]` |
| 4 | `0x01` | Allocate macro bytes | `[id hi, lo, size (32-bit)]` | status only |
| 4 | `0x03` / `0x83` | Write/read macro bytes | `[id, offset (32-bit), length, data]` | `[id, offset, length, data]` |
| 4 | `0x06` / `0x86` | Write/read macro name | `[id, length, GBK]` / `[id, 56]` | `[id, length, GBK]` |
| 4 | `0x02` | Delete macro | `[id hi, lo]` | status only |

The vendor SDK's `getNewDebounceTime` requests six bytes and returns five; the
fifth is the constant `3`, so the codec exposes only the four timings.

## Value encodings

* Polling: 125/250/500/1000/2000/4000/8000 Hz = `8/4/2/1/32/64/128`; a read of
  `16` is also 1 kHz. The app offers 500-8000 Hz on both paths.
* DPI: 50-30000 in 50-unit steps, up to four stages. The read request may ask
  for six; a reply above four is rejected as an unsupported generation.
* Stage colours: six RGB triplets for four stages, `#rrggbb` in the UI.
* Lift-off: `0.7` mm is `(7 | 0x80)`, whole millimetres are sent raw. The app
  offers 0.7/1/2 mm.
* Sensor angle: signed byte, -30..+30 degrees.
* Auto-sleep: big-endian seconds; `0xffff` (also `0xff00`/`0`) reads as never.
  The app offers 10/30/60/300/600 s.
* Click timings: four 0-50 ms values (before press, before release, after
  press, after release), followed by `3`.
* SPDT: one flag per primary button. The vendor SDK duplicates a single flag;
  Hitscan's own adapter writes independent left/right values, which is what the
  codec and driver do.
* Tournament scroll: flag plus a 300 ms timeout constant.

## Buttons

Six slots, in this order: Left (`1`), Right (`2`), Middle (`3`), Forward (`5`),
Back (`4`), DPI (`0x14`). A binding is a function id plus data:

| Action | Function | Data |
| --- | --- | --- |
| Mouse button | `1` | `1` left, `2` right, `3` middle, `4` back, `5` forward |
| Wheel up/down | `1` | `16` / `17` |
| Media | `5` | 16-bit usage (`0x183` player, `0xcd` play/pause, `0xb5` next, ...) |
| Key | `4` | `[modifiers, HID usage]` |
| DPI loop / +/- | `7` | `[6]` / `[1]` / `[2]` |
| DPI lock | `7` | `[5, hi, lo, hi, lo]` |
| Profile switch | `8` | `[3]` |
| Polling switch | `13` | `[3]` |
| Disable | `0` | `[]` |
| Macro | `16`/`17`/`18` | count / held / toggle, `[hi, lo, count?]` |

Key and modifier tables follow the vendor codec's `KeyboardEvent.code` mapping
(`KeyA` = 4 ... `F24` = 115; Ctrl/Shift/Alt/Meta left/right bits
1...128). Unknown bindings stay `custom` and round-trip unchanged.

## Macros

Twenty slots. A macro is an allocated byte buffer plus a GBK name and an event
stream:

* `0x20 n` delay of *n* ms; `0x21 hi lo` for 256-60000 ms.
* `0x01 mask` mouse state change (left 1, right 2, middle 4, back 8, forward 16).
* `0x02 usage` / `0x03 usage` key down/up.
* `0x09 bit` / `0x0a bit` modifier down/up.

Down/up pairs must balance. Unknown event types or oversized slots are returned
read-only rather than rewritten.

## Names

The vendor writes names as GBK, except the default marker `"Profile "` encoded
as UTF-16LE. Decoding recognises that marker and otherwise uses GBK, trimming
trailing NUL padding. Encoding supports GBK by deriving a reverse table from the
runtime `TextDecoder` (56-byte limit), matching the vendor's own encoder.

## Notifications

Input report 4 carries unsolicited updates. A leading `4` is dropped when the
platform keeps the report id.

| First bytes | Meaning |
| --- | --- |
| `0x19 rssi level` | Receiver signal |
| `0x06 0` / `0x06 1` | Mouse slept / woke |
| `0x03 percent charging` | Battery report |
| `0x02 ...` | Profile changed; reread settings |
| `0x01 stage x.hi x.lo y.hi y.lo` | DPI stage value |
| `0x07 raw` | Lift-off distance |
| `0x08 code` | Polling rate |

## Implementation

`src/hitscan/xvi.ts` owns frames, value encoders/decoders, notifications and
command builders; `src/hitscan/xvi-inputs.ts` owns button actions, macro events
and GBK names. Both are exported from `@openmouse/protocol/hitscan` and the root
`hitscan` namespace.

`HitscanXviHidClient` in `src/drivers/hitscan/xvi-hid.ts` reads the full
settings surface into `MouseStatus` and exposes profile, button, macro and
telemetry methods. Every setter writes, reads back and throws on mismatch.
`readStatus(true)` refreshes battery, signal and the active profile.

```ts
import { HitscanXviHidClient } from '@openmouse/protocol/drivers/hitscan/xvi-hid';
import { hitscanXviPollingRateSetRequest } from '@openmouse/protocol/hitscan';

const client = new HitscanXviHidClient(device);
const status = await client.readStatus();
await client.setPollingRate(8000);
await client.setSpdt(true, false);
const macros = await client.readMacros();
await client.close();
```

## Evidence and limits

Recovered statically from these shipped files (release `1.0.15-fe600431`):

* `hitscan-device.js` — transport, settings map, retries, telemetry, profile and macro orchestration.
* `hitscan-input-codec.js`, `hitscan-inputs.js` — button/macro codecs, macro storage, profile names.
* `vendor/xvi-20260924.min.js` — packet constructors and reply offsets.
* `app.js` — UI ranges and defaults.

Not established:

* Behaviour on real X/N mice and both dongle firmware families.
* Whether every firmware accepts all four DPI stages, 8 kHz, the SPDT
  timings or the tournament-scroll timeout.
* The physical meaning of the unnamed reply bytes outside the offsets above.
* Whether the shared `0x0300` receiver exposes the native Utility interface at
  the same time as this control interface.

Firmware flashing, pairing and factory restore are deliberately not exposed.
