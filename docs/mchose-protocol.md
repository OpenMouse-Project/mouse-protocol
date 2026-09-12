# MCHOSE protocol notes

Vendor id **`0x3837`**. Reverse-engineered from MCHOSE's own **M HUB web
driver** (`https://www.mchose.com.cn/assets/purify.es-DfJclCKp.js`, build
`0cac79355`, 2026-09-04) and verified against an **A7 V2 Ultra+** over both its
2.4 GHz receiver and its USB cable.

## Which collection is the real one

The mouse and its receiver both expose three interfaces and five collections.
Two of them look like control channels and are not:

| Usage page / usage | Reports | What it is |
| --- | --- | --- |
| `0x0001` / `0x0002` | — | boot mouse. Opens, but has **no readable feature report at any id 0x01–0xff**. |
| `0x0001`/`0x0006`, `0x000c`/`0x0001` | — | keyboard + consumer control |
| `0xff0b` / `0x0104` | in `0x2a` `0x2c` `0x2d`, out `0x2a` `0x2d`, feature `0x2a` `0x2b` | **firmware update.** The offer/response/payload triple is Microsoft's Component Firmware Update shape, and M HUB drives these ids against `/newBin/<model>.offer.bin`. Feature `0x2a` reads a firmware descriptor. Not config. |
| `0xff01` / `0x0001` | in `0x11` `0x12`, out `0x13` `0x14`, feature `0x11` `0x12` `0x14` | **the configuration channel** |

Output report `0x13` is declared but the firmware rejects every write to it;
`0x14` accepts writes and never answers. Configuration does not use the output
reports at all — it uses **feature** reports `0x11` and `0x12`.

## Transport: everything is bit-inverted

This is the detail that makes the channel look like a loopback if you miss it.
M HUB's sender spells each command as a token string (`"11 06 00 00 …"`), takes
the first token as the report id, and sends **every remaining token XOR 0xff**:

```js
sendFeatureReport(0x11, [cmd ^ 0xff, arg0 ^ 0xff, …])   // rest of the report stays 0x00
receiveFeatureReport(0x11) -> [reportId, ~cmd, ~payload0, ~payload1, …]
```

The reply's byte 1 must un-invert to the command that was sent. Report `0x11`
carries the short command set (command + 19 argument bytes); report `0x12`
carries the long one (command + 63). Chrome zero-pads the rest of the 64-byte
report, and the firmware leaves stale scratch bytes past the meaningful
fields — including, at times, a leftover USB string descriptor — so a reply
must be read only up to the length its schema defines.

**Replies are not ready immediately.** Commands that cross the RF link answer
empty at first; M HUB re-queues exactly `0x67` and `0x63` with a growing
timeout. Poll until the same bytes come back twice before believing them — a
single read routinely catches the buffer half-written.

## Commands

Only entries that carry an `order` string in M HUB's table are pollable
commands. The rest (`0x02`, `0x0a`, `0x0b`, `0x2b`, `0x40`–`0x43`, `0x58`) have
a parser but no order: they decode **unsolicited** reports, and polling them
returns nothing.

| Report | Command | Payload |
| --- | --- | --- |
| `0x11` | `0x03` | `bonded` u8, `vid` u16, `pid` u16, `connected` u8, `gameMode` u8 |
| `0x11` | `0x04` | length-prefixed ASCII firmware version |
| `0x11` | `0x06` | `vid` u16, `pid` u16, `fwVersion` u32, flags (3 bits mode, 1 bit status), `batteryLevel` u8, `chargeStatus` u8 |
| `0x12` | `0x67` | the configuration blob, below |
| `0x12` | `0x68 <n>` | profile name: index + NUL-terminated ASCII |
| `0x11` | `0x58 <n>` | **write:** switch the active profile (0-based) |
| `0x11` | `0x0a <enabled> <minutes>` | **write:** auto-sleep timer |
| `0x11` | `0x42 …` | **write:** lift-off, processing toggles, performance mode, angle tuning |
| `0x12` | `0x57 …` | **write:** the configuration blob, below |
| `0x12` | `0x52 …` | **write:** reassign one button, see below |
| `0x12` | `0x63 <n>` | button name: index, length, ASCII — a macro's name lives here |
| `0x12` | `0x65 …`, `0x55 …` | paged macro data, not decoded here |

**Macros are readable but not writable here.** A button set to type 4 keeps its
assignment untouched, and its name is read with `0x12 0x63 <index>` (reply:
index, length, ASCII) so it shows as `Macro: <name>` rather than a bare
"Macro". Recording one needs the paged `0x12 0x65` / `0x12 0x55` data channel,
which is not implemented. The mouse's own lighting
commands go unused because this model has no LEDs — its RGB is on the charging
base, which is a separate device with a separate protocol (see the MagDock
section at the end).

