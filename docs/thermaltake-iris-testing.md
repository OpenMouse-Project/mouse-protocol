# Tt eSPORTS Iris Optical RGB

`264a:1019`, product string "Iris Optical RGB". The Hatsune Miku Edition is the
same mouse in a different shell; it enumerates with the same IDs and string.
Two vendor builds drive it: the Iris module of "Command Center Pro" (firmware
target 9) and the standalone Miku Edition "Iris" app (firmware target 128,
`SFVER` V1.0017). Their `HIDLib.dll` is identical and their profile layout
matches; the Miku build only adds lighting presets.

## Interfaces

Read with `HidP_GetCaps` on Windows 10 (bcdDevice `0x6901`):

| Interface | Collection | Reports |
| --- | --- | --- |
| 0 | Generic Desktop Mouse | input 10, **feature 9 (unnumbered, page 0xFF00 usage 0x80, 8 bytes)** |
| 1 col01 | Generic Desktop Keyboard | input 10, output 2 |
| 1 col02 | Consumer Control | input 3 |
| 1 col03 | **LED page 0x08, usage 0x4B** | input 28, **feature 2053** |
| 1 col04 | Generic Desktop Mouse | input 5 |

Every feature report on col03 is 2052 bytes after the report id. Interface 0's
8-byte feature report reaches the same command parser.

## Command channels

- **col03, reports 0x0C / 0x05 / 0x06 / 0x04** (2052 bytes): everything,
  including whole profile blocks.
- **Interface 0, unnumbered 8-byte report**: the same commands truncated to
  8 bytes, with the reply status first (`B0 …`). Verified on hardware:
  `C4 08` → `B0 55 AA 80`, `DF 0D` → `B0 C0 0D 00 00 5p`, and
  `DE 0D 00 00 5p` switched to profile 2 and back (read back each time).
  Profile blocks do not fit, so DPI, polling and every other profile setting
  cannot travel this way.

`DF r` reads a one-byte system register; `DE r 00 00 v` writes one. Read on
this unit: `00`=`80` (firmware), `01`=`01`, `02`=`06`, `03`=`01`, `04`=`00`,
`05`=`4F`, `06`=`19`, `07`=`00`, `08`=`5E`, `09`=`3F`, `0A`=`00`, `0B`=`00`,
`0C`=`1F`, `0D`=`50` (profile count 5 in the high nibble, active profile in
the low one). Everything from `0E` up reads `FF`. Only `0D` is used by the
vendor tool; the rest are not decoded.

## Windows

col03 declares only Constant items: `HidP_GetButtonCaps` and
`HidP_GetValueCaps` return nothing for input or feature, although
`HidP_GetCaps` still gives the 28-byte input and 2053-byte feature lengths.
Native `HidD_SetFeature` / `HidD_GetFeature` on it work.

- **Chrome on Windows** (checked on 156) builds `HIDDevice.collections` from
  those caps, so col03 ends up with no reports and is pruned; interface 1
  shows only the consumer collection (`0x0C/0x01`, input `0x02`). Chrome also
  routes a report id to the collection that declares it, so a feature report
  to `0x0C` or `0x05` has nowhere to go. This is the same wall as the Delux
  M600 Pro (`delux-m600-pro-testing.md`). Interface 0's 8-byte report does
  have caps, and Chrome does not protect feature reports on a mouse
  collection, so the driver uses it for firmware, the active profile and
  profile switching.
- **OpenMouse Bridge** (v1.0.0-beta.20) lists col03 as `0x08/0x4B` with an
  input report 0 and no feature reports, from the descriptor hidapi rebuilds.
  Bridge sends an undeclared feature report to every path, but
  `receive_feature_report` refuses one no path declares (only Razer and
  Microsoft have a fallback buffer), so reads fail with "feature report 12 is
  not declared by this interface". A fallback buffer of 2053 bytes for vendor
  `0x264a` would unblock it.

## Evidence

The protocol was recovered statically from the vendor's managed `Iris.dll`
and `HIDLib.dll` (profile layout in `FLASH`, slider conversions in the Iris
page, lighting in `LEDSETPATH`, buttons in `ButtonSet`, report framing in
`HIDLib.Functions`). No vendor code is included here.

## Verified on hardware (Miku Edition, firmware byte 0x80)

