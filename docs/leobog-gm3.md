# LEOBOG GM3 battery telemetry

Supported identifiers:

- wired: `258a:0136`
- 2.4 GHz receiver: `258a:0138`

Both identifiers and product names come from the official
`LEOBOG Gm3 3.14Setup v2.0 20250313` package. Its
`Dev/ms/3311-2/MS.ini` contains:

```ini
Name=LEOBOG Gm3
VID=0x258A
PID=0x0136
VID_Wireless=0x258A
PID_Wireless=0x0138
ShowPower=1
```

## Battery query

The configuration collection is `0xFF02:0x0002`. The vendor application's
`CDevG5MS` power path uses feature report 9 and the command pair `09 09`.
Frames are 520 bytes including the report id. The checksum at byte 1 is the
low byte of the sum of every byte from index 2 on.

Request prefix:

```text
09 0C 09 01 01 00 01 00
```

Hardware response from the `258a:0138` receiver:

```text
09 0C 09 01 01 00 01 00 64 00 00 00 00 00 00 00
```

`byte[8] = 0x64` is 100 percent. This read was exercised on the receiver with
the native Windows HID path. The wired `258a:0136` path shares the vendor
definition, but has not been connected for verification yet.

## Frame layout

Every 520-byte request shares one header, read from the vendor binary's
`CDevG5MS` frame builders and confirmed against live traffic:

```text
byte 0     report id, always 0x09
byte 1     checksum = sum(bytes[2..519]) & 0xFF
byte 2     command
byte 3     sub-command
byte 4     0x01 (request flag)
byte 5     0x00
byte 6-7   little-endian payload length = how many bytes the device returns
byte 8..   payload
```

The reply echoes bytes 2-7 and places its data at byte 8. Asking for a length
the device cannot serve fails with a HID timeout (`ERROR_SEM_TIMEOUT`, 121)
rather than returning a short frame.

## Link query

`07 00` is `CDevG5MS::GetOnline`. Byte 8 of the answer is `0x01` while the
mouse is answering the receiver and `0x00` once the mouse has gone to sleep.
The 2.4 GHz receiver keeps answering the battery query from its last reading
in that state, so the driver reads the link flag first and tells the user when
the percentage is stale. The vendor application shows its "please connect your
device" page for the same reason; the answer frame is
`09 09 07 00 01 00 01 00 01`, whose checksum byte is itself `0x09`, so both
report-id alignments have to be tried when decoding it.

## Capturing the vendor protocol

The vendor application reads its own settings from a local profile cache
(`%LOCALAPPDATA%\BYCOMBO4\LEOBOG Gm3\profile.dct`), so its HID traffic is the
only trustworthy source for the remaining commands. `HID.DLL` is resolved from
`System32` before the application directory on this machine, so a proxy
`hid.dll` next to `OemDrv.exe` is never loaded. A Frida session that spawns the
application suspended and hooks `HidD_SetFeature`/`HidD_GetFeature` in the
loaded `HID.DLL` does capture it.

One startup session captured, in order:

```text
07 00 len 1     online flag -> 01
05 01 len 6     key/password block -> 04 00 00 00 00 22 00
44 00 len 400   onboard profile blob -> 512 bytes of device data
09 01 len 1     battery -> 5B (91%)
0B 00 len 14    clock write -> 10 00 00 EA 07 0A 18 0D 34 1B 06 09 30 98
```

The `0B 00` write carries the host clock as
`year(little endian) month day hour minute second weekday` (`EA 07 0A 18 0D 34
1B 06` = 2026-10-24 13:52:27 Saturday). The `44 00` reply holds 26-byte
records introduced by `44 01`; no DPI, polling or debounce value was found in
it, so its fields are not decoded yet.

## Scope

The driver covers the battery, the wake/link flag and the onboard
configuration block: DPI stages and their values, the active stage, the stage
count, the polling rate and the button debounce. Lighting, sleep, button
remapping and macros belong to the same block or to neighbouring commands, but
their fields have not been located, so the driver leaves them alone.

## Firmware version

The vendor application shows 固件版本 `V2.1.3 (2.4G)` on its device-info page,
formatted with `"%s     V%X.%X.%X    ( %s )"` from a single 32-bit field it
calls `m_nVer` (`Update by user click: pHidDev->m_nVer=%x, ...`).

The mouse never sends it over the vendor protocol. Checked on hardware and in
captures:

- the 400-byte configuration block carries no version bytes — a live read was
  searched for `02 01 03`, `03 01 02`, `02 13`, ASCII and UTF-16 `2.1.3`;
- the startup sequence is exactly block read, battery query and clock sync
  (`0B 00`), and the 更新 button's "already the latest" prompt issues **no**
  HID traffic at all;
- command `0x05` (every sub-command) answers `04 00 00 00 00 22`, and `0x44`
  ignores its sub-command and always returns the same block;
- the version is in no file the application ships or writes, the registry, or
  the USB strings ("Gaming MS").