## Button remapping

**Write:** `0x12 0x52` → `[command, buttonIndex, reserved, buttonType,
value(u24, big-endian)]`. It is standalone — verified on hardware that it moves
only the target button's four bytes and leaves DPI, polling and the other
buttons alone.

**Read:** the same assignments are mirrored in the config blob at offsets 20-43,
six four-byte entries of `[(buttonIndex << 4) | buttonType, value(u24 BE)]`.

Physical order is **left, middle, right, forward, back, DPI** — note this is not
the order used by the other MCHOSE protocol family, which puts right at index 1.

The type nibble selects which table the value is looked up in, so **type and
value only mean anything together**: `0x010000` is left-click under type 1, "DPI
switch" under type 5, and "switch to profile 1" under type 10.

| Type | Meaning | Examples |
| --- | --- | --- |
| 0 | factory default | value must be 0 — the firmware's own reset |
| 1 | mouse button | left `0x010000`, right `0x020000`, middle `0x040000`, forward `0x100000`, back `0x080000`, wheel up `0x000200`, wheel down `0x00fe00` |
| 2 | keyboard | HID usage in the middle byte: F9 `0x004200`, A `0x000400`. The top byte is a modifier mask — Ctrl `0x01`, Shift `0x02`, Alt `0x04`, Win `0x08`, so Ctrl+C is `0x010600` and Alt+Tab `0x042b00` |
| 3 | media | play/pause `0xcd0000`, next `0xb50000`, volume+ `0xe90000`, mute `0xe20000` |
| 4 | macro | value indexes the stored macro |
| 5 | DPI | switch `0x010000`, + `0x020000`, - `0x030000` |
| 8 | system | copy `0x070106`, cut `0x07011b`, paste `0x070119`, brightness `0x0c6f00` |
| 9 | disabled | `0xffffff` |
| 10 | profile | profile 1-3 `0x010000`-`0x030000`, cycle `0x040000` |

Type 7 exists in the vendor bundle but its table is empty.

Verified on an A7 V2 Ultra+ by remapping the forward button through a mouse
action, a media action and a keyboard key, then restoring — each read back
correctly and the rest of the config stayed byte-identical. **Only ever test on
a button you can spare**; index 0 is the left click.

Worth knowing when reading a stock device: on the test hardware, forward and
back were **not** on defaults — they shipped mapped to keyboard F9 and F10
(type 2), while left, middle, right and DPI were type 0.

`0x06` reports **the mouse's own product id**, even when the host is talking to
a receiver. That is how a model is identified — see below.

### `0x12 0x67` configuration

| Offset | Field |
| --- | --- |
| 0 | profile index |
| 1 | **wired** link: high nibble = polling index, low nibble = DPI stage |
| 2 | **wireless** link: high nibble = polling index, low nibble = DPI stage |
| 3 | reserved — **the stage table does not start here** |
| 4 … 15 | six DPI stages, little-endian uint16 each |
| 16 | stage count |
| 17 | sensor flags |
| 18 | key debounce |
| 19 | sleep |

Polling is a plain index into the model's rate list
(`[125, 500, 1000, 2000, 4000, 8000]` on an 8K model) with no skipped value.

Captured from the Ultra+ on its receiver while set to 1000 Hz and 1600 DPI:

```
00 30 20 00 40 06 20 03 40 06 80 0c 00 19 10 a4 01 80 00 00
        ^^ wireless: rate index 2 (1000 Hz), stage 0
     ^^ wired: rate index 3 (2000 Hz), stage 0
              dpi stages: 1600 800 1600 3200 6400 42000
```

> **MCHOSE ships two contradictory schemas for this payload.** Its *read*
> parser claims the wireless byte comes first with the DPI nibble high; its
> *write* schema claims the wired byte comes first with the rate nibble high.
> The write schema is the correct one, established by reading the same mouse at
> two known settings: at 125 Hz the wireless byte read `0x00`, and after
> changing to 1000 Hz it read `0x20`. Do not "fix" this to match the read
> parser.

### `0x12 0x57` — write the configuration

The write payload is **exactly the read payload with the command byte in
front**, which was confirmed by echoing a config back unchanged and observing
no change. So a setting is applied by reading `0x67`, altering only the target
field, and sending the whole thing back — which is what preserves button
mappings and macros that a zero-filled partial write would wipe.

Verified on hardware: wireless polling 1000 Hz → 500 Hz took effect and read
back, then restored.

## Profiles

