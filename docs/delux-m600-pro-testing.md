# Delux M600 Pro testing notes

PAW3395, wired and 2.4 GHz. Tested on one unit under Linux (hidraw, Python
`HIDIOCGFEATURE`/`HIDIOCSFEATURE`) on 2026-09-24. Raw material is in
`captures/delux-m600-pro/`.

## Identity

| Path | VID:PID | bcdDevice | Manufacturer / product strings |
|---|---|---|---|
| Wired | `1d57:fa71` | 1.02 | `Beken` / `USB Gaming Mouse` |
| Receiver | `1d57:fa60` | 1.08 | `Beken` / `2.4G Wireless Device` |

No string names Delux, and there is no serial string.

- **Wired:** `fa71` is not used by any other device in this catalogue or in
  the community X11 tools listed below. The Delux driver claims it by product
  ID alone (`DELUX_UNBRANDED_PRODUCT_IDS`). That claim is an inference from
  this one unit, not a vendor statement.
- **Receiver:** the USB identity is the one the Attack Shark X11 receiver
  reports, so the registry claims it through the X11-family path in
  `src/drivers/attackshark/hid.ts`. The paired mouse names itself afterwards:
  byte 1 of every receiver message (`03 <model> <event> …`) is a per-model
  id.
  - Source for that byte layout: HarukaYamamoto0/attack-shark-x11-driver,
    `docs/messages/README.md` ("This byte identifies the device model …
    the Attack Shark X11 uses `0x55`") and the `DeviceId` table in
    `src/core/devices.ts`. incconutwo/mouse-battery-tray names models the
    same way.
  - This unit sent `0x20` in all 64 captured messages. `0x20` is not in that
    table.
  - Once such a message arrives, the X11 client reports
    `Delux M600 Pro (Wireless)` with brand Delux. Until then it keeps the
    X11 name.

Other community findings match this unit's receiver:

- Its interface 2 descriptor is 236 bytes and declares the X11 *wired* report
  lengths (`0x04` 52 B, `0x05` 13 B, `0x0C` 6 B with the id). The X11 receiver
  dump shared by those repos declares 230 bytes (`docs/descritors/`).
- Its bcdDevice is 1.08, and the X11 receiver dump shows 11.08.

## USB shape

The wired unit and the receiver both expose four HID interfaces, with
matching descriptors (only reports `0x2A`/`0x2D` differ in declared length):

- IF 0: boot keyboard
- IF 1: boot mouse (buttons, X/Y int16, wheel, AC pan; no report id)
- IF 2: system control (`0x01/0x80`, report 1), consumer (`0x0C/0x01`,
  report 2), `0x0A/0x00` input report 3 (battery), and `0x0B/0x00` with
  feature reports `0x04` (51 B), `0x05`–`0x0C`, `0x10`, `0x22`–`0x2E`,
  `0xA0`
- IF 3: keyboard bitmap

Linux hidraw hands the whole IF 2 descriptor to the browser, so WebHID lists
the `0x0B` collection with its feature reports. On Windows the battery and
config channels are the `&col03` and `&col04` sub-collections, which Chrome
does not list (see [Windows](#windows)). Both drivers
enable WebHID settings only when a collection declares feature reports `0x04`
and `0x06`.

## Observed facts

- **Reads need an unlock first.** Without one, `GET_FEATURE` times out
  (`ETIMEDOUT`, about 5 s each) for every declared feature report on both
  paths, and `0xA0` answers `a0 00 00 00 00 00 00 00`. Three unlock requests
  were tried on the receiver (`captures/delux-m600-pro/receiver-timing.txt`):
  - The documented unlock `SET_FEATURE a0 [<id> <len> 00 01 00 00 00]`
    (HarukaYamamoto0/attack-shark-x11-driver `getFeatureReport`) worked once
    for polling: `GET a0` answered `a0 01 …` (unlocked), then `GET 06`
    answered `06 0b 01 01 fe …` at 1000 Hz. Byte 3 is the rate code and byte
    4 its complement.
  - The same unlock for `0x04` (`a0 04 34 …`) failed with `EPIPE`.
  - The R1 driver's request, which has no length byte (`a0 06 00 01 …`),
    answered `06 02 00 …` while the mouse was at 125 Hz, and then stalled.

  Neither driver reads feature reports from this firmware. The polling
  read-back is a lead for later work.
- **Each write is answered at once.** The receiver usually answers within
  10-20 ms with `03 20 50 00 06`: model, event `0x50` (feature report
  status), success, report id. Some writes got other, undocumented messages
  instead: `03 20 f0 ff 04`, `03 20 f0 ff 05`, `03 20 01 00 ff` and
  `03 20 09 00 fc`.
- **Polling, report `0x06`,** uses the existing X11 packet
  `[09 01 code ~code 0 0 0 0]` and works on both paths. Peak motion reports
  per second:

  | Rate sent | Measured, wired | Measured, receiver |
  |---|---|---|
  | 125 Hz | 126 | 126 |
  | 500 Hz | 502 | 500 |
  | 1000 Hz | 978 | 1002 |

- **DPI, report `0x04`,** takes the 52-byte form of `buildX11DpiReport`
  (`wired: true`: report id plus 51 bytes, the length the descriptor
  declares on both paths). All six stages were set to 400, then to 1600, with
  one same-length swipe after each. The expected ratio is 4 and the measured
  X counts gave these ratios:

  | Path | Ratio | Notes |
  |---|---|---|
  | Wired | 3.6, 3.5 | |
  | Receiver | 3.8 | Once the write applied. The first receiver write had no effect (see below). |

- **Battery:** the receiver pushes report 3 unprompted. The packets seen were
  `03 20 40 01 64` (100 %), 64 identical packets in 8.6 s. The X11 and M800
  Mini parsers expect `03 55 40 01 <pct>`, so they do not recognise it.
  Nothing arrives while the mouse is on the cable.

## Receiver in Chrome on Linux

The OpenMouse hardware test was run against `0xfa60` in Chrome on Linux
before this change (build `BETA · v2.0.965`). It showed:

- The receiver was classified as the Attack Shark **R1** family, because
  its visible feature reports matched the generic `0x1d57` rule. It reported
  DPI 0 and no battery.
- The polling round-trip wrote 125 Hz and then tried to restore "0 Hz", the
  value the R1 read-back had decoded. The driver rejected that, so the
  mouse was left at 125 Hz, confirmed by measurement.

With this change, `fa55`/`fa60` units that expose `0x04` and `0x06` stay in
the X11 family:

- Polling and DPI are writable, and nothing is read back.
- The DPI report length follows the descriptor: a declared 51 bytes gives
  the 52-byte form, and 55 gives the 56-byte form.
- The battery parser accepts the `0x20` marker.

## Receiver write spacing

Writes that follow each other closely can freeze the 2.4 GHz link. The
cursor stops until the receiver is replugged.

| Gap between two writes | Writes | Mouse | Result |
|---|---|---|---|
| ~0.4 s | `0x06` 500 Hz, then restore 1000 Hz (OpenMouse hardware test, 300 ms driver spacing) | | froze |
| 0.5 s | two identical `0x04` | still for 15 s before | froze |
| 1, 2, 3 s | `0x06` 500 Hz, then 1000 Hz | moving | applied |
| ~4 s and more | every `0x04` and `0x06` above | | applied |

The receiver's immediate answer (see above) is not a sign that it is safe to
write again: the 0.4 s freeze came well after that answer. The X11 path
therefore holds every receiver write until 1 s has passed since the previous
one. That is the shortest gap that was measured as safe. The gap is kept
per product ID across clients, and it is enforced inside the command queue.

The first `0x04` write of one session had no measurable effect, while the
next writes did. The cause is unknown.

On the wired path, all `0x04` and `0x06` writes applied. They were spaced
seconds apart, and wired writes are not paced.

## OpenMouse hardware test

Both paths pass the OpenMouse hardware test in Chrome on Linux with this
change, against a local build (`captures/delux-m600-pro/openmouse-hardware-test-*.json`):

| Path | Identity | Round trip | Verdict |
|---|---|---|---|
| Receiver `fa60` | `Delux M600 Pro (Wireless)`, battery 100 % | DPI 800 → restored 1600, polling 500 → restored 1000 Hz | pass |
| Wired `fa71` | `Delux M600 Pro (Wired)` | DPI 1600 → restored 800, polling 500 → restored 1000 Hz | pass |

The link stayed up after both runs. The test's "read back" compares against
the driver's cached state, because this firmware answers no reads. The
effect of the writes is shown by the motion measurements above.

## Windows

Tested on the same unit on Windows 11 (10.0.26200) with Chrome 154 on
2026-10-03, on the receiver and on the cable. Raw material is in
`captures/delux-m600-pro/windows-webhid.txt` and `windows-bridge.txt`.

- **Why the browser sees nothing.** Interface 2 splits into four collections
  (`&col01` to `&col04`). The battery collection (`&col03`, `0x0A/0x00`) and
  the config collection (`&col04`, `0x0B/0x00`) declare only Constant items,
  so `HidP_GetCaps` reports no button or value caps for either. Their report
  lengths are still there: 5 bytes of input on `&col03`, and 262 bytes of
  feature on `&col04` (report `0x23`, 261 bytes, plus the id).
- **Natively the data is there.** `ReadFile` on `&col03` with the stock
  driver returns `03 20 40 01 4d` (model `0x20`, 77 %), and `&col04` opens
  without WinUSB.
- **Chrome on Windows** builds `HIDDevice.collections` from the caps. It
  lists only the consumer collection (`0x0C/0x01`, input `0x02`) and hides
  the protected system-control one. No input report `0x03` arrives. The
  receiver therefore stays the read-only "Attack Shark mouse (2.4 GHz
  receiver)", with no battery. No driver change can reach these
  collections from the browser.
- **OpenMouse Bridge on Windows** lists all seven collections, with
  descriptors hidapi rebuilt from the preparsed data:
  - `0x0A` appears as an unnumbered 4-byte input, so the receiver message
    arrives as report `0x00` with data `03 20 40 01 4c`.
  - `0x0B` appears with no reports.

  The X11 path accepts that shape:
  - A 5-byte report-0 packet starting with `0x03` is treated as a receiver
    message. The boot mouse's and keyboards' unnumbered reports are 7 and 8
    bytes long.
  - When the `0x0B` collection declares nothing, writes are enabled only
    after a receiver message names a model checked on this path. Only the
    M600 Pro (`0x20`) is in that list.
  - The status read waits for that message, using the same bounded battery
    wait.
  - DPI uses the 52-byte form, the length the M600 Pro declares.
  - Bridge sends a report that no collection declares to every open path.
    On Windows hidapi pads a feature write to the collection's caps length,
    and `&col04` is the only collection with a nonzero feature length.
- **Receiver writes through Bridge:** with this change (local OpenMouse
  build at `http://localhost:5173`, Bridge running), the receiver showed up
  as `Delux M600 Pro (Wireless)` with its battery. DPI and polling-rate
  changes applied, judged by how the cursor behaved. No report rate was
  measured.
- **Wired (`fa71`):** Windows splits it the same way. `&col04` has 262 bytes
  of feature and no caps, and `&col03` sends nothing on the cable.
  - Chrome does not list the config collection, so the Delux driver still
    refuses the unit there.
  - Through Bridge the `0x0B` collection appears with no reports. The Delux
    driver accepts that shape for the unbranded PID, as it does the declared
    channel on Linux, and sends the same 52-byte DPI and 8-byte polling
    packets.
  - The wired unit sends no receiver messages, so it is named by its PID
    alone, as before.

## For maintainers

- The same `DeviceId` table lists the Delux M800 Mini as `0x2b`. The Delux
  driver's battery parser only accepts `0x55`, so if the table is right, an
  M800 Mini's battery packets are never recognised. This was not checked,
  because no M800 Mini was available.

## Unknowns

- DPI above 22,000: the PAW3395 is rated to 26,000, but the X11 step map
  stops at 22,000, and higher values were not tried.
- Whether the settings persist across power cycles was not tested.
- Lift-off distance (1/2 mm), debounce, sleep and lighting: no packets
  captured, and no vendor software was traced.
- The meaning of battery byte 1 (`0x20`, versus `0x55` on the X11).
- Report `0x04` byte 1 is `0x38` (56) even in the 52-byte form. It is kept
  as the codec builds it, and the device accepts it.
