# Lamzu Inca 8K — capture notes

Hardware report from a Lamzu Inca 8K on its 8K wireless receiver, Windows 11.
Serial numbers are redacted. All commands below are reads; no setting on the
device was changed while capturing.

## Enumeration

`LAMZU INCA 8K Receiver`, manufacturer `LAMZU`, release `0x0100`.

**Vendor id `0x37b0` is new** — it is not the shared CompX ODM id `0x373e`
that the existing Lamzu, CRDRAKO, and Attack Shark products enumerate under.
Lamzu's own configurator confirms both are live: its `DeviceInitFilterVID` is
`373E;37B0`.

Product ids for this model:

| Product id | Role | Verified |
| --- | --- | --- |
| `0x0009` | Mouse on its cable | On hardware |
| `0x000f` | 1K receiver | Vendor table only |
| `0x0010` | 8K receiver | On hardware |
| `0x000a` | Mouse DFU bootloader — **not a mouse** | Vendor table only |
| `0x0002` | Receiver DFU bootloader — **not a mouse** | Vendor table only |

The two bootloader ids are the identities the mouse and dongle take while
firmware is being flashed. They do not speak this protocol and are excluded
from the catalog on purpose.

| Interface | Collection | Usage page | Usage | Feature report ids | Role |
| --- | --- | --- | --- | --- | --- |
| MI_00 | — | 0x0001 | 0x0002 | none | Mouse |
| MI_01 | Col01 | 0x000c | 0x0001 | none | Consumer control |
| MI_01 | Col02 | 0x0001 | 0x0080 | none | System control |
| MI_01 | Col03 | 0x0001 | 0x0006 | none | Keyboard |
| MI_01 | Col04 | 0xffa0 | 0x0001 | none | Vendor — rejects `HidD_SetFeature` |
| MI_01 | Col05 | 0xffff | 0x0001 | none | Vendor — rejects `HidD_SetFeature` |
| **MI_02** | — | **0xffff** | **0x0000** | **0** | **Config channel** |

The config channel is MI_02. It accepts exactly one feature report buffer
size, 65 bytes: report id 0 plus the 64-byte CompX packet. The two vendor
collections on MI_01 accept no feature report of any length tried
(65/64/33/17/9/5).

The "feature report ids" column is what `navigator.hid` reports, read back
from both connections with a WebHID enumeration in Chrome on the same Windows
box. It matters because the driver's `isSupported()` decides on exactly that
field, not on whether a collection answers `HidD_SetFeature`: **only
0xffff/0x0000 declares report 0**, so MI_01's 0xffff/0x0001 collection — the
one a usage-page filter cannot exclude — is rejected by the driver rather
than becoming a dead picker entry.

Chrome on Windows delivers all seven collections on a **single `HIDDevice`**,
for the receiver and for the cable alike, so each connection is one entry in
the browser picker no matter how the filter is written. The usage-page
narrowing therefore earns its keep only on a platform that exposes a device's
interfaces separately.

## Protocol

The Inca answers the **existing CompX framing unchanged** — the same
`compaxEncodeRequest` header (`status, _, target, length, page, command`),
report id 0, 64-byte packet, and `0xa1` OK status the Maya X and KO-ONE use.
Mouse target `0x02` and dongle target `0x00` both answer, so no `mouseTarget`
override is needed.

## Raw read responses

Profile 1, payload bytes after the 6-byte header.

| Read | Target | Page | Cmd | Payload |
| --- | --- | --- | --- | --- |
| Dongle firmware | 0x00 | 0x00 | 0x81 | `00 00 00 12 00 37 b0 00 10 00 00 00 00 00 00 00` |
| Mouse firmware | 0x02 | 0x00 | 0x81 | `00 00 00 12 00 09` |
| Battery | 0x02 | 0x00 | 0x83 | `00 64` |
| Active profile | 0x02 | 0x00 | 0x85 | `01` |
| Sleep timeout | 0x02 | 0x00 | 0x87 | `01 00 3c` |
| Debounce | 0x02 | 0x00 | 0x88 | `01 00` |
| Polling rate | 0x02 | 0x01 | 0x80 | `01 40` |
| DPI stages | 0x02 | 0x01 | 0x81 | `01 05 01 90 01 90 07 d0 07 d0 06 40 06 40 0c 80 0c 80 19 00 19 00` |
| Active stage | 0x02 | 0x01 | 0x82 | `01 02` |
| Angle snapping | 0x02 | 0x01 | 0x84 | `01 00` |
| Lift-off distance | 0x02 | 0x01 | 0x88 | `01 01` |
| Motion sync | 0x02 | 0x01 | 0x89 | `01 00` |
| Ripple control | 0x02 | 0x01 | 0x8a | `01 00` |
| Hyper mode | 0x02 | 0x01 | 0x8b | `01 00` |
| Separate axes | 0x02 | 0x01 | 0x8d | `01 00` |
| Competitive mode | 0x02 | 0x01 | 0x93 | `01 00` |