The mouse holds **three onboard profiles**, 0-based on the wire, switched with
`0x11 0x58 <index>`. Each carries its own DPI stage table *and* its own pair of
per-link rate/stage bytes, so DPI and polling both change with the profile.

`0x67` takes **no profile argument** — passing one is ignored and it always
answers for whichever profile is active. Reading another profile therefore means
switching to it first, which changes the mouse's behaviour as a side effect.

The device needs roughly half a second after a switch before it answers for the
new profile; at 250 ms a read came back empty, at 600 ms all three were read
reliably. Verified on an A7 V2 Ultra+ by walking 0 → 1 → 2 and back:

```
profile 0: wired 0x30  wireless 0x30  (2000 Hz, stage 0)
profile 1: wired 0x32  wireless 0x22  (1000 Hz, stage 2)
profile 2: wired 0x32  wireless 0x22  (1000 Hz, stage 2)
```

## The shared reply buffer will bite you

Every command on this collection answers into **one buffer**, and a read issued
before the firmware has refilled it returns *the previous command's reply*. In
testing, a config read handed back a battery payload, which was then written
back as configuration — the firmware rejected it, but nothing in the transport
prevented the attempt.

Two guards are required on every read:

1. the reply's command echo must un-invert to the command that was sent, and
2. the payload must be plausible for that command (a config reply always
   carries a sane first DPI stage).

Then poll until the same bytes arrive twice. The buffer also retains unrelated
data — a USB string descriptor turned up in it more than once — so never trust
bytes past the length a command's schema defines.

## Identifying a model

Host-facing product ids are shared across the whole A7 V2 family and identify a
*link*, not a model:

| PID | Link |
| --- | --- |
| `0x100b` | 2.4 GHz receiver |
| `0x100a` | Bluetooth (capped at 1000 Hz) |
| `0x1020` | 8K receiver |

The model-specific id is the mouse's own, reported inside the `0x06` reply and
used directly when the mouse is on a cable:

| Model | Mouse PID | DPI max | LOD steps |
| --- | --- | --- | --- |
| A7 V2 Pro | `0x4018` | 26000 | 1 mm, 2 mm |
| A7 V2 Pro+ | `0x4023` | 26000 | 1 mm, 2 mm |
| A7 V2 Ultra | `0x4019` | 42000 | 0.7 mm, 1 mm, 2 mm |
| A7 V2 Ultra+ | `0x4021` | 42000 | 0.7 mm, 1 mm, 2 mm |

MCHOSE's own firmware-version table cross-checks this: the Ultra reports
`5.44.2.4` and the Ultra+ `5.46.2.4`. The test hardware reported `5.46.2.4`.

## Dead ends, so the next person can skip them