It is the USB device revision. Every hardware ID of the receiver carries
`REV_0213`, which is `V2.1.3` in the app's `%X.%X.%X` reading, and the
application reads it with `HidD_GetAttributes` (`HID_ATTRIBUTES.VersionNumber`)
— a standard Windows HID call, which is why no vendor command ever carries it.
`MS.ini`'s `FwVerNeedToUpdate=0x206` (2.0.6) is the static threshold below
which the app prompts for an update.

Consequence for OpenMouse: a browser page cannot read it — WebHID's `HIDDevice`
exposes only vendor id, product id, product name and collections, and Chrome
blocks WebUSB for HID-class devices. A native companion (the Bridge or the
desktop app) can read `HID_ATTRIBUTES.VersionNumber` and report it.

## Onboard configuration block

`44 00` reads the block and `04 00` writes it back; both carry 400 payload
bytes and a request length of 0x190. Every field below was located on hardware
by changing exactly one control in the vendor UI, saving, and diffing the
block that came back from `44 00`:

| offset | meaning |
| --- | --- |
| 0 | `0x64` — DPI floor, 100 |
| 1 | `0x18` — DPI ceiling / 1000, 24 |
| 2 | polling-rate index: 1 = 125 Hz, 2 = 250, 3 = 500, 4 = 1000 |
| 3 | high nibble active stage + 1, low nibble stage count |
| 5 | debounce index: 1 = 2 ms … 6 = 12 ms |
| 7 | six little-endian DPI values, `dpi / 100 - 1` |
| 27 | the same six values again |
| 43 | 26-byte `44 01` records, not decoded |
| 74 | auto-sleep idle minutes, `0` disables it |
| 76 | battery percentage the block also reports |

Evidence for each field, all from the `258a:0138` receiver:

```text
polling   1000 Hz -> byte 2 = 0x04    500 Hz -> 0x03   (both directions)
active    800 -> byte 3 = 0x16        1600 -> 0x36     1000 -> 0x26
count     6 -> low nibble 6           5 -> 5, trailing entries zeroed
debounce  2 ms -> byte 5 = 0x01       12 ms -> 0x06
dpi       stage 2 1600 -> 0x0F        dragged to 8700 -> 0x56
sleep     5 min -> 0x05               20 min -> 0x14    off -> 0x00
```

`0x56` is 86, and `(86 + 1) * 100 = 8700`, so a stage stores `dpi / 100 - 1`.
The 12000 stage reads as 119 (`0x77`) and the factory 800 as 7.

### Wired path (`258a:0136`, verified 2026-10-25)

Plugging the cable in drops the receiver and enumerates the same protocol on
`258a:0136` with the same `0xFF02:0x0002` / 520-byte feature collection, and
the block is laid out identically — same polling byte, stage/count nibble,
debounce byte, DPI tables, sleep byte and battery byte.

Two differences were measured on hardware:

- `07 00` (link) and `09 01` (battery) are **receiver-only**: over the cable
  they are answered with `ERROR_GEN_FAILURE` or a stale buffer. The block's
  battery byte is the receiver's last cached value, not a cable measurement:
  on 2026-10-26 it stayed at 91% while the live receiver query reported 100%.
  The driver therefore reports no battery over the cable instead of showing
  that stale cache as a real level.
- A write that follows the block read reply with no gap is accepted and then
  **ignored** over the cable, while the same sequence works over the receiver.
  The vendor app leaves ~60 ms between the read reply and the write frame; the
  driver waits 80 ms and the write applies (verified 1000→500→1000 Hz and a
  DPI stage edit with read-back).

Unknown field, noted for a later pass: the cable path's `44 00` reply continues
past offset 255 with a second copy of the block, where the receiver's reply is
zero-padded. Only offsets below 0x4D are decoded today, so this does not
affect the driver.

### Status refresh

OpenMouse polls the GM3 every second so a DPI-stage change made with the
mouse's own button appears in the interface promptly. The successful
configuration block is cached for 500 ms, which is shorter than one poll, so
each poll normally performs a fresh read while two reads cannot overlap.

The cable path skips the receiver-only link and battery commands. They do not
answer over the cable and used to add an avoidable timeout to every status
refresh. It also ignores the battery byte in the configuration block and
leaves the battery field unset, so the wired page does not present the
receiver's cached percentage.

Over the receiver, OpenMouse reads the configuration block first and then
queries `09 01` for the live battery level. The block's battery byte can lag
behind the mouse: on 2026-10-26 both copies of the receiver's block still
read 91% while repeated `09 01` queries returned 100%, and the vendor app's
live value was 100%. The live answer is therefore preferred, and the
configuration block's percentage is only the fallback if the query fails.
Repeating the query on every status poll is what makes a discharge visible
in the interface.

The captured `09 01` reply has no charging bit: every byte after the percentage
is zero. The GM3's two transports still determine the state unambiguously, so
OpenMouse reports 2.4 GHz as `Discharging` and USB as `Charging`. The cable
path does not publish a live percentage, so its battery level remains hidden.

The GM3's feature-report buffer can temporarily contain the previous
command's answer. For example, a `44 00` configuration request may first
return the `09 01` battery answer. The driver rejects that mismatched reply
and repeats the request, up to three attempts within the same budget. Only a
matching reply is decoded.