The dongle firmware payload echoes the vendor and product id at bytes 5-8
(`37 b0 00 10`), which is a useful sanity check that the reply belongs to this
receiver.

## Decoding

Every existing CompX decoder produces a sensible value with no change:

- `compaxDecodeFirmware` → dongle `0.18`, mouse `0.18`.
- Battery → `0x64` = 100%.
- `compaxDecodePollingRate` with `LAMZU_POLLING_RATES` → `0x40` = 4000 Hz.
- `compaxDecodeDpiStages` → 5 stages, **read directly as big-endian DPI with
  no ×50 scaling**: 400, 2000, 1600, 3200, 6400. The ×50 and (raw+1)×50
  readings give absurd values (20000+, 320000), so the direct reading is the
  correct one.
- `compaxDecodeLiftOff` → `0x01` = 1 mm = "Medium".
- `compaxDecodeSleep` → `0x003c` = 60 s.
- Debounce → 0 ms.

Active stage reports `2`. "Confirmed by the owner" below settles this as
1-based — the second stage, 2000 DPI.

## Wired capture

Same mouse on its cable, product id `0x0009`, same MI_02 config channel.
The WebHID enumeration shows the cable carrying the identical seven
collections as the receiver, with report 0 again declared only on
0xffff/0x0000. Both target `0x00` and target `0x02` answer identically, so no
`mouseTarget` override is needed for either connection.

| Read | Payload | Decoded |
| --- | --- | --- |
| Firmware | `00 00 00 12 00 09` | 0.18 |
| Battery | `01 64` | 100%, charging |
| Polling rate | `01 01` | `0x01` = 1000 Hz |
| DPI stages | identical to the wireless capture | 400, 2000, 1600, 3200, 6400 |

The firmware payload's byte 5 is `0x09` — the mouse's own product id, the same
way the dongle's reply carries `37 b0 00 10`.

**This settles the rate families.** `LAMZU_POLLING_RATES` encodes 1000 Hz
twice: `0x01` in the 125/250/500/1000 family and `0x10` in the
1000/2000/4000/8000 family. The cable answered `0x01` and the 8K receiver
answered `0x40`, so the two connections genuinely run different families —
`RATES_1K` wired, `RATES_8K` wireless.

## Cross-check against Lamzu's own configurator

The Aurora desktop app carries a device table with an `INCA` record. Nothing
was copied from it into the driver; it was read only to confirm values and to
learn the product ids that are not on hand. Every overlapping value agrees
with what the hardware reported:

| Aurora field | Value | Agrees with |
| --- | --- | --- |
| `PIDWired` | `0009` | The wired capture |
| `PIDWireless4K8K` | `0010` | The receiver capture |
| `DPIMax` | `30000` | The driver's existing default |
| `PollingRateWired` | `125;250;500;1000` | `RATES_1K` |
| `_8KDonglePollingRate` | `500;1000;2000;4000;8000` | `RATES_8K` |
| `LOD` | `0.7;1;2` | The driver's `0x87`/`0x01`/`0x02` → Low/Medium/High table |
| `SleepTimeGrade` | `10s;30s;1min;5min;10min;30min` | The driver's `SLEEP_SECONDS` |
| `DPIMaxStageNum` | `5` | The five stages read back |

The lift-off and sleep rows are worth noting: the existing decoders were
written for other CompX mice, and the Inca's vendor-declared options land on
them exactly, with no new cases.

## Confirmed by the owner

- Active stage reported `2` resolves to the **second** stage, 2000 DPI: the
  owner had set that stage to 2000 by hand (its default is 800, and 2000 is
  not a preset option). That confirms the reported index is 1-based and that
  DPI is read straight off the wire as big-endian, unscaled.
- The mouse was on 4000 Hz on the receiver and 1000 Hz on the cable.

## Still to confirm

- The 1K receiver (`0x000f`) has not been seen; its rate list comes from the
  vendor table alone.
- Writes are entirely uncaptured. Nothing here was verified by changing a
  setting, so every setter this driver inherits is still unproven on an Inca.
