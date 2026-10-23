# Cosmic Byte Kilonova 3335IC (SiNoWealth `258a:002f` receiver)

Identity: Cosmic Byte Kilonova 3335IC, its 2.4 GHz dongle enumerates as
SINOWEALTH `258a:002f` (the M690 PRO receiver's product id), Windows 11,
probed with node-hid in a scratch script. The wired id of this device (if it
has one and whether it is `258a:002e`) is unknown; every capture below is
through the receiver while the mouse was awake and linked, battery at
70 % as the mouse itself reported it.

The dongle is the first decoded member of the same framing as the Redragon
M690 PRO (`src/redragon/m690-pro.ts`, libratbag's `driver-sinowealth.c`):
short commands on feature report 5, banks on feature report 8, and the
settings bank's `a5 00` end marker. What differs is the footprints inside the
banks, so `@openmouse/protocol/sinowealth` lists it as a profile next to the
M690 PRO's, and the M690 PRO client narrows to read-only for it.

## USB shape

`hidapitester --list-detail` shows one device, two interfaces:

- `MI_00` on interface 0: the mouse itself (usage `0x0001:0x0002`).
- `MI_01` on interface 1: six collections in this order — `Col01` keyboard
  (`0x0001:0x0006`), `Col02` consumer (`0x000c:0x0001`),
  `Col03`/`Col04`/`Col05` vendor (`0xff00:0x0001`, identical layout to the
  M690 PRO command collection: feature report 5, 7 bytes; `Col03` carries
  report 8, 519 bytes), and `Col06` (`0xff01:0x0001`).

The report descriptor of each vendor collection is byte-identical to the
M690 PRO's (`06 00 FF 09 01 A1 01 85 05 19 01 29 02 15 00 26 FF 00 75 08
95 07 B1 02 C0`). Col03 answers the bank reads, Col05 accepts and reads the
short commands — the same roles the M690 PRO test fixture records.

## Captures (read-only; feature reports as node-hid returns them, id first)

The session's raw feature reports are in
`captures/cosmic-byte-kilonova-3335ic/probes-receiver.hex`. Summary:

| Command | Answer | Meaning |
| --- | --- | --- |
| `[05 01 00 00 00 00 00 00]` | `[05 01 32 33 31 35 00 00]` | identify: ASCII `"2315"` (M690 PRO: `"2945"`) |
| `[05 80 00 00 00 00 00 00]` | `[05 80 01 01 00 00 00 00]` | link: mouse linked and awake |
| `[05 90 00 00 00 00 00 00]` | `[05 90 11 46 00 00 00 00]` | status: wireless (byte 2 bit 0), battery 0x46 = 70 % |
| `[05 21 00 00 00 00 00 00]` | 154 bytes | settings bank |
| `[05 22 00 00 00 00 00 00]` | 88 bytes | button bank: `08 22` then all zeros |

The settings bank, report id included:

```
08210000000000006411043600030007000f001f003f009f0000000000000000
00000000000000000000000000ff000000ff000000ffffff0000ffffff00ff00
00000000000543004000ff004207ff000000ff000000ff00ffffffff00fa00fa
ffffff034240ff000000ff000000ffffff0000ffffffffff0000000000000000
000000004200ff00ff0000424202ff000000000000ff0000a500
```

## Observed facts

- Bank lengths match the M690 PRO's (154 settings, 88 buttons), byte 8 is
  0x64 as on every M690 PRO bank read, and the `a5 00` end marker sits at
  152-153.
- The M690 PRO disambiguator holds: byte 9 is 0x11 (the M690 PRO's model
  byte is 0x13), and identify answers "2315" against the M690 PRO's "2945".
  When OpenMouse connected through Chrome, the same model byte reached the
  app (the browser cannot read report 5's short answers, so the bank is the
  browser-viable footprint — see `src/drivers/redragon/m690-pro-hid.ts`).
- Byte 10 is 0x04: in the M690 PRO's polling-code map that is 1000 Hz. The
  rate was not measured (Windows refuses the input interface while a mouse
  session holds it), so nothing decodes it for this device yet.

## Hypotheses (not implemented)

- The bytes after the model byte may follow the M690 PRO's meaning (stage
  table at 0x0d, colours at 0x2d, effects at 0x45): byte 11 is 0x36, which
  would read as "5 stages, stage 2 active" on the M690 PRO. The stage bytes
  that follow (`00 07 00 0f 00 1f 00 3f 00 9f`) do not name that list's
  1..24 positions (159, 255 are impossible positions), so the mapping or
  the offsets differ. Nothing is decoded and nothing is written until a
  toggle-diff capture of the vendor's software says otherwise.
- The zero-payload button bank may keep the M690 PRO's four-byte slot grid
  at the factory defaults; configuring the vendor's own settings would show
  the slots. Not decoded yet.

## What OpenMouse does with this

`RedragonM690ProHidClient` recognizes `258a:002f` by shape (unchanged), and
its settings-block check now resolves a profile. On a Kilonova 3335IC it
reports the device as "Cosmic Byte Kilonova 3335IC", keeps battery and link
(when the transport can read report 5, it behind OpenMouse Bridge in a
browser), hides the settings grid and refuses every write path, instead of
refusing the device the way it refuses a truly foreign bank.

## What would unlock the rest

- The vendor's settings application captures (toggle each setting once)
  to map the stage/DPI table, colours and buttons; same work as the M690
  PRO's first pass.
- The cable id (`258a:002e` or another) and one wired session to see whether
  the status command answers charge codes like the M690 PRO's cable bank.
- A measurement of the polling rate at each vendor application setting to
  pin the byte-10 map.
