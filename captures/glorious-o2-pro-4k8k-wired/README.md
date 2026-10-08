# Glorious Model O 2 PRO 4K/8K, wired

Reference material for `src/glorious-core2/index.ts` and
`src/drivers/glorious/core2-hid.ts`. From a community USBPcap capture
(ticket-0160, Windows, 2026-10-08): Glorious CORE talking to a Model O 2 PRO
4K/8K on its cable (USB `0x258a:0x201b`) while the owner stepped through its
settings. Only the mouse's configuration interface and its DPI button reports
are included. The other USB devices on that bus (two ASUS lighting controllers)
and all pointer traffic were left out. No serial numbers or personal data.

| File | Trust | What it is |
|-|-|-|
| `core-session.hex` | Vendor capture | Every frame on interface 2 (usage page `0xffff`, usage 0, unnumbered 64-byte feature reports): 116 requests (22 distinct) and the 41 replies CORE read. `src/drivers/glorious/core2-protocol.test.ts` re-encodes all 116 requests byte for byte. |
| `dpi-button-reports.hex` | Vendor capture | 11 input reports (report 4) on interface 1, sent by the mouse when its DPI button was pressed in the first 41 s, before CORE wrote anything. Layout `01, stage (1-based), DPI X (u16 BE), DPI Y (u16 BE), 00 00`. The test checks every one against the stage table CORE wrote later. |

## What the owner did

The capture has no labels, so this is read off the frames. CORE re-sends its
whole performance block after every change (7 requests, 30 ms apart), so only
the field that moved says what the owner touched:

| Seconds | What changed |
|-|-|
| 5.8 | CORE starts: firmware read. Battery read every 10 s from here, 100 % and not charging. |
| 14 to 41 | DPI button pressed on the mouse, stages 1 to 4 cycle. |
| 57 to 114 | Polling rate stepped 125, 250, 500, 1000, 2000, 4000, 8000 Hz (`08, 04, 02, 01, 20, 40, 80` in both polling bytes). |
| 120 | Polling bytes become `80 40`: 8000 Hz wired, 4000 Hz wireless. |
| 124 to 133 | Motion sync off, then on again (register `0x09` goes 1, 0, 1). |
| 141 to 160 | Debounce stepped 4, 8, 12, 16 ms (register `0x08`, first byte after the profile). |
| 168 | Advanced debounce switched on: `00 00 0a 0a 08` (CORE's defaults 0, 0, 10, 10, 8). |

Every request carries profile `2`: CORE had its second profile selected. A
capture from a Model D2 Pro 4K in the GloriousAutoPollingRate project carries
profile `1`.

## What the registers are

The 7 requests of a burst, with what each one is. The frame layout is in the
header comment of `src/glorious-core2/index.ts`. The names come from the code of
Glorious CORE 2.1.21 itself (`MouseV2ProDeviceHandler`, which also drives the
Model O/D Wireless that korkje/mxw documents); the capture fixes the bytes, the
code fixes the meaning.

| Order | Bank, register | Data after the profile byte |
|-|-|-|
| 1 | 1, `0x01` | DPI stage count, then X and Y as u16 BE per stage |
| 2 | 2, `0x01` | six RGB triplets, the stage LED colors |
| 3 | 1, `0x0b` | lift-off value; CORE writes 1 for both its 1.0 mm and 2.0 mm options, so the value to distance map is unknown |
| 4 | 1, `0x02` | active DPI stage, 1-based |
| 5 | 1, `0x0a` | polling code for the cable, polling code for 2.4 GHz |
| 6 | 0, `0x08` | debounce: `ms, 0, 0, 0, 0, 0`, or in advanced mode `beforePress, beforeRelease, afterPress, afterRelease, liftOffPress, 0` |
| 7 | 1, `0x09` | motion sync, 1 on, 0 off |

Reads: bank 0 register `0x81` answers firmware `1.0.15.0` then the wired
product id `0x201b`; register `0x83` answers charging flag and percent. The
reply to a write is the request echoed with status `0xa1`, and CORE only reads
it after the last frame of a burst.

## Not captured yet

- **Any read of a setting.** CORE never reads one, and no command for it is
  known, so the driver shows the last values it wrote.
- **The HID report descriptors.** The capture started after enumeration. The
  driver finds the config channel by shape (a feature report with id 0 on usage
  page `0xffff`), which is how CORE's own device table describes it.
- **The receiver (`0x2035`).** No traffic. The frames are the same ones CORE
  sends over either link (GloriousAutoPollingRate captured the D2 Pro 4K
  receiver doing so); only the firmware read differs, target byte 0 instead
  of 2, from CORE's code.
- **The profile select frame** (bank 0, register `0x05`), which CORE and mxw
  agree on. CORE had already selected profile 2.
- **Lighting, buttons, macros and auto sleep.** Not exercised.
- **8000 Hz on the 2.4 GHz link.** CORE wrote it once (`80 80`) and then
  settled on `80 40`; the product page gives 4000 Hz as the wireless maximum.