- **The `0x4d`-magic framing in the same bundle is a different *generation*.**
  The A7 V2 has no report `0x4d` and rejected every variant of it, which is
  correct — but it was first written up here as belonging to some other product
  line, and that was wrong. It is MCHOSE's newer mouse protocol, and the A7 V3
  family speaks it; see [the V3 section](#the-a7-v3-generation) below. A third
  framing in that bundle starting `0xaa` is the MagDock's, in `src/mchose/dock.ts`.
- **CompX framing does not apply.** The older MCHOSE A5/AX5 line (VID `0x2023`,
  reverse-engineered by [`Klegus/mchose-macos`](https://github.com/Klegus/mchose-macos)
  from MCHOSE's `DriverCore.exe`) speaks CompX over usage page `0xffff` with
  success byte `0xa1` — the framing already in `src/compx/codec.ts`. Different
  VID, usage page and transport; CompX reads sent to an A7 V2 got nothing.
- **`node-hid` cannot use the output reports**, and the boot-mouse collection
  answers no feature report at any id. Neither is a missing-permission problem;
  no MCHOSE process needs to be running.
- **The mouse hub at `https://www.mchose.com.cn:9999/`** is where MCHOSE's mouse
  UI lives, but it was unreachable during this work (port 443 on the same host
  serves fine). Everything above came from the port-443 bundle, which carries
  the mouse command table even though its UI targets keyboards and audio.

## Sleep, debounce, and what this mouse does not have

**Auto-sleep** has its own command, `0x11 0x0a` — `[enabled, minutes]` — and
lands at **offset 19** of the config blob. Confirmed by writing `0x0a 01 09` and
watching that byte go `0 -> 9`. It is applied slowly: at a 400 ms settle the
write appeared to do nothing at all, and 1500 ms was needed before the new value
read back. Zero minutes disables the timer.

**Debounce** has no dedicated command; it rides in the config blob at **offset
18** and is written with the ordinary `0x57` read-modify-write. Confirmed by
writing 8 ms and then 4 ms — each read back, and byte 18 was the only byte that
moved. The firmware takes 0-20 ms.

Between them these two pin the tail of the blob: with offset 19 proven to be
sleep, the schema's `dpiSum` / `sensor` / `keyDebounce` / `sleep` run of bytes
16-19 is correctly aligned, even though `sensor` reads `0x80` where the vendor's
defaults suggest `2`.

**`0x11 0x42` is the performance command** — `lod`, `ripple`, `line`,
`motionSync`, `gameMode`, `rotateOpen`, `rotateVal`. The vendor sends partial
objects (just `lod`, say); anything omitted arrives as 0, and the toggles use
1 = on / 2 = off, so 0 reads as "leave this field alone". Lift-off is the
exception — index 0 is a real level, and the vendor always sends it.

It has no entry in the read map, but **everything it sets is still readable**:
the config blob's `sensor` byte (offset 17) is a bitfield holding lift-off *and*
the three processing toggles. Mapped bit by bit on hardware by switching each on
in turn:

| Bit | Mask | Field |
| --- | --- | --- |
| 0-1 | `0x03` | lift-off step |
| 2 | `0x04` | ripple control |
| 3 | `0x08` | linear correction (angle snapping) |
| 4 | `0x10` | motion sync |
| 5 | `0x20` | unexplained; always clear on the test hardware |
| 6-7 | `0xc0` | **performance mode**, three-way — see below |

```
0x80 -> 0x90  motion sync on
0x90 -> 0x94  ripple on
0x94 -> 0x9c  linear correction on
```

> **Lift-off is two bits, not three.** An early version of this driver masked
> `0x07`, which reads ripple control as part of the level — a mouse with ripple
> on and lift-off 0 reports level 4. Bits 5-6 are unexplained and bit 7 is
> always set, so a writer must preserve the rest of the byte rather than assign
> it.

### Performance mode — field 7, and bits 6-7 of `sensor`

M HUB presents this as **three radio buttons**, not a switch. Field 7 takes the
mode number and the result lands in the top two bits of `sensor`:

| Field 7 | `sensor` bits 6-7 | M HUB label |
| --- | --- | --- |
| 1 | `00` | Performance |
| 2 | `10` | eSports |
| 3 | `11` | Ultra |

Note the gap — the stored pattern equals the mode number except for
Performance, which stores `0`. Field 7 = `0` leaves the mode alone.

> **This was first read as a boolean "game mode" on bit 7 alone**, because the
> vendor bundle's other product line uses a checkbox there with `checked ? 2 : 1`.
> That reading is wrong for the A7 V2: bit 6 is the other half of the field, and
> what looked like "off" is really the Performance mode. A screenshot of M HUB's
> own Rendimiento tab is what exposed it.

**Angle tuning** is field 9 (`rotateVal`), gated by field 8 (`rotateOpen`):
send `rotateOpen = 1` to apply a value, `0` to leave the angle as it is. It
reads back from the config blob at **offset 49**.

M HUB offers **−30° to +30°** and the byte is a plain two's-complement signed
value (−15 stores `0xf1`). The firmware does **not** validate it — it stored
`0xf1` and `0x8f` unchanged — so the range has to be enforced by the driver.
M HUB also flags this control with "update the mouse firmware", so older
firmware may ignore it.

This command is the **slowest to apply** of any on the device. At a 1200 ms
settle a read still returned the *previous* state — which looks exactly like the
write being rejected. Allow ~2 s and re-send until the value follows; the driver
retries three times. Verified on an A7 V2 Ultra+ that each toggle round-trips
independently, that changing a toggle leaves lift-off alone (and vice versa),
and that game mode and angle tuning both round-trip and restore.

Step counts are per model: the Ultra and Ultra+ offer 0.7 mm, 1 mm and 2 mm
(Low/Medium/High); the Pro and Pro+ only 1 mm and 2 mm (Low/High).

**The A7 V2 Ultra+ has no controllable lighting.** The lighting read
(`0x11 0x1b`, and the `0x11 0x2b` / `0x12 0x2d` write schemas alongside it) is
present in the protocol for other MCHOSE models, but on this mouse the whole
15-byte block reads back as zeros — enable, brightness, effect, both colours.
Do not add lighting controls for it.

## DPI stage count and profile names

**Stage count** is `dpiSum` at config offset 16 and is written through the
ordinary `0x57` read-modify-write. Confirmed: writing 4 read back as 4, only
that byte moved, and a performance write in between did not disturb it. The
test hardware reported `1` as its stored value even with six stage slots
populated, so treat it as "how many the mouse cycles", not "how many are filled".

**Profile names** come from `0x12 0x68 <index>` — the reply is the profile index
followed by NUL-terminated ASCII. The test hardware answered `Config 1`,
`Config 2`, `Config 3`. This is the same `0x68` listed with no parser in M HUB's
read table, which is why it looked unused.

## What this mouse cannot do

- **The mouse itself has no controllable lighting.** Its lighting block
  (`0x11 0x1b`, with the `0x11 0x2b` / `0x12 0x2d` write schemas) reads back all
  zeros on an A7 V2 Ultra+. The RGB in this product family is on the **charging
  base**, which is a separate device — see below. Do not conclude "no lighting"
  from the mouse's own channel, as was done here at first.
- **Independent Y-axis DPI is not writable.** The config blob carries a second
  stage table (`dpiVal0-5`, offsets 51-62) that mirrors the X values, but
  writing a different Y value through `0x57` is silently ignored — the payload
  comes back unchanged. Whatever gates it is not the `val` byte at offset 50,
  which also refuses writes. Treat Y DPI as read-only and equal to X.
- **Macros** (`0x12 0x65`, and button type 4) are readable enough to preserve —
  a button already carrying a macro decodes as "Macro" rather than being
  clobbered — but recording one is not implemented.

## The MagDock — a second device, a second protocol

The magnetic charging base (`MCHOSE MagDock`, product id **`0x1012`**, usage
page **`0xff00`**) is where this family's RGB actually lives. It is a WCH
controller, not the mouse's RealTek, and shares nothing with the mouse protocol:
frames are **not inverted**, and they go on **unnumbered output report 0**.

```
[0] 0xaa start   [1] cmd   [2] cmdType (0 request, 2 response)
[3] frameSeq     [4] totalFrame        [5] paramLen        [6…] params
```

Replies use the same layout, so a reply's payload begins at offset 6.

| Command | Purpose |
| --- | --- |
| `7` | read the lighting block |
| `39` | write the lighting block |
| `42`, `43` | unidentified |
| `116`, `117` | firmware update (CRC8 poly 0x8c, 56-byte chunks) |

### Lighting block

Read payload, and the ten parameters command `39` takes back in the same order:

| Offset | Field |
| --- | --- |
| 0 | on/off |
| 1 | effect |
| 2 | effect count (echo it back) |
| 3 | speed, 0-4 |
| 4 | brightness, 0-4 |
| 5 | music sync |
| 6-8 | base colour R, G, B |
| 9 | direction |
| 29 | direction, as reported |

Effects, from MCHOSE's own enum: `0` static, `1` breathing, `2` shining,
`3` colour cycling, `4` flow, `5` music.

**There is no partial write** — command `39` takes the whole block, so a caller
changing one field must send the rest as they were, including `effectCount`.

Captured from a real MagDock, on colour cycling at brightness 2 with a red base
colour:

```
aa 07 02 00 00 1e  01 03 06 02 02 00 ff 00 00 00 00 …
                   ^on ^cycling ^count ^speed ^bright ^sync ^rgb(255,0,0)
```

Verified by echoing the block back (a no-op), then changing brightness and
setting a static green, then restoring — every step read back and the block
returned byte-identical.

## Both links, confirmed

The driver was exercised on an A7 V2 Ultra+ over **both** connections.

| | 2.4 GHz receiver | USB cable |
| --- | --- | --- |
| Host-facing product id | `0x100b` (shared) | `0x4021` (model-specific) |
| Live half of the byte pair | wireless (offset 2) | wired (offset 1) |
| `chargeStatus` | `0` | `1` while charging |

Which half is live follows from the product id: over a cable the host talks to
the mouse itself, so the id is a model id; every other link enumerates under a
shared receiver id. Confirmed by writing a polling change over the cable and
watching **only** the wired byte move.

With the mouse on its cable the receiver stays enumerated but has nothing behind
it, so its config read simply fails — a driver must degrade rather than treat
that as an error.

## The A7 V3 generation

Everything above is the **A7 V2** protocol. MCHOSE's newer mice — the A7 V3
family and its siblings — use a second, unrelated protocol on the *same vendor
id and the same usage page*. M HUB ships both UIs side by side, with a model
list (`W8` in the bundle) picking which one a device gets.

**The reads in this section are confirmed on hardware; the writes are not.** An
A7 V3 Ultra+ on its 2.4 GHz receiver (host PID `0x1014`/`0x1018`) answered
`0x0900`, `0x0002`, `0x0003` and `0x0001` exactly as read out of the vendor
bundle — see [what the hardware said](#what-the-hardware-said) at the end. No
byte has ever been written to a V3, which is why
`src/drivers/mchose/v3-hid.ts` only reads.

| | A7 V2 | A7 V3 |
| --- | --- | --- |
| transport | feature reports `0x11` / `0x12` | **output report `0x4d`**; replies arrive as input reports |
| encoding | every body byte XOR `0xff` | plain bytes, XOR checksum |
| command id | one byte | **two bytes, little-endian** |
| settings | one 64-byte blob (`0x67`) | several focused commands |
| collection | `0xff01` / `0x0001` | `0xff01` / `0x0001` — *the same one* |

That last row is the trap. Before the V3 landed, the V2 driver matched on the
usage page alone and would happily have opened an A7 V3 and talked inverted
feature reports at it. The two matchers are now kept apart by product id: the V3
driver takes an allowlist, the V2 driver subtracts it.

### Framing

The first byte is both the `'M'` magic and the HID report id, so
`sendReport(0x4d, body)` sends the remaining 63:

```
frame[0] = 0x4d   report id
body[0]  = 0x01   protocol version
body[1]  = flags  1 when a trailing checksum is present
body[2]  = data length
body[3]  = command low byte
body[4]  = command high byte
body[5]  = business code
body[6]  = sequence
body[7…] = data, then the checksum at body[7 + length]
```

The checksum is an XOR of `body[1]` through `body[6 + length]`. Replies use the
same layout and are paired to their request by command id — M HUB does not check
their checksum, though the codec here does when the reply claims to carry one.

### Commands

Reads are `0x00xx` and `0x09xx`; a write is its read plus `0x0100`.

| Id | Payload | Meaning |
| --- | --- | --- |
| `0x0900` | — | vid, pid, profile count, macro sizes, link state, charge state, battery, mode |
| `0x0002` | — | profile, DPI/rate indices, sleep, sensor flags, angle, debounce |
| `0x0003` | `[profile, axis]` | stage count, active stage, six uint16 stages |
| `0x0001` | `[profile, 0, 6]` | button table |
| `0x0009` | `[profile]` | lift-off index |
| `0x0901` | — | firmware version |
| `0x090c` | `[index, offset u16, 22]` | macro storage, 22 bytes per read |
| `0x0101` `0x0102` `0x0103` `0x0104` `0x0105` `0x0109` | | the matching writes, plus a single-stage DPI write and a factory reset |

`0x0900` reports **the mouse's own product id** even behind a receiver, which is
the only way to tell the models apart: `0x1014` and `0x1018` are shared by the
whole 8 kHz generation and `0x1016` by the two 1 kHz ones.

### The settings block (`0x0002` / `0x0102`)

| Offset | Field |
| --- | --- |
| 0 | profile index |
| 1 | wired: high nibble polling slot, low nibble DPI stage |
| 2 | wireless: same shape |
| 3 | sleep, in minutes |
| 4 | sleep mode (bit 0) |
| 5 | sensor flags |
| 6 | angle tuning, two's-complement signed |
| 7 | left debounce, ms |
| 8 | right debounce, ms |

Two differences from the V2 worth naming. Debounce is **per button** here, left
and right separately. And the polling nibble is *not* an index into the model's
rate list: the firmware's table has a slot M HUB never offers, so the vendor
maps `slot > 1 ? slot - 1 : slot` on the way in and `option > 0 ? option + 1 :
option` on the way out. Those are deliberately not inverses — slot 1 reads back
as option 1 but is never written — which is consistent with a hidden 250 Hz step
sitting between 125 and 500.

Unlike the V2's `0x57`, this write replaces the whole block; there is no
read-modify-write on the device side, so a caller must read, edit and send back.

### The sensor byte — **not laid out like the V2's**

| Bit | Mask | A7 V3 | A7 V2 (for contrast) |
| --- | --- | --- | --- |
| 0-1 | `0x03` | **performance mode** | lift-off step |
| 2 | `0x04` | ripple control | ripple control |
| 3 | `0x08` | linear correction | linear correction |
| 4 | `0x10` | motion sync | motion sync |
| 5-6 | `0x60` | **lift-off step** | mode / unexplained |
| 7 | `0x80` | **glass-surface mode** | always set on the test hardware |

Lift-off and the performance mode have swapped ends of the byte. Read a V3 byte
with the V2's masks and a lift-off level comes out as a power mode; there is a
test pinning exactly that.

Two bits only reach four lift-off steps, and five models ship a five-step ladder
(0.7 / 0.9 / 1.2 / 1.4 / 1.7 mm). Those keep lift-off behind `0x0009` instead —
`liftOffCommand` in the product table marks them, and a test asserts the flag
matches the ladder length rather than being maintained by hand.

### Models

From the bundle's own table. Every one of these shares the wire format; the A7
V3 family is what the driver was written for and the rest are included so a
shared receiver resolves to the right ceiling instead of the wrong one.

| Model | PID | DPI max | Lift-off |
| --- | --- | --- | --- |
| A5 V3 Pro | `0x4035` | 26 000 | 1 / 2 mm |
| A5 V3 Ultra+ | `0x4026` | 42 000 | 0.7 / 1 / 2 mm |
| A5 V3 Ultra+ (3955) | `0x4034` | 50 000 | five steps |
| K7 V2 Pro+ | `0x4027` | 42 000 | 0.7 / 1 / 2 mm |
| K7 V2 Ultra+ | `0x4028` | 50 000 | five steps |
| A7 V3 | `0x4030` | 26 000 | 1 / 2 mm |
| A7 V3 Pro | `0x4031` | 42 000 | 0.7 / 1 / 2 mm |
| A7 V3 Pro+ | `0x4032` | 42 000 | 0.7 / 1 / 2 mm |
| **A7 V3 Ultra+** | `0x4033` | 50 000 | five steps |
| K5 Pro | `0x4037` | 26 000 | 1 / 2 mm |
| K5 Ultra | `0x4038` | 50 000 | five steps |
| R7 Ultra | `0x4036` | 50 000 | five steps |
| V7 | `0x402a` | 26 000 | 1 / 2 mm, 1 kHz |
| G3 V3 | `0x4029` | 12 000 | 1 / 2 mm, 1 kHz |

The bundle's per-model `dpiMagicNum` and `dpiSlider` tables are UI slider
geometry, not wire encoding — DPI goes out as a plain little-endian uint16.

### What is left for someone with the hardware

The reads are the whole driver today. To turn it into a full one:

1. Confirm the frame is accepted at all — `0x0900` is the cheapest probe, and
   its reply carries a known vendor id to check against.
2. Confirm the reply arrives on the input report rather than as a feature read.
3. Time the writes. The V2 needed 400 ms to 2 s per command and three attempts
   for its slowest; nothing here has been timed.
4. Then the encoders in `src/mchose/v3.ts` can be wired to setters. Start with a
   value that is trivially reversible, verify by reading it back, and restore
   the entry state — the same order the V2 work used.

Do not skip step 3. The V2's stale-reply buffer meant a read taken too early
returned a *different command's* payload, and one of those nearly went back out
as a config write.

### What the hardware said

An **A7 V3 Ultra+** behind its receiver (host PID `0x1018`), from an OpenMouse
diagnostic export dated 2026-09-12. Data blocks only; the framing is stripped.

```
OUT 0x0900                 -> 37 38 26 40 04 00 00 00 00 10 02 01 55 00 08 e4
OUT 0x0002                 -> 00 41 41 03 00 41 00 08 08 08 08 …
OUT 0x0003 [00]            -> 00 00 06 01 00 90 01 20 03 40 06 80 0c 00 19 50 c3
OUT 0x0001 [00 00 06]      -> 00 01 00 00 02 00 00 04 00 00 10 00 00 08 00 ff ff ff
OUT 0x0901                 -> (empty)
```

Everything decoded correctly: battery 85 % and charging, four profiles, DPI
stages 400/800/1600/3200/6400/**50000** with the second active, 2000 Hz, a
three-minute sleep timer, 8 ms on both debounce bytes, sensor `0x41` (eSports,
every processing toggle off), and six stock button assignments.

Two things the capture corrected.

> **`0x0900`'s product id is not a model id.** This mouse's USB product string
> is `MCHOSE A7 V3 Ultra+`, and it reports `0x4026` — the id MCHOSE's own table
> gives the *A5 V3 Ultra+*. Believing it named the wrong mouse and, through it,
> handed out a 42,000 DPI ceiling and a three-step lift-off ladder to a 50,000
> DPI five-step model. `mchoseV3FindProduct` now prefers the product string and
> keeps the id only as a fallback. M HUB agrees: every model lookup in the
> vendor bundle keys off `navigator.device.productName`, never off this field.
>
> This is the opposite of the A7 V2's rule, where the id inside the battery
> reply *is* decisive. Do not carry one habit across to the other generation.

> **`0x0901` needs a target byte** — 0 for the mouse, 1 for the receiver. Sent
> bare it answers with an empty data block rather than an error, which is why
> the first capture shows no firmware version at all.

Also worth recording: the `0xff01` collection on this receiver declares `0x4d`
as an **input, output *and* feature** report. The driver uses output plus input
and that works; the feature path is untried.

The lift-off command `0x0009` still has not been exercised. The capture was
taken while the driver believed it was talking to a three-step model, so it
read lift-off from the sensor byte and never sent `0x0009`. With the model
resolved correctly the Ultra+ now takes that branch, and a device that does not
answer it degrades to a blank lift-off rather than a wrong one.

### Writing

Every V3 write **replaces a whole block**. There is no partial update and no
read-modify-write on the device side, so a caller reads the block, edits the
decoded structure and sends the whole thing back. That is why the encoders take
a structure rather than a set of changes, and why a failed read has to abort the
write instead of falling back to defaults.

| Command | Data |
| --- | --- |
| `0x0102` | the `0x0002` settings block, same layout |
| `0x0103` | `[profile, axis, hasY, count, activeStage, six uint16 stages]` |
| `0x0104` | `[profile, stage, axis, dpi uint16]` — one stage, no table rewrite |
| `0x0109` | `[profile, liftOffIndex]` |
| `0x0101` | `[profile, 0, buttonCount]` then the variable-width button entries |

> **The DPI write and read do not order their fields the same way.** The write
> puts `hasSeparateY` third and the read puts it fifth. Copying a decoded table
> straight into a write buffer silently swaps the stage count with it.

**The settings block's tail is not padding.** M HUB writes ten zero bytes past
the nine named fields, but a real A7 V3 Ultra+ *returns* ten bytes of `0x08`
there — the same value as both its debounce fields, so most likely the debounce
for the remaining buttons. Writing the vendor's zeros would quietly set them all
to nothing on every unrelated write, so those bytes are carried through from the
read instead.

**The sensor byte must be masked, not assigned.** The A7 V2's bit 5 was never
explained; a writer that assigns the byte destroys whatever a field it does not
know about was holding.

**None of these writes has been sent to a real device.** The framing under them
is proven — the mouse answers frames built by the same encoder — but the
firmware's response to each write is not. Two numbers are the likely first
suspects if something misbehaves:

- the settle delay before the read-back, currently the A7 V2's 400 ms;
- whether a write needs a separate save or commit command at all. Nothing in the
  vendor bundle suggests one, but nothing rules it out either.

### The button vocabulary

Taken from M HUB's own action tables, not guessed at. The vendor stores each
action as a hex string whose first byte is the type and whose rest is the
value: `"0x13042b"` is Alt+Tab, type `0x13`, modifier `0x04`, usage `0x2b`.

**These type numbers are not the A7 V2's.** Nothing carries over.

| Type | Value bytes | Order | Meaning |
| --- | --- | --- | --- |
| `0x00` | 2 | LE | mouse button — left `0001`, right `0002`, middle `0004`, forward `0010`, back `0008` |
| `0x01` | 3 | LE | DPI — switch `000000`, + `000002`, − `000003` |
| `0x05` | 2 | LE | wheel — up `0000`, down `0001` |
| `0x11` | 2 | LE | keyboard key, value is `00` + HID usage |
| `0x13` | 2 | **BE** | modifier + key, value is the modifier mask + usage |
| `0x14` | 2 | LE | consumer control: media keys and screen brightness |
| `0x16` | 2 | **BE** | system shortcut — copy `0106`, cut `011b`, paste `0119` |
| `0x22` | 3 | LE | present in the width table, no entries in the vendor's lists |
| `0x23` `0x24` | 7 | LE | likewise, and wide enough to be macro references |
| `0x33` | 2 | LE | onboard profile — 1/2/3 `0000`/`0001`/`0002`, cycle `00ff` |
| `0xfe` | 2 | LE | disabled, the vendor's "forbidden" |
| `0xff` | 2 | — | **no assignment at all.** The firmware reports it, M HUB never writes it |

> **`0xfe` and `0xff` are not the same thing.** A disabled button is `0xfe`;
> `0xff` is a button carrying nothing, which is what a stock A7 V3 Ultra+
> reports for its DPI button. Writing `0xff` would send a value the firmware
> itself never sends.

The letters, function keys and navigation keys are **derived** rather than
listed: the vendor's table covers punctuation, digits, the numpad, the locks
and the modifiers, and leaves the rest to its on-screen keyboard. Its own
shortcut entries spell out the same standard HID usages under the same type
(Ctrl+A is `0x04`, Ctrl+C `0x06`, Alt+F4 `0x3d`, Esc `0x29`), so the usage
page is confirmed rather than assumed.

Macros are still not writable: types `0x23`/`0x24` are wide enough to carry a
reference, but the vendor's tables list nothing under them and the paged
`0x090c` macro channel is not implemented.
