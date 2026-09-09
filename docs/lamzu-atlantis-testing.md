# Lamzu Atlantis (0x3554) — capture notes

Hardware report from a **Lamzu Atlantis Mini 4K**, firmware `1.24`, on its
cable, Windows 11. Serial numbers are redacted. Reads were captured first; the
setter pass at the end changed one value at a time and restored each.

## Enumeration

`LAMZU Atlantis Pro`, manufacturer `compx`, release `0x0124` (BCD — firmware
1.24, the version Lamzu's download page lists for "ATLANTIS MINI PRO/4K").
The 4K receiver enumerates separately as `LAMZU 4K Receiver`, release `0x0128`,
matching that page's "4K DONGLE 1.28".

Vendor id `0x3554` is CompX's shared ODM id — the same one the Pulsar 4K
receiver, VGN and Teevolution units already in this repository use, and the
one `ATK_COMPX_PRODUCT_IDS` covers for VXE. It is **not** either of the Lamzu
ids the other driver handles (`0x373e`, `0x37b0`).

| Product id | Role | Verified |
| --- | --- | --- |
| `0xf50f` | Mouse on its cable | On hardware |
| `0xf50d` | 1K receiver | Vendor table only |
| `0xf510` | 4K receiver | Vendor table only |
| `0xf517` | Receiver | Vendor table only |

Six models share these ids: Atlantis OG V2, Atlantis Mini, Atlantis Mini Pro,
Thorn, Maya and Paro of this generation. Nothing on the wire separates them —
same product id, same USB product string, same firmware version — and Lamzu's
own Windows configurator resolves this by asking the user to pick the model
from a list. The catalog therefore names the family, `Lamzu Atlantis`.

| Interface | Collection | Usage page | Usage | Report 8 | Role |
| --- | --- | --- | --- | --- | --- |
| MI_00 | — | 0x0001 | 0x0006 | no | Keyboard |
| MI_01 | Col01 | 0xff05 | 0x0000 | no | Vendor — rejects writes |
| MI_01 | Col02 | 0xff03 | 0x0000 | no | Vendor — rejects writes |
| MI_01 | Col03 | 0x000c | 0x0001 | no | Consumer control |
| MI_01 | Col04 | 0x0001 | 0x0080 | no | System control |
| **MI_01** | **Col05** | **0xff02** | **0x0002** | **yes** | **Config channel** |
| MI_01 | Col06 | 0xff04 | 0x0002 | no | Vendor — feature report 6 only |
| MI_02 | — | 0x0001 | 0x0002 | no | Mouse |

Chrome's own view of the same mouse, from `navigator.hid.getDevices()`, is
what the driver's `isSupported` actually gates on. It differs from the
platform view above — Windows exposes no report ids for several collections
that Chrome does — and it confirms report 8 is declared in both directions on
the config collection:

| Usage page | Usage | Input | Output | Feature |
| --- | --- | --- | --- | --- |
| 0xff05 | 0x00 | 16 | — | — |
| 0xff03 | 0x00 | 2 | — | — |
| 0x000c | 0x01 | 5 | — | — |
| 0x0001 | 0x80 | — | — | — |
| **0xff02** | **0x02** | **8** | **8** | — |
| 0xff04 | 0x02 | — | — | 6 |

The config channel is the `0xff02`/`0x0002` collection, which matches the
`Interfaceid=1` in the shipped `Config.ini` of Lamzu's Windows app. Every
other vendor collection rejects `WriteFile` with `Incorrect function`.

The `0xff04` collection is a red herring worth recording: it answers
`HidD_GetFeature` on report id 6 with a 32-byte snapshot and accepts
`HidD_SetFeature`, but it does not speak this protocol. Feature reports are
the wrong channel entirely here — the config protocol uses interrupt
output/input reports.

## Protocol

Report id 8, 17 bytes on the wire (16 to WebHID, which supplies the id).

```
 byte  0     command
 byte  1     status, 0 on success
 bytes 2..3  flash address, big endian
 byte  4     payload length
 bytes 5..14 payload
 byte  15    checksum
```

This is the CompX report-8 protocol this repository already implements for
Pulsar's 4K receiver (`src/pulsar/index.ts`), byte for byte: the same
`pulsarPacketChecksum`, the same command ids, the same flash offsets, and the
same 50-step `pulsarVgnDecodeDpi` encoding. The driver imports those rather
than restating them.

Commands answered by the mouse over the cable:

| Command | Name | Reply |
| --- | --- | --- |
| `0x04` | Battery | `64 01 10 82` — 100%, charging, 4,226 mV |
| `0x07` | Write flash | echoes the written field |
| `0x08` | Read flash | up to 10 bytes from an address |
| `0x0e` | Active profile | `00` — 0-based on the wire, 1-based in Lamzu's UI |
| `0x0f` | Set active profile | verified by reading `0x0e` back |
| `0x12` | Firmware version | `01 24` — v1.24 |
| `0x15`, `0x1d`, `0x2b` | Dongle RGB, dongle version, RSSI | status 1 (rejected over the cable) |

Two details that cost time and are easy to get wrong:

- **The battery reply lies about its length.** Byte 4 says `0x02` while four
  bytes follow: percent, charging flag, then the millivolts. Decoding by the
  declared length silently drops the voltage.
- **The percent byte is authoritative.** `lamzu-cfg` derives a percentage
  linearly from the millivolts between 3,050 and 4,200 mV. At 4,239 mV that
  estimate reads 100% where the mouse's own byte, and Lamzu's configurator,
  both said 95%.

### Flash fields

Every offset below was read on hardware. The evidence behind each is not
equal, so the last column says what it actually is:

- **vendor UI** — the value was displayed by Lamzu's configurator for this
  mouse at the same moment, so both the address and its meaning are confirmed.
- **UI diff** — the byte was watched changing as that setting was changed in
  the vendor UI, which is the strongest evidence here.
- **round-trip** — the field was written and read back through this driver.
  That proves the address is writable and stable; it does **not** independently
  confirm the label, which comes from lamzu-cfg's map.

| Address | Field | Encoding | Evidence |
| --- | --- | --- | --- |
| 0 | Polling rate | see below | UI diff |
| 2 | DPI stage count | 1-8 | vendor UI (5 stages) |
| 4 | Active DPI stage | 0-based | vendor UI |
| 10 | Lift-off distance | `1` = 1 mm, `2` = 2 mm | vendor UI |
| 12 + 4n | DPI stage n | `x, y, flags, checksum` | vendor UI |
| 44 + 4n | DPI stage n colour | `r, g, b, checksum` | vendor UI |
| 96 | Button actions | 4 bytes per button | vendor UI (bottom button = DPI Loop) |
| 169 | Debounce | milliseconds, 0-15 | vendor UI |
| 171 | Motion sync | 0/1 | vendor UI |
| 173 | Sleep timeout | **units of ten seconds** | UI diff |
| 175 | Angle snapping | 0/1 | vendor UI |
| 177 | Ripple control | 0/1 | round-trip |
| 181 | Competition mode | 0/1 | vendor UI |
| 183 | Competition timeout | units of ten seconds | round-trip; the unit is inferred from 173 |
| 185 | High performance | 0/1 | round-trip |

A DPI stage stores x and y separately, but the shared `pulsarVgnEncodeDpi`
writes the same byte to both, so a per-axis DPI set in Lamzu's app is
flattened to a single value the first time this driver changes that stage.
Reads report the x axis.

A field is stored with a trailing checksum byte, so the value bytes and that
byte together sum to `0x55`. Reads ask for one byte more than the field is
wide and reject the value if that sum is wrong.

Address 173 is not in `lamzu-cfg`'s map. It was found by diffing the flash
image across a change made in Lamzu's own configurator:

| Sleep setting in the vendor UI | Byte at 173 |
| --- | --- |
| 1 minute | `0x06` |
| 10 seconds | `0x01` |

Addresses 6, 8 and 76-94 hold values this driver does not read and are
deliberately left unmapped rather than guessed at.

### Polling rate

The rate byte carries the same double encoding of 1,000 Hz that the other
Lamzu generations use, so `pulsarDecodePollingRate` is wrong for these units —
it reads `0x10` as 2,000 Hz.

| Byte | Rate | Evidence |
| --- | --- | --- |
| `0x08`, `0x04`, `0x02`, `0x01` | 125, 250, 500, 1000 | Vendor UI wrote `0x02` when set to 500 Hz |
| `0x10` | 1000 | Read from the profile with the vendor UI showing 1000 Hz |
| `0x20`, `0x40`, `0x80` | 2000, 4000, 8000 | Receiver family, from the shared Lamzu table |

The wired path offers 125-1000 Hz; the 4K receiver's list is from Lamzu's
device table and has not been exercised.

## What was verified on hardware

Read, against Lamzu's configurator open on the same mouse: name, firmware
v1.24, battery percent and voltage, charging state, profile, all five DPI
stages and their colours, active stage, polling rate, lift-off, debounce,
sleep timeout, motion sync, angle snapping, ripple control, competition mode,
high performance.

Written, one at a time, each restored afterwards, each confirmed by reading
the field back: polling rate (500 → 125 → 500), lift-off (Low → Medium → Low),
debounce (4 → 6 → 4 ms), sleep (60 → 30 → 60 s), motion sync, angle snapping,
ripple control, competition mode, high performance, active DPI stage
(2 → 0 → 2), DPI stage value (2000 → 1600 → 2000), profile (1 → 2 → 1). A full
re-read afterwards showed no drift in any other field.

Onboard profiles were probed by writing each index and reading it back:
0 through 3 are accepted, 4 and above are rejected with status 1 and leave the
mouse where it was. Hence four profiles, and the mouse was restored to its
original one afterwards.

Not exercised: the three receiver product ids, button remapping, macros, and
the pairing and factory-reset controls the vendor app exposes. DPI above
12,800 — where the stage count no longer fits one byte and the high bits ride
in the flags byte — is covered by a unit test round trip but was never set on
this hardware; the stages exercised were 1,600 and 2,000. No command id
outside the table above was sent: the write path on this firmware includes a
factory reset, so unknown ids were not probed.