- `C4 08` returns `B0 55 AA 80`.
- `DF 0D` returns `B0 C0 0D 00 00 5p`: five profiles, active profile `p`.
- `C4 0C p` then a 0x05 read returns `05 B0 p <checksum> <2048 bytes>` for all
  five profiles, each with a valid checksum.
- Polling write on the active profile: `C4 10`, 0x05 write with the byte at
  offset 0 changed from `01` to `02`, `C4 00`. The read-back matched the
  intended block byte for byte, and writing the original block back restored
  it byte for byte.
- Profile switching over interface 0's 8-byte report, as above.

Run the vendor software and a WebHID page at the same time and their commands
interleave; close the Iris app (`IrisMain`) first. It also rewrites the active
profile when it starts.

## Not verified

- 1500 Hz (`0x10`): the vendor tool writes it but reads it back as 1000 Hz.
  2000 Hz (`0x00`) was found stored on one profile, so the firmware accepts it,
  but the delivered report rate was not measured.
- Angle snapping and button response were decoded but not written on hardware.
- The WebHID path itself on Chrome for Windows: the 8-byte frames were sent
  natively with `HidD_SetFeature` exactly as the driver sends them, but not
  from a browser tab.

## Lighting (decoded, not implemented)

Lighting lives in each profile from offset 160 to 1898. Zones, each a block of
mode, brightness, speed and colour fields:

| Block start | Zone |
| --- | --- |
| 160 | Logo and wheel (shared; the wheel has no block of its own) |
| 305, 450, 595, 740, 885, 1030, 1175 | The seven side LEDs |
| 1320 | Sync (all LEDs) |

Byte 0 of a zone block is its effect; the sync block's byte 0 holds the effect
plus `0xE0` when sync is on. Per zone, colours sit at `+2..+4` for the static
effect; other effects keep their colours, brightness and speed in sub-blocks
(`+5`, `+53`, `+96` from the zone start for the logo; `1325`, `1373`, `1416`,
`1465`, `1513`, `1561` for sync). The vendor tool reads and writes some of
those sub-blocks at different offsets (colours for effects 5 to 8 are written
at `+5` and read at `+9`), so the exact layout needs a capture of the tool
changing one effect at a time before anything is written.

`C4 16 E1 FF R G B` sets a colour live without touching flash (the vendor uses
it for previews and the CPU-temperature mode); it fits the 8-byte report.

The Miku build's preset colours: `78 FE F4`, `FF 22 B8`, `31 DC AD`,
`3E 9F 80`.

## Buttons (decoded, not implemented)

Eighteen 5-byte slots per profile at offsets 48, 53, … 133:
`[type, p1, p2, p3, p4]`.

| Type | Meaning |
| --- | --- |
| 0 | `p1` 0: scroll up, 1: scroll down |
| 1 | Mouse button, `p1` bitmask: 1 left, 2 right, 4 middle, 8 back, 16 forward |
| 2 | Keyboard, `p1` modifier mask, `p2` HID usage (e.g. `01 06` copy, `01 19` paste, `04 2B` Alt+Tab, `08 07` show desktop) |
| 3 | Consumer, `p1`/`p2` usage little-endian (`E9` volume up, `EA` down, `CD` play/pause, `B5` next, `B6` previous, `E2` mute, `183` media player, `223` browser home) |
| 4 | Double click |
| 6 | Macro (stored separately, see below) |
| 9 / 10 | DPI stage up / down |
| 11 / 12 | DPI stage cycle up / down |
| 13 / 14 | Profile cycle up / down |
| 15 | Launch program (path kept by the vendor tool in the registry, not the mouse) |
| 16 | Temporary DPI |

The default profile maps slot 0 to left, 1 to right, 2 to middle.

## Macros (decoded, not implemented)

Forty macro blocks of 2048 bytes (8 per profile, index `profile * 8 + slot`),
read with `C4 0B index` then report 0x04 and written as report 0x04
`[04, 0, index, checksum, block]`. Block header: `+64` execution mode, `+65`
loop count, `+66` time unit, `+67..68` event length (little-endian), `+69`
name length, `+70..` UTF-16LE name, events from `+120` (up to 1992 bytes,
5000 ms delay limit per step). The event encoding is in the vendor's
`Macro.cs` and still needs a capture to confirm.
