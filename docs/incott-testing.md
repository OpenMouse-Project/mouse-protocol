# Incott hardware testing

Hardware: an "incott 8K wireless mouse" over its 2.4 GHz dongle (VID
`0x093A`, PID `0x522C`, manufacturer string "Pixart Imaging, Inc."), and the
SAME physical mouse plugged in over USB (PID `0x622C`, product string "incott
Esports G23V2Pro mouse" — the real model name). Both product ids are now
directly hardware-verified — see "Four bugs found probing wired AND wireless
hardware" below; `0x622C` was previously only inferred, not observed
directly.

Wireless, the vendor protocol answers on interface 3, the sole `0xFF05`
collection. Wired, the picture is more complicated — see below. See
`captures/incott-8k-wireless/` for the raw data this document summarizes.

## Battery relocated to an unsolicited input report; receiver LED scoped to wireless (2026-09-08)

These are the newest findings, superseding the "Four bugs" section below on
battery specifically.

### Battery is an UNSOLICITED INPUT report, not a feature-report reply — both prior hypotheses disproven

The `0x8e`/sub `0x01` byte-6 reading (see "Battery" further down, and the
"Disproven: 0x89 byte 8" section) was itself disproven by a **full charge
cycle**: charging a unit from roughly 60% to roughly 97% while polling that
feature-report reply showed byte 6 **never change at all** — the identical
frame `09 8e 01 5a 04 84 38 01` the entire time, `0x38` = 56 throughout. A
value that does not move while the real battery level visibly does cannot be
a battery reading. This is the second battery hypothesis disproven this way
(the first, `0x89` byte 8, was a constant `0x5a`/90 across every capture ever
taken — see below); **two disproven battery hypotheses on the same device is
exactly the kind of dead end this document exists to record.**

The real battery level lives in an **unsolicited INPUT report** the mouse
emits on its vendor collection (report id `0x09`) while it is actively being
used (moved or clicked) — not a reply to any request this driver sends, and
not obtainable on demand. Captured directly with node-hid across the same
full charge cycle:

```
discharging: 09 5f 10 04 00 0f 0f 10   byte 1 = 0x5f = 95   -> 95%
charging:    09 e1 10 04 00 0f 0f 10   byte 1 = 0xe1 = 225  -> charging, 225-128 = 97%
```

Decoding rule, verified in both states above (matches IncottHIDApp's
`parseStatus` — unlike that project's other claims about this device, this
one is now independently hardware-confirmed):

```
raw = byte 1 (node-hid buf[1] / WebHID event.data.getUint8(0))
raw > 100   -> charging,    level = raw - 128
raw <= 100  -> discharging, level = raw
```

Byte 2 of the same report (`0x10` in both captures above) is a packed pair,
ALSO verified: high nibble = active DPI **stage index** (0-5, the same value
`0x83`/`0x06` reports), low nibble = polling-rate index (into
`INCOTT_POLLING_WIRE_TO_HZ`). Both nibbles independently matched what the
feature reads returned at the same moment (`09 83 06` -> stage 1, `09 81`
byte 2 -> wire 0). This is a corroborating cross-check only — `readStatus()`
still treats the `0x83`/`0x81` feature reads as authoritative for DPI stage
and polling rate, not this packed byte.

See `captures/incott-8k-wireless/input-report-battery.hex` for the full
capture and byte-index notes, and `incottDecodeInputStatus` /
`IncottHidClient.onInputReport` for the codec and the WebHID listener.

**CRITICAL BYTE-INDEX ASYMMETRY, same class of trap as the feature-report one
documented in "Read-only transaction discipline" below**: the captures above
were taken with node-hid, whose raw input buffer INCLUDES the report id at
index 0. WebHID's `inputreport` event is different — it carries `reportId` as
a separate property, and its `data` DataView EXCLUDES the report id. So:

```
node-hid buf[1]  ==  WebHID event.data.getUint8(0)
node-hid buf[2]  ==  WebHID event.data.getUint8(1)
```

`incottDecodeInputStatus` is written against the WebHID convention (report id
excluded) — the same convention every `incottEncode*` function in this module
already uses for outgoing feature reports — and `onInputReport` unwraps the
WebHID event into it. Get this backwards and every field reads off by one
byte.

`IncottHidClient` caches the most recently decoded report and its charging
bit; `readStatus()` reports the cached values. The device only emits these
while in use, so **until the first report arrives, battery is `null` and
`batteryState` is `"Unknown"`** — no fabricated number, and no fallback to
the disproven feature-report bytes. The charging state comes from the
report's own bit (`raw > 100`), not from the product id: `incottIsWiredProduct`
(`0x622C`) still means the CONNECTION is wired (which `connectionType` uses),
and being wired does imply charging in practice, but the report is the
authoritative source, not an inference from the product id.

### Receiver LED is meaningless over USB — not currently advertised anywhere, so nothing to hide yet

The receiver LED (`0x08` write / `0x88` read, `IncottHidClient.setReceiverLed`)
is a property of the 2.4 GHz dongle and has no meaning when the mouse is
wired (`incottIsWiredProduct` true) — there is no dongle in that mode.
Checked `MouseUiHints` in `src/drivers/mouse-types.ts` for an existing `hide*`
flag to gate this and found none scoped to the receiver LED (the closest,
`hideSignalCard`, is about link-quality telemetry, a different control).
Deliberately did **not** add a new flag to that shared contract: `setReceiverLed`
is not wired into `MouseStatus`/the app's generic UI for Incott at all today
(same status as `setPerformanceMode` — a codec + client method kept for
protocol parity, per the class comment on `setReceiverLed` in
`src/drivers/incott/hid.ts`), so there is currently no advertised control to
hide. A comment at `setReceiverLed` records this for whoever wires the
control up later.

## Four bugs found probing wired AND wireless hardware (2026-09-08)

All four of the following were found by probing the owner's mouse in BOTH
wireless and wired modes, and are the newest, highest-trust findings in this
document — see `captures/incott-8k-wireless/wired-device-enumeration.txt` for
the wired capture.

### 1. Wired mode was completely broken: two look-alike 0xFF05 collections, only one live

Wired, interface 2 exposes TWO top-level collections on usage page `0xFF05`
(both usage `0x01`) — indistinguishable by vendor id, product id, or usage
page. The FIRST one rejects every feature report: Windows returns
`HidD_SetFeature: (0x00000001) Incorrect function`. The SECOND one is the
real vendor protocol. Wireless, by contrast, there is exactly one `0xFF05`
collection (interface 3) and it works — which is why this went unnoticed
until someone tried the mouse wired.

The driver used to pick the first `0xFF05` match (falling back to any page
`>= 0xFF00`), so wired it always picked the dead collection and every read
and write failed — 100% failure, not an intermittent one.

**The fix**: never trust usage page alone. `incottProbeCollection`
(`src/drivers/incott/hid.ts`) sends the identity query (`09 8f 00`) and
requires a well-formed reply (byte 0 = report id `0x09`, byte 1 = `0x8f`)
before accepting a collection; `incottSelectCollection` tries candidates in
order — `0xFF05` first, then any page `>= 0xFF00` — and moves on when one
throws or never replies.

**The WebHID constraint**: a WebHID `HIDDevice` corresponds to a single
collection, and the browser's picker/filters — not this driver — decide
which one the app receives. So `IncottHidClient.isSupported` stays
permissive (it must, or it would just as easily reject the live collection,
which looks identical from vendor/product id and usage page), and
`IncottHidClient.open()` probes the one collection it was handed instead of
choosing between several: it never throws, and records the result so
`readStatus()` can skip straight to a fully degraded, `ui.settingsReady:
false` status (the existing graceful-degradation path) rather than spending
its full retry budget on roughly a dozen queries a known-dead collection
cannot answer either. `IncottHidClient.filters` already requested both
product ids (`0x522C` and `0x622C`) before this fix.

### 2. 0x622C means WIRED, not "charging"

Verified: plugged into USB the device enumerates as product id `0x622C`; on
the 2.4 GHz dongle it is `0x522C`. The driver used to treat `0x622C` as a
charging FLAG (`incottIsChargingProduct`) — the wrong axis. It is really the
CONNECTION type; charging is a consequence of being plugged in, not what the
id itself encodes.

**The fix**: `MouseStatus.connectionType` is now `"Wired"` for `0x622C` and
`"Wireless"` for `0x522C`. `batteryState: "Charging"` is kept for `0x622C`
(it genuinely is charging) but is now derived from the connection via the
renamed helper `incottIsWiredProduct` (`src/incott/index.ts`), not from a
constant that claimed to mean "charging."

### 3. The polling-rate ceiling depends on the connection

The owner confirmed the mouse only reaches 1000 Hz over the cable; 2000/4000/
8000 Hz are wireless-only. Publishing the full 125-8000 Hz ladder while wired
would let the shell offer a rate the device silently refuses, which
`setPollingRate`'s read-back verification would then report as a failure on
every attempt — indistinguishable from a genuine device fault.

**The fix**: `readStatus()` now publishes `supportedPollingRates` from
`INCOTT_POLLING_STEPS_HZ_WIRED` (`[125, 250, 500, 1000]`) when
`incottIsWiredProduct` is true, and the full `INCOTT_POLLING_STEPS_HZ` ladder
otherwise, alongside `ui.hideUnsupportedPollingRates: true` and an
`ui.pollingNote` footnote naming the ceiling for the current connection (the
same pattern MCHOSE and G-Wolves already use for their own connection-
dependent ceilings).

### 4. The real model name is only in the wired product string

Verified product strings:
```
wired    (0x622C): "incott Esports G23V2Pro mouse"    <- the REAL model
wireless (0x522C): "incott 8K wireless mouse"          <- the dongle's generic name
```

**The fix**: `MouseStatus.name` still comes from the HID product string, but
`incottNormalizeProductName` (`src/incott/index.ts`) now tidies it for
display — stripping a leading vendor word ("incott") and a trailing "mouse"
when present — so "incott Esports G23V2Pro mouse" reads as "Esports
G23V2Pro". The raw string is untouched and stays available as
`client.device.productName`. This does NOT hardcode a model table and does
NOT infer a model when wireless: there is no way to read the model over the
air, and guessing one would be a fabricated value, so the wireless name
simply normalizes down to "8K wireless" — tidied, not invented.

The identity query's reply (`09 8f 00` -> `01 0e 02 f0 f1 00 ff`) has still
NOT been decoded (see "Unresolved unknowns" below), so it is not currently a
source for the model name either, wired or wireless.

### Not a bug: motion sync reading OFF while the vendor tool displays ON

With the vendor tool reporting motion sync ON, BOTH of this driver's
independent reads reported OFF: `0x84` sub `0x04` byte 3 = 0, and `0x84` sub
`0x00` byte 7's low nibble = 0. These are two separately-implemented decoders
(`incottDecodeToggle`/`incottDecodeMotionSync`) reading two different byte
positions in two different response frames, and they agree with each other
against the vendor tool's display. Two independent reads agreeing with one
another, both disagreeing with a single vendor-tool display, points at the
vendor tool rather than at this driver's decode: the most likely explanation
is that the vendor tool renders its own last-WRITTEN value rather than
re-reading the device, so it never shows a change made outside its own
session. This is left as an observation, not a defect — the decoders were
NOT changed.

## Three capture sessions, three trust levels

There are now three capture sessions in `captures/incott-8k-wireless/`, and
they do not carry equal weight:

1. **2026-09-07, read-only node-hid probes** (`targeted-reads.hex`,
   `query-sweep-0x80-0x8f.hex`, `repeatability.hex`, `device-enumeration.txt`).
   No write was ever sent; these only confirm which opcodes answer and what
   their raw bytes look like.
2. **2026-09-07, vendor-tool session** (`vendor-tool-session.hex`) — captured
   by instrumenting Incott's own WebHID configurator at incott.net/mouse/
   (hooking `HIDDevice.prototype.sendFeatureReport` /
   `receiveFeatureReport`) against a real G23V2Pro. Ground truth for that
   session's claims: it is the vendor's own software talking to the vendor's
   own device.
3. **2026-09-08, write round-trip session** (`write-roundtrip.hex`) —
   node-hid directly against hardware again, but this time performing real
   writes, reading each one back, and restoring the original value
   afterwards. This is the **highest-trust session**: it is the only one that
   confirms a write actually took effect (by reading it back) rather than
   only confirming that a query answers.

## Verified on hardware

Everything in this section was read back and, where a write was involved,
restored afterwards — see `captures/incott-8k-wireless/write-roundtrip.hex`
unless noted otherwise.

### DPI is a six-stage table with FOUR independent commands, not one (2026-09-08)

DPI lives in a **six-stage table**, not a single value, and there are **four
genuinely independent operations** on it — two concerns (which stage is
active, and what a stage holds), each with its own read and write:

|                    | Read | Write |
|---|---|---|
| **which stage is active** | `09 83 06` -> response byte 3 (0-5) | `09 03 06 <idx>` |
| **what a stage holds** | `09 82 <stage>` -> RESPONSE bytes 3-4 (LE16) | `09 02 <stage> <lo> <hi>` |

Each stage's value is a linear little-endian uint16 "wire" value:

```
wire = dpi / 50 - 1        dpi = (wire + 1) * 50
```

Proof the value is linear: reading stages 0-5 returned wire `0x07`/`0x0f`/
`0x1f`/`0x2f`/`0x3f`/`0x7f` = 400/800/1600/2400/3200/6400 DPI — six
independent points on the `wire = dpi/50 - 1` line, ruling out an
index-into-presets interpretation. Writing 25000 to stage 2 read back as
exactly 25000; restoring 1600 read back as exactly 1600.

**Select and edit are distinct operations — verified separately.** Selecting
stage 0, then 3, then 5, then 1 in turn each read back correctly via
`0x83`/`0x06`, and re-reading all six stages via `0x82` after those four
selects showed the table's stored values **completely unchanged**. A select
never edits; an edit never changes which stage is active. See
`captures/incott-8k-wireless/write-roundtrip.hex` for both the six-stage
value proof and the select-vs-edit proof.

**THE FIRST DPI BUG (fixed earlier the same day)**: `incottEncodeSetDpi`
used to hardcode the write's second byte as a constant `0x01` (previously
exported as `INCOTT_SUB_SET_DPI`, now removed), so it could only ever write
stage 1 of the table — writing while stage 3 was active, for example,
silently edited the wrong stage. That byte is a **stage index**, not a fixed
sub-command; see `INCOTT_DPI_STAGE_COUNT` and `incottEncodeSetDpi` in
`src/incott/index.ts`.