The wired path needs a longer budget than the receiver: a native Windows HID
capture measured a valid `44 00` reply taking about 2.1 seconds, while the
receiver can time out quickly when the mouse is asleep. The driver therefore
allows 2.5 seconds on the cable and 600 ms over the receiver. A failed wired
read reopens the HID handle to cancel the outstanding receive and retries
after a one-second backoff, so the next poll cannot be held up by the old
request or remain stuck for the earlier 15-second backoff.

### A poll gets out of the way of a click

Every driver operation runs through one queue, so a setting the user changes
waits for the poll that is already in flight. Measured against a receiver that
answers in 120 ms, a poll spends 340-510 ms of each second on its link, block and
battery queries. A click that arrived 20 ms into such a poll therefore used to
wait out the rest of it before the mouse heard from the page at all.

The poll now checks the queue around each step. When a write is already waiting,
it skips the battery query entirely (the block's cached level stands in) and
stops retrying the block read, so the same click sends its first frame about
150 ms after the click instead of after the whole poll. The next poll collects
whatever was skipped; nothing about the values the interface shows changes.

### A poll cannot cancel a receive, so it backs off instead

WebHID exposes no cancel for a feature report. When a poll's deadline race
loses, the receive stays outstanding on the handle until the browser gives up
on it, and polling again immediately stacks a second wait on top of the first.
With three steps per poll that compounding reached past the page: the browser
itself stuttered, and switching tabs took seconds, each time the 2.4 GHz link
went quiet.

Two changes remove it. The three battery attempts now share one 600 ms budget,
where each of them used to get a fresh one, so a silent receiver costs one
budget instead of 1.8 s. And a poll that abandoned a receive leaves the device
alone for the next two seconds, replaying its last answer meanwhile, so the
outstanding receive has time to land before anything else is asked of the
handle. Measured against a receiver that stops answering: one quiet power query
now costs the poll 795 ms total instead of 1.8 s on that step alone, and the
following poll sends nothing at all.

### Pace the poll by what the device actually did

Measured on a cable, in the page itself, over 25 s: 23 polls, one feature-report
receive per poll, 408-byte replies, and **one** of those replies took 2 096 ms
while the other twenty-two took 50-60 ms. Over the same window the page ran at
59.9 fps with a worst frame gap of 35 ms and no long task above 319 ms, so the
2 s stall was never the renderer — it was the page waiting on the device, with
the browser waiting on the same transfer. Any poll that hits that wall and then
has another one queued straight behind it keeps the whole browser stuttering.

So a poll that took longer than 500 ms, whether it gave up on a receive or
waited out a legitimately slow reply, now leaves the device alone for four
seconds and replays its last answer until then. A fast device keeps its
two-second cadence and the DPI-stage display stays live; a device in one of its
slow spells gets asked once, then given room.

Two further limits follow from the same measurement. A poll waits at most 600 ms
for the configuration block on either transport — the one reply in 23 that took
2.1 s is beyond a page's business — while a write keeps the full 2.5 s budget,
because a write has to see the block it modifies and read it back. And the poll
interval moved from one second to two: a slow reply stalls the browser and not
only the page, so the number of asks matters more than the gap between them. A
DPI stage changed by the mouse's own button still shows within two seconds.

### Writing

A write is a read-modify-write of the whole block: read `44 00`, change the
one field, send `04 00` with the block, then read `44 00` again to confirm.
That last read is not optional bookkeeping — the driver reports an error
instead of pretending a value was accepted when the block comes back
unchanged.

The plain DPI control (the preset list and the custom-value box, which both go
through `setDpi`) writes the selected stage's value and leaves the selection
where it is, matching the vendor application's DPI slider. Values are limited
to multiples of 100 between 100 and 24000 because a stage stores
`dpi / 100 - 1`.

### Auto-sleep

The `设置 → 休眠` page drives one byte: the idle time in whole minutes, with
the off switch writing `0`. Its slider covers 1-20 minutes (samples: 1, 3, 5
and 20 at the left end, two thirds along, and the right end), and the app
leaves the value alone until the switch or slider moves — a drag that returns
to the previous position writes nothing, so OpenMouse treats the setting as a
normal read-modify-write with its own read-back.

Two things that cost time to find:

- The vendor application sends an 80-byte button table (`01 00`) before every
  save. It is **not** required: `44 00` followed by `04 00` applies the change
  on its own, so this driver never sends it. Its payload is the button
  mapping table, which OpenMouse does not manage yet — writing the captured
  copy would overwrite whatever the user bound.
- While the vendor application is running it re-applies its cached profile
  (`%LOCALAPPDATA%\BYCOMBO4\LEOBOG Gm3\profile.dct`), so writes from another
  program appear to do nothing. Close it before changing settings with
  OpenMouse. This also happened during testing: the vendor app rewrote the
  device from 3 stages / 6 ms debounce to its own cached 6 stages / 2 ms as
  soon as it connected, before any edit of ours.