**THE SECOND DPI BUG (fixed the same day, from a real owner report)**: even
after the first fix, `IncottHidClient.setDpi()` was the *only* way the driver
could touch DPI. It read which stage was active and then wrote the
requested DPI *into that stage* — so picking "3200" in the UI did not select
the stage that already held 3200; it silently overwrote whichever stage
happened to be active with 3200. Repeated use progressively destroyed the
mouse's factory-programmed table: one owner's stage 2 was found changed from
1600 to 800 this way. It also explains a confusing symptom in third-party
tools, which display `factoryPresetTable[activeIndex]` — once the driver's
overwrites had diverged the real table from the factory one, those tools
showed stale/wrong values for stages the driver had never intentionally
touched.

**THE ROOT CAUSE IS A MISLABEL IN THE PRIOR ART.** IncottHIDApp's `09 03 06
<idx>` write is labelled "set DPI" in that project, and its six "DPI presets"
are described as if picking one changes the DPI value. They do not: `0x03`
is the active-stage **select**, and IncottHIDApp's six presets are just the
factory *stage values*, read back afterwards through `0x83`'s active-index
report. Conflating "select a preset" with "edit the active stage's value" is
exactly the bug this driver had. **Do not re-introduce this mislabel.**

The fix: DPI is now modelled as four independent operations, matching
OpenMouse's existing generic contract
(`openmouse/src/device/controller.ts`, via `requireClientMethod`):

- `setActiveDpiStage(stage)` -> `09 03 06 <idx>`, confirmed by re-reading
  `0x83`/`0x06`. Never touches a stored value.
- `setDpiStageValue(stage, dpi)` -> `09 02 <stage> <lo> <hi>`, confirmed by
  re-reading `0x82`/`<stage>`. Edits one stage directly, by index.
- `setDpi(dpi)` is kept, but now means exactly "set the ACTIVE stage's
  value" — i.e. `setDpiStageValue(activeStage, dpi)` — since that is the only
  meaning left for a plain "set DPI" call once a real select exists.
- `readStatus()` reads which stage is active (`0x83`/`0x06`) and every one of
  the six stages' stored values (`0x82`, sequentially — six queries, never
  parallelized, see "Read-only transaction discipline" below), populating
  `MouseStatus.dpiStages` / `MouseStatus.activeDpiStage` and
  `MouseUiHints.dpiStageEditor` (`{ maxStages: 6, countEditable: false, minDpi:
  50, maxDpi: 45000, stepDpi: 50 }` — `countEditable: false` because Incott's
  six stages are a fixed hardware property, not something the app can add to
  or remove from). `MouseStatus.dpi` is derived as the active stage's own
  value, a genuine live read, not a write cache.

`0x82` **echoes its sub-command** (verified: `09 82 03` replies `09 82 03
…`), so it is registered in `SUB_ECHOING_QUERIES`
(`src/drivers/incott/hid.ts`) alongside `0x83`/`0x84`/`0x85`/`0x86`/`0x8e`.
`0x03` is a write with no reply, so it needs no entry there.

This *supersedes* an earlier, narrower proof from 2026-09-07 against a
G23V2Pro (`vendor-tool-session.hex`) that only ever exercised stage 1:
`TX 09 02 01 0f 00` -> 800 DPI, `TX 09 02 01 f3 01` -> 25000 DPI. That capture
also disproved a *different*, older assumption — that DPI was a preset index
written under command `0x03` — and remains valid for that claim; see
"Corrected 2026-09-07" further down.

The writable range is still 50-45000 in steps of 50, per the vendor's own
device definition (`js/gvarG23-v102.js`), pairing two PixArt sensor variants
(PAW3395: 32000, PAW3950: 45000) — see "Sensor variant," an open question
below.

### Polling rate byte 2 is genuinely the data, not an echo (2026-09-08)

`incottDecodePollingRate` reads byte 2 of the `0x81` response. This used to
be an assumption ("the position that mirrors the write payload"); it is now
**confirmed**: writing wire `1` (500 Hz) then wire `0` (1000 Hz) and reading
back showed byte 2 follow the write, `0 -> 1 -> 0`. `0x81` does **not** echo a
sub-command the way `0x82`-`0x86`/`0x8e` do — byte 2 here is data — so it
correctly stays out of `SUB_ECHOING_QUERIES`.

### Lift-off and motion sync: symmetric reads confirmed, packed nibble form cross-checked (2026-09-08)

Every `0x04`/`0x05` setting has a symmetric read at the *same* sub-command on
`0x84`/`0x85`:

| Setting | Write | Read | Value at |
|---|---|---|---|
| Lift-off | `09 04 01 <hw>` | `09 84 01` | byte 3 |
| Ripple | `09 04 02 <0\|1>` | `09 84 02` | byte 3 |
| Angle snapping | `09 04 03 <0\|1>` | `09 84 03` | byte 3 |
| Motion sync | `09 04 04 <0\|1>` | `09 84 04` | byte 3 |
| Performance mode | `09 04 05 <v>` | `09 84 05` | byte 3 |
| Debounce | `09 05 01 <ms>` | `09 85 01` | byte 3 |
| Sleep | `09 05 03 <lo><hi>` | `09 85 03` | bytes 3-4 (LE16) |

Ripple, angle snapping, debounce and sleep already used this symmetric form.
Lift-off and motion sync used to read a packed byte instead: `0x84`/sub
`0x00`, byte 7, high nibble for lift-off and low nibble for motion sync. That
packed form is **not wrong** — motion sync read back 0/1/0 through *both*
`0x84` sub `0x04` byte 3 and `0x84` sub `0x00` byte 7's low nibble, and they
agreed at every step; lift-off round-tripped hw 0/1/2 through both forms
identically too. It is just less direct, and the driver now uses the
symmetric single-purpose reads (`incottDecodeLiftOffDirect`,
`incottDecodeToggle(frame, INCOTT_SUB_MOTION_SYNC)`) as its primary path. The
packed-nibble decoders (`incottDecodeLiftOff`, `incottDecodeMotionSync`) are
kept and still tested as a documented cross-check, not removed.

This section is about the **wire-value encoding** (hw 0/1/2 for lift-off,
round-tripped cleanly). Which physical millimetre distance each lift-off hw
value means is a *separate*, still-open question — see below.

### Buttons: new capability, codec only (2026-09-08)

The device has six buttons and a previously-undecoded read/write pair:

- **Write:** `09 06 <button 0..5> <b0> <b1> <b2>`.
- **Read:** `09 86 <button 0..5>` -> response bytes 3-5.

Round-trip confirmed: writing `09 06 00 01 00 f0` to button 0, then reading
`09 86 00`, returned `01 00 f0` — byte for byte. Reading all six buttons on
the unit under test returned:

```
button 0 -> 01 00 f0        button 3 -> 01 00 f3
button 1 -> 01 00 f1        button 4 -> 01 00 f4
button 2 -> 01 00 f2        button 5 -> 07 00 03
```

`0x86` was previously `INCOTT_CMD_UNKNOWN_86`, decoded only for the vendor
tool's own `09 86 09` query (payload still unexplained). It is now
`INCOTT_CMD_QUERY_BUTTON`; `INCOTT_CMD_SET_BUTTON` (`0x06`) is the matching
write.

### Buttons: DECODED and shipped (2026-09-10)

The binding is a **32-bit little-endian action word**, not three opaque
bytes, and the capture above turns out to confirm the entire mouse action
table. The inference recorded here — that button 5's odd `07 00 03` shape
meant a different *kind* of action, plausibly DPI — was right: it is
`0x00030007`, which the vendor's encoder returns for its DPI-cycle function.

| Wire index | Bytes | Word | Action |
| --- | --- | --- | --- |
| 0 | `01 00 f0` | `0x00F00001` | Left click |
| 1 | `01 00 f1` | `0x00F10001` | Right click |
| 2 | `01 00 f2` | `0x00F20001` | Middle click |
| 3 | `01 00 f3` | `0x00F30001` | **Back** |
| 4 | `01 00 f4` | `0x00F40001` | **Forward** |
| 5 | `07 00 03` | `0x00030007` | DPI cycle |

**A BUG this exposed.** `incottDecodeButtonBinding` read only response bytes
3-5 and dropped the fourth, so any action above 24 bits decoded to a value
that was never written — "Rapid fire" (`0x0218F00A`) came back as
`0x0018F00A`. The vendor reads all four
(`rData[5]<<24|rData[4]<<16|rData[3]<<8|rData[2]`). Fixed, with a regression
test.

**THE WIRE INDEX IS NOT THE DISPLAY POSITION.** Note rows 3 and 4 above:
index 3 answers `0xF3` (back) and index 4 answers `0xF4` (forward). The
vendor addresses buttons through an explicit `matrix` field in its per-model
key table (`setMsK(dvar.key[i].matrix, code)`), and on this family Forward
and Back are transposed; every other button's matrix equals its position.
Using the array position silently remaps the wrong button — and looks like
it worked. `INCOTT_BUTTON_WIRE_INDEX` encodes this, with a test pinning it.

The rest of the action table (media keys, rapid fire, profile switch,
disable) is transcribed from the vendor's `kf_hw()` encoder; see
`INCOTT_BUTTON_ACTIONS`. Remapping was exercised end to end on hardware by
the device owner on 2026-09-10 and behaves correctly.

**Now wired into `IncottHidClient`**: `readStatus` publishes
`buttonMappings`/`buttonOptions` and `setButtonMapping(button, action)`
writes with a verified read-back, so OpenMouse's shared remapper renders
with no app-side change. All six bindings are read or none are published —
a partial read would show fabricated defaults, and the shared UI writes back
what it displays. A binding outside the table reports as `Unknown (0x...)`
for the same reason.

**Deliberately NOT offered:** keyboard bindings, which are parametric rather
than a fixed list (`(keycode & 255) << 16 | (modifiers & 255) << 8`, or
`(keycode & 255) << 8 | 128` with no modifier) and cannot be expressed in the
flat `buttonOptions` contract; and macros (`slot << 16 | 9`), which need the
`0x07` upload command.

### Battery (2026-09-07, DISPROVEN 2026-09-08 — see the top of this document)

Byte 6 of the `0x8e`/sub `0x01` response looked, at the time, like the exact
battery percentage: `TX 09 8e 01` -> `RX 09 8e 01 5a 04 84 38 01 00`, byte 6 =
`0x38` = 56, and the vendor UI showed "60%" for this same reading (confirmed
directly by the person who captured this session that the vendor's own
display rounds to the nearest 10%, which made 56 look like a very plausible
exact value). **This was disproven by a later, more thorough test**: charging
a unit through a full cycle from roughly 60% to roughly 97% left this exact
byte completely unchanged. See "Battery relocated to an unsolicited input
report" at the top of this document for what replaced it. `incottDecodeBattery`
is kept as a codec/regression fixture only; nothing in the driver decodes
battery from this frame any more.

### DPI (preset-index question) and battery: corrected 2026-09-07

Both of these were previously "assumed" (carried over from IncottHIDApp) and
were corrected against the vendor-tool capture, ahead of the six-stage-table
discovery above:

- **DPI is a linear little-endian uint16**, written under command `0x02`,
  sub-command `0x01` — not an index into a 6-entry preset table written under
  command `0x03`. Confirmed by two round-trips: `TX 09 02 01 0f 00` -> 800
  DPI (wire 15) and `TX 09 02 01 f3 01` -> 25000 DPI (wire 499).
  - `[400, 800, 1600, 2400, 3200, 6400]` (`INCOTT_DPI_DEFAULT_STAGE_PRESETS`)
    is **not** the writable range — the vendor's device definition calls it
    the six default DPI *stage presets*. As of the 2026-09-08 session, this
    is also exactly what the six stages read back as on the unit under test,
    i.e. it doubles as the factory-default value for each stage.
  - `0x83`/sub `0x06` does **not** answer with a DPI value — it answers with
    the **active stage index (0-5)**. The old decoder read byte 3 through the
    six-entry preset table and got 800 DPI back, which matched the vendor UI
    only by coincidence: the device happened to be on stage 1 of 6 at capture
    time. See `incottDecodeDpiStageIndex`.

- **Battery percentage is byte 6 of the `0x8e`/sub `0x01` response** — not
  byte 8 of the `0x89` response (see "Disproven" below).

### Disproven: `0x89` byte 8 was never a battery reading

The original hypothesis (recorded in an earlier version of this document) was
that byte 8 of the `0x89` response was the battery percentage, because it
read a plausible-looking `0x5a` (90) on hardware. It is not: **that same byte
read the identical constant `0x5a` on every capture ever taken, across every
device state, in every capture session including the 2026-09-08 round.** A
value that never changes regardless of device state cannot be a battery
percentage — it is a constant of unknown meaning. This is why the app was
permanently stuck at 90% battery: it was decoding a constant, not a reading.
`0x89` still answers, and the driver still records that it does, but nothing
decodes its payload any more.

### Lesson: an opcode sweep using only sub `0x00` misses real sub-commands

The original opcode sweep (`query-sweep-0x80-0x8f.hex`) concluded `0x8e`
(battery) was unimplemented, and had no interpretation for `0x82` at all,
because that sweep only ever sent sub-command `0x00` to every opcode:
`0x8e` only answers on sub-command `0x01`, and `0x82`'s per-stage DPI reads
only answer on subs `0x00`-`0x05` (each returning a *different* stage, not a
single "the" answer) — a bare `09 82 00` looks like an ordinary, uninteresting
reply unless you already know to try the other five sub-commands too. **This
is exactly how `0x82`'s stage table and `0x8e`'s battery were both missed by
the earlier sweep.** The vendor tool teaches the same lesson for `0x86`,
which it queries as `09 86 09` — not a button index (buttons only go up to
5) and still undecoded.

`0x82`/`0x84`/`0x85`/`0x86`/`0x8e` echo their sub-command at byte 2 of the
reply, and all five are registered in `SUB_ECHOING_QUERIES`
(`src/drivers/incott/hid.ts`). `0x86` joined that set on 2026-09-10 when
button reads were wired up: six reads go out back to back against a single
shared response buffer, so matching on the command byte alone would let one
button's reply satisfy another's request.

**`0x83` DOES NOT echo — corrected 2026-09-10.** It was listed here and
registered in `SUB_ECHOING_QUERIES` for two sessions on the strength of a
reply that appeared to echo the `0x06` sent with it. Byte 2 is the DPI stage
COUNT: the vendor sends `09 83 00` and gets `09 83 06 01`, and a bare
`09 83` sweep answers the same `06`. A byte the request never contained
cannot be an echo — the assumption only survived because the count on the
device under test happens to be six. See "DPI stage count" below.

## Performance mode: mapping VERIFIED 2026-09-10, now wired into the shared UI contract

The vendor tool has a three-way "Performance mode" control (labelled HP /
Corded / LP left-to-right, described as trading performance for battery
life and energy efficiency, the middle option suitable for everyday use).
The 2026-09-07 vendor-tool capture recorded two of the three raw writes but
never recorded which on-screen label produced which value — that gap is now
closed.

**2026-09-10**: a second vendor-tool session instrumented the same
configurator again, this time with every click labelled BEFORE the
resulting write was recorded:

```
clicked "HP"      -> TX 09 04 05 02
clicked "Corded"  -> TX 09 04 05 01
clicked "LP"      -> TX 09 04 05 00
```

So: **HP = 2, Corded = 1, LP = 0** — the **REVERSE** of the vendor UI's own
left-to-right display order. This is exactly why the mapping was captured
with each click labelled rather than assumed from the on-screen order; see
`captures/incott-8k-wireless/vendor-tool-session-2026-09-10.hex`. The
reversal lives in one named table, `INCOTT_PERFORMANCE_MODE_TO_WIRE` /
`INCOTT_PERFORMANCE_MODE_FROM_WIRE` (`src/incott/index.ts`), with
`incottPerformanceModeToWire`/`incottPerformanceModeFromWire` as the
validated lookup functions.

The same session also captured the read-back:

```
TX 09 84 05
RX 09 84 05 00 00 00 00 00 00   (byte 3 = 0, matching the just-written LP)
```

confirming `0x84`/sub `0x05` follows the same symmetric-read pattern as
lift-off, ripple, angle snap and motion sync (see "Lift-off and motion sync"
above) — `0x84` was already registered in `SUB_ECHOING_QUERIES`
(`src/drivers/incott/hid.ts`) for those other sub-commands, so no
transaction-discipline change was needed to cover this one too.

**Now wired into `MouseStatus`/`MouseUiHints`**, using the shared contract's
existing `powerModes`/`powerMode`/`setPowerMode` fields (the same fields
MCHOSE uses for an identical three-way mode): `IncottHidClient.getPowerModes()`
advertises `["HP", "Corded", "LP"]` in the vendor UI's own left-to-right
order; `readStatus()` populates `powerMode` from a live `0x84`/`0x05` read,
leaving it `undefined` (never fabricated) when that read fails or when the
collection is dead; and `setPowerMode(name)` validates the name against the
table above, writes, and requires a matching, non-null read-back before
reporting success — an unverifiable write reports failure, matching every
other setter in this driver. The lower-level `incottEncodeSetPerformanceMode`/
`incottDecodePerformanceMode` codec and the raw-value `setPerformanceMode`/
`getPerformanceMode` client methods are kept unchanged underneath it.

## Receiver LED labels are now VERIFIED (2026-09-10)

`INCOTT_RECEIVER_LED_MODES` (`src/incott/index.ts`) — "Connect & polling
rate" / "Battery status" / "Battery warning" for raw values `0`/`1`/`2` — came
from the MIT-licensed IncottHIDApp as unverified prior art. The 2026-09-10
vendor-tool session selected each of the vendor UI's three receiver-LED
options in turn, labelling the click before recording the write, then read
`0x88` back:

```
selected "Connect and polling rate" -> TX 09 08 00 -> RX 09 88 00 …
selected "Battery status"           -> TX 09 08 01 -> RX 09 88 01 …
selected "Battery warning"          -> TX 09 08 02 -> RX 09 88 02 …
```

All three labels are confirmed correct, in the same 0/1/2 order the driver
already shipped. See
`captures/incott-8k-wireless/vendor-tool-session-2026-09-10.hex`.

## DPI writes carry an axis byte (2026-09-10)

The DPI write payload is longer than this driver previously modelled it:
`02 <stage> <lo> <hi> 00 00 00 <axis>`, where `axis` is a byte at payload
index 7 (the last byte of the 8-byte payload) that this driver did not
previously know existed:

```
axis 0 -> both axes (the vendor UI's default "both" control)
axis 1 -> X axis only
axis 2 -> Y axis only
```

`incottEncodeSetDpi` (`src/incott/index.ts`) has always emitted trailing
zeros for every payload position it does not explicitly fill, so it has
always written axis `0` (both) — correct, but for a reason that was unknown
until this capture, not by design. A comment at `incottEncodeSetDpi` records
this.

**Independent X/Y DPI is deliberately NOT implemented from this finding.**
The same session probed the READ side (`0x82`) with the axis byte set to `0`,
`1` and `2` in turn and got back the identical value every time — there is no
per-axis read on this firmware, or at least not at this sub-command. Without
a read that can distinguish a Y-only write from a both-axes write, this
driver cannot verify one, and it does not ship writes it cannot verify (see
the class comment on `IncottHidClient`). This is recorded as an open question
in "Unresolved unknowns" below: the fix would be finding the read the vendor
tool itself uses to display separate X and Y DPI values, if it has one. See
`captures/incott-8k-wireless/vendor-tool-session-2026-09-10.hex`.

## Onboard profiles: the settings are replayed by the host (2026-09-10, corrected below)

Switching the vendor UI from "Onboard 1" to "Onboard 2" was instrumented end
to end. **It emitted no profile-select command at all.** Instead it replayed
the entire configuration as a burst of ordinary setting writes — all six
button bindings, all six DPI stage values, the active stage, polling rate,
performance mode, lift-off, the three sensor toggles, receiver LED, debounce
and sleep, roughly 23 writes in total, indistinguishable from a user manually
re-entering every setting by hand.

The settings themselves are a construct of the vendor's own configurator,
which stores a full snapshot per named slot and replays it wholesale on
selection. Nothing in the capture suggests the mouse stores per-slot
settings of its own.

### CORRECTION 2026-09-10: a profile-select command DOES exist

The paragraph that stood here said "there is no on-device command to search
for" and offered a hypothesis for one unexplained write. Both were wrong, and
the vendor's own deobfuscated bundle names the write directly:

```js
setProfileIndex(index)  { [6, 9, index, 0, 0, 0, 0, 0] }   // -> 09 06 09 <index>
readProfileIndex()      { readKEY(9) }                     // -> 09 86 09
```

That is exactly the `09 06 09 <00|01>` write logged at the end of each
replay, and the **"invert left and right button" hypothesis recorded for it
was wrong** — it is the profile index. The vendor also reads it back at
connect time, so the mouse genuinely stores a selectable index.

What survives from the original finding: switching slots still replays ~23
ordinary setting writes, so the index alone does not appear to make the mouse
swap a stored configuration. Whether the device stores anything at all
against that index is untested.

Neither command is implemented here — both are transcriptions, unverified on
hardware. See
`captures/incott-8k-wireless/vendor-tool-session-2026-09-10.hex` and the
model-identification section at the end of this document.

## READS: verified on hardware

Every read command the driver issues was exercised directly against the
device — see `captures/incott-8k-wireless/targeted-reads.hex`,
`query-sweep-0x80-0x8f.hex`, `vendor-tool-session.hex`, and
`write-roundtrip.hex`. Confirmed:

- `0x81` answers the polling-rate query; byte 2 is confirmed data (see above).
- `0x82` (with a sub-command 0-5) answers with that DPI stage's value.
- `0x83` (no sub-command) answers with the DPI cycle: byte 2 the stage COUNT,
  byte 3 the active *stage index* — neither is a DPI value.
- `0x84` (sensor) answers for sub-commands `0x00` (packed lift-off + motion
  sync), `0x01` (lift-off, symmetric), `0x02` (ripple control), `0x03`
  (angle snap), `0x04` (motion sync, symmetric), and `0x05` (performance
  mode, symmetric — read-back CONFIRMED 2026-09-10, see "Performance mode"
  above).
- `0x85` (timing) answers for sub-commands `0x01` (debounce) and `0x03`
  (sleep).
- `0x86` (with a sub-command 0-5) answers with that button's raw binding;
  sub `0x09` (the vendor tool's own query) also answers but is undecoded.
- `0x88` (receiver LED) and `0x89` (status, meaning still unknown) both
  answer.
- `0x8e` answers on sub-command `0x01` only. Byte 6 of that reply looked like
  a battery percentage at first (see "Battery" below) but was DISPROVEN
  2026-09-08 by a full charge cycle that left it unchanged — see "Battery
  relocated to an unsolicited input report" at the top of this document. The
  real battery level is a field of the mouse's unsolicited input report, not
  this feature-report reply.
- `0x8f` (identity) answers, though its byte layout is not decoded — see
  Unresolved below.
- `0x80` and `0x87` never answered in any capture session.

## WRITES: verified vs. unverified

**Verified by a real write + read-back + restore on hardware**
(`write-roundtrip.hex`, 2026-09-08): DPI stage-value edit (`0x02`, both the
byte layout and that byte 1 is a stage index), active-stage select (`0x03`,
sub `0x06` — confirmed distinct from the `0x02` edit: selecting stages 0, 3,
5, then 1 each read back correctly via `0x83`/`0x06`, and the six-stage table
was re-read afterwards and found completely unchanged), lift-off
(`0x04`/`0x01`, hw value round-trip — not the mm label, see below), motion
sync (`0x04`/`0x04`), polling rate (`0x01`), and button bindings (`0x06`, new
capability).

**Verified by a write + read-back** (no restore recorded,
`vendor-tool-session.hex`, 2026-09-07): DPI (an earlier, narrower proof) and
receiver LED (`0x08`, values only — label mapping confirmed 2026-09-10, see
below).

**Verified by a LABELLED write + read-back** (no restore recorded,
`vendor-tool-session-2026-09-10.hex`, 2026-09-10): performance mode
(`0x04`/`0x05` write, `0x84`/`0x05` read-back, full HP/Corded/LP label
mapping — see "Performance mode" above) and receiver LED's own label mapping
(`0x08` write, `0x88` read-back, all three labels — see "Receiver LED" below).

**Still unverified against hardware writes**: `incottEncodeSetToggle` for
ripple and angle snap specifically (motion sync is now verified; the write
shape is identical for all three, but only motion sync was directly
exercised), `incottEncodeSetDebounce`, and `incottEncodeSetSleep`. These were
derived from the MIT-licensed IncottHIDApp's `device.go` (see Attribution)
and have only ever been exercised against the fake-transport unit tests in
`src/drivers/incott/hid.test.ts`. Every setter that has a working read-back
in `src/drivers/incott/hid.ts` throws when the post-write read-back disagrees
with the requested value.

## Read-only transaction discipline

The most important thing this device does: **the same query, sent unchanged,
returned three different payloads across three separate capture runs** (see
`captures/incott-8k-wireless/repeatability.hex`). The device latches a single
shared response buffer, and a read can return a frame left over from a
different, earlier query rather than the one just sent. A live capture during
the 2026-09-08 session showed this concretely: a `0x81` query returned a
previous query's payload behind a correct-looking header, which is exactly
the failure mode `IncottTransactionQueue` exists to prevent.

Because of this, every request in `IncottTransactionQueue`
(`src/drivers/incott/hid.ts`) is serialized, discards whatever is already
latched before sending, and accepts a reply only when its report ID, command
byte, and — for `0x82`/`0x83`/`0x84`/`0x85`/`0x8e` (the queries the driver
actually issues that are known to echo their sub-command) — sub-command byte
all echo the request. The sub-command echo is deliberately **not** checked
for `0x81`/`0x88`/`0x89`/`0x8f`: byte 2 of those replies is data, not an
echoed sub-command, and matching it there would reject every polling rate but
1000 Hz and every LED mode but 0. This distinction is the reason IncottHIDApp's
own read loop (which matches on the command byte alone) is vulnerable to
exactly the stale-frame bug this queue exists to prevent.

## Unresolved unknowns

Per the "record what didn't work" principle, these are open questions no
capture session has resolved. **Do not resolve these by guessing.**

- **Lift-off hw -> millimetre label mapping — needs a hardware check.** The
  hw values 0/1/2 round-trip cleanly (confirmed 2026-09-08, see above), but
  which physical distance each means is unknown. IncottHIDApp claims hardware
  `0` = 1 mm, `1` = 2 mm, `2` = 0.7 mm (`INCOTT_LOD_WIRE_TO_TENTHS` in
  `src/incott/index.ts`). The vendor's own device definition
  (`js/gvarG23-v102.js`) instead pairs `lodUI = [0.7, 1, 2]` with
  `lodHW = [0, 1, 2]`, i.e. hardware `0` = 0.7 mm — a different mapping.
  Neither capture session recorded which on-screen label was selected for a
  given write. **Left unchanged pending a hardware check**: set 0.7 mm in the
  vendor tool, then read `0x84`/`0x01` (or the packed form) and see which
  value comes back.
- **The remaining `0x8f` identity bytes.** Bytes 2-6 are decoded (model,
  receiver, sensor — see the model-identification section at the end of this
  document). Bytes 7-8 (`00 ff` on this device) are still unknown; a firmware
  version is the obvious candidate but nothing confirms it.
- **DPI per-axis read — probably does not exist.** The 2026-09-10 capture
  found a write-side axis byte (payload index 7: 0 = both, 1 = X, 2 = Y) but
  no per-axis READ: probing `0x82` with the axis byte set to 0, 1 and 2
  returned the identical value every time. The vendor's own code matches
  this — `setResolution` sends two writes distinguished by that flag and has
  no per-axis read at all, so its UI must track X and Y host-side. Without a
  read to verify a Y-only write against, this driver still does not implement
  independent X/Y DPI.

Resolved since this list was written (kept for the record):

- ~~**Button payload semantics.**~~ A 32-bit little-endian action word; the
  six factory bindings confirm the mouse rows against hardware. See
  "Buttons: DECODED and shipped".
- ~~**Which sensor is fitted.**~~ Byte 6 of the identity reply: `0xF0` =
  PAW3395, `0xF1` = PAW3950.
- ~~**What `0x86` sub `0x09` means.**~~ The onboard profile index.
- ~~**The `09 06 09 <00|01>` write.**~~ The profile-index write, not a
  left/right invert toggle — see the correction under "Onboard profiles".

## Attribution

The protocol constants, opcode set, and command layouts this driver
implements derive from the MIT-licensed
[IncottHIDApp](https://github.com/romkazor/IncottHIDApp) (`device.go`). This
driver reuses that project's protocol knowledge, not its code. The DPI range
and the six default stage presets, the two PixArt sensor ceilings, and the
lift-off UI values (`lodUI`/`lodHW`) referenced above come from the vendor's
own device definition (`js/gvarG23-v102.js`) as seen through the
incott.net/mouse/ configurator. The captures in `captures/incott-8k-wireless/`
are original data: the 2026-09-07 read-only ones taken directly from
hardware with node-hid, `vendor-tool-session.hex` taken by instrumenting the
vendor's own WebHID configurator, and `write-roundtrip.hex` (2026-09-08)
taken directly from hardware with node-hid while performing real,
subsequently-restored writes — none of the three is reproduced from
IncottHIDApp.

The identity byte map (model code, receiver type, sensor) and the command
layouts listed as transcriptions above were established by reading the
vendor's own publicly served configurator bundle at `incott.net/mouse/js/`
for interoperability. No vendor code is copied into this driver: what is
reused is the wire format — which byte carries which field — reimplemented
here with its own decoders, tests and hardware confirmation where a device
was available to give it.

## Lift-off distance mapping — resolved 2026-09-08

Setting **0.7 mm** in Incott's own web configurator, then reading `09 84 01`,
returned byte 3 = `2`. Hardware `2` is therefore 0.7 mm, confirming the mapping
inherited from IncottHIDApp (`0` = 1 mm, `1` = 2 mm, `2` = 0.7 mm).

This also closes a false lead recorded earlier: the vendor's device definition
(`js/gvarG23-v102.js`) lists `lodUI = [0.7, 1, 2]` alongside `lodHW = [0, 1, 2]`,
which reads as hardware `0` = 0.7 mm if the two arrays are assumed index-aligned.
The device contradicts that, so the arrays are not a paired lookup. Recording it
because it is exactly the kind of plausible-but-wrong inference worth warning the
next contributor about.

Only the 0.7 mm point was read back directly. Hardware `0` and `1` are 1 mm and
2 mm in that order; the mapping is a bijection over {0,1,2} and the one claim that
was testable proved correct, but neither of those two values has been read
individually.

## Model identification: SOLVED 2026-09-10 — it is `0x8F`

The identity reply was sitting in the very first capture taken for this
driver, undecoded for three days:

```
09 8f 01 0e 02 f0 f1 00 ff        captures/incott-8k-wireless/query-sweep-0x80-0x8f.hex
```

### Why the earlier search failed

The previous section of this document (kept below in summary) recorded model
identification as unsolved after sweeping every query command `0x80`-`0x8F`
against sub-commands `0x00`-`0x1F` looking for the sensor id `0x3950` as a
raw 16-bit value. **It is not transmitted as one.** The sensor is a single
byte — `0xF0`/`0xF1` — expanded into `0x3395`/`0x3950` by a lookup on the
host. No amount of sweeping would have found it, and the model itself is a
different byte again.

The first search also stopped at "the vendor's JavaScript is obfuscated".
That was true but not an obstacle: the obfuscation is mechanical and reverses
in a few lines — decode `\uXXXX` escapes, fold the `(A^B)` junk arithmetic to
constants, and reverse the `"abc".split("").reverse().join("")` string
literals. `readDps()` is then plain to read.

### The byte map

`rData` in the vendor's code is the report **without** the report id, so
`rData[n]` is `frame[n+1]` here. Transcribed from its `readDps()`:

| Frame byte | Meaning | This device |
| --- | --- | --- |
| 2 | guard, must be `0x01` | `0x01` |
| 3 | **model code** | `0x0E` = G23V2 |
| 4 | receiver type, `0x02` = 8 KHz | `0x02` |
| 5 | sensor profile, WIRED link | `0xF0` = PAW3395 |
| 6 | sensor profile, WIRELESS link | `0xF1` = PAW3950 |
| 7-8 | still undecoded | `00 ff` |

Model codes, and the names the vendor's `text_en` bundle gives them:

| Code | Vendor internal | Displayed |
| --- | --- | --- |
| `0x01` | `Ghero` | Ghero |
| `0x02` | `G23` | G23 |
| `0x03` | `G24` | G24 |
| `0x06` | `G29` | Zero 29 (零29) |
| `0x08` | `G23V2` | G23V2 |
| `0x09` | `FM23` | Zero 39 (零39) |
| `0x0E` | `G23V2` | G23V2 |

`0x08` and `0x0E` are both G23V2 — the vendor tests them in one branch. Only
the `0x0E` row is confirmed against hardware here; the rest are transcribed
from a dispatch table that is authoritative for models this contributor does
not own.

The sensor decides the "Pro" suffix: the vendor appends `Pro` when the sensor
is `0x3950`, which is how `G23V2Pro` appears for a device whose HID product
string only ever says `incott 8K wireless mouse`.

### The one inference, and how to falsify it

Bytes 5 and 6 **disagree on this device** (`f0 f1`), and the vendor picks
between them by connection (`let i = this.iswireless ? 5 : 4`). Read as
hardware identity that is a contradiction — a mouse does not change sensors
when a cable goes in — so the vendor's own tool necessarily labels this one
physical mouse `G23V2Pro` on the dongle and `G23V2` on the cable.

Read as a per-link **capability** profile it is consistent: the value feeds
`getStDPI(sensor)`, which selects a DPI ceiling (PAW3395 -> 32000,
PAW3950 -> 45000), and the cable is already the reduced-capability path on
this device, capping polling at 1000 Hz.

`incottDecodeIdentity` therefore reads the fitted sensor from **byte 6**
unconditionally, so the decoded name is stable across connections. This is
the only inference in that decoder rather than a transcription.

**To falsify it:** connect the mouse by cable and read what the vendor tool
displays. If it shows `G23V2Pro` while wired, byte 5 is not a wired
capability profile and this reading is wrong. A per-link DPI ceiling is
deliberately NOT implemented — nothing has confirmed the cable caps DPI at
32000.

### What this replaces

`MouseStatus.name` now comes from the identity reply, falling back to
`incottNormalizeProductName` only when the query fails or the model code is
outside the table above. The product string is no longer the primary source:
it names a model over the cable and not on the dongle, so relying on it
renamed the mouse depending on how it was plugged in.

### Product ids cannot distinguish models — confirmed

All six models enumerate as `093A:522C` (wireless) / `093A:622C` (wired).
Two independent confirmations:

- The vendor's own WebHID filter, recovered from the deobfuscated bundle, is
  exactly those two product ids plus usage page `0xFF05`, usage `0x01`:
  ```js
  [{vendorId: 0x093A, productId: 0x622C, usagePage: 0xFF05, usage: 0x01},
   {vendorId: 0x093A, productId: 0x522C, usagePage: 0xFF05, usage: 0x01}]
  ```
  This independently confirms the `0xFF05` collection match this driver
  already uses (see "Wired mode was completely broken" above).
- [IncottHIDApp](https://github.com/romkazor/IncottHIDApp)'s compatibility
  table lists Ghero, G23, G24, G23V2, Zero 29 and Zero 39 against the same
  two ids, with three constants in `device.go` and no per-model table.

### Leads recovered from the same source, not yet implemented

Buttons came from this source and are now **implemented and hardware-
confirmed** — see "Buttons: DECODED and shipped" above. The rest are still
transcriptions, unverified against hardware:

- **Independent X/Y DPI** — one write per axis, distinguished by a flag at
  byte 7: `[2, ix, dpiLo, dpiHi, 0, 0, 0, flag]` with flag `0` when X == Y,
  then `1` for X and `2` for Y. There is no per-axis read, which is why a Y
  write could never be verified.
- **Profile select** — `[6, 9, index, 0, 0, 0, 0, 0]`, read back via
  `0x86` sub `0x09`. See the correction in "Onboard profiles" above.

## DPI stage count: a byte misread as a sub-command (2026-09-10)

`0x83`'s reply byte 2 is the **stage count** — how many stages the DPI cycle
rotates through — not a sub-command echo. The proof is in captures this
driver already had:

```
TX 09 83 00      <- vendor sends sub-command 0x00
RX 09 83 06 01   <- byte 2 comes back 0x06 anyway
```

and the bare `09 83` sweep in `query-sweep-0x80-0x8f.hex` answers
`09 83 06 01` too. A byte the request never contained cannot be an echo.
Byte 3 varies across the same session (`00`/`01`/`03`/`05`) while byte 2
stays `06`: byte 3 is the active stage, byte 2 is the cycle length.

The misreading survived two sessions because this contributor's mouse has a
six-stage cycle and the driver happened to send `06`. Everything agreed with
everything else, on one device, by coincidence — the same shape of mistake as
the battery byte (a constant matched once) and the DPI stage index (an index
that decoded to the right number once).

### Two real bugs this was causing

**Every DPI read would have failed on a shorter cycle.** `0x83` was in
`SUB_ECHOING_QUERIES`, so the driver required reply byte 2 to equal the `06`
it sent. On a mouse configured for four stages the reply carries `04`, no
frame ever matched, and `activeDpiStage`, `dpi` and `dpiStages` all came back
null — which sets `ui.settingsReady: false` and hides the entire settings
grid. Removed from that set; `incottDecodeDpiCycle` matches on the command
byte only.

**Selecting a stage silently resized the cycle.** The `0x03` write carries
the count and the index together (`09 03 <count> <stage>`), and the driver
hardcoded `0x06` in the count position. Picking a different DPI stage on a
four-stage mouse would have written six, growing the cycle back to the full
table. `setActiveDpiStage` now reads the current count and writes it back
unchanged.

Neither bug was observable on the only available device, and neither would
have been found by testing it.

### What this adds

`readStatus` publishes `dpiStages` trimmed to the live cycle and sets
`dpiStageEditor.countEditable` (only while the cycle actually read — the
count picker writes through `setDpiStageCount`, which needs a real current
count to clamp the active stage into the new range). `setDpiStageCount`
resizes the cycle, leaves every stored stage value untouched, and clamps the
active stage rather than leaving it pointing past the end.

**CONFIRMED on hardware 2026-09-11.** The device owner set the cycle to three
stages through this driver and cycled the mouse through all three, which is
the first direct evidence of a cycle shorter than six on this hardware —
until then the resize path was exercised only against the fake device, and no
capture of a non-six count existed at all, because the vendor tool had never
been driven to make one.

This also settles the count reading itself by a second route: a device that
rotates through exactly three stages after being told `09 03 03 <idx>` is
reading that byte as a cycle length, not echoing a sub-command.
