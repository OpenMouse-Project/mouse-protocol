# Tt eSPORTS Iris Optical RGB

`264a:1019`, product string "Iris Optical RGB". The Hatsune Miku Edition is the
same mouse in a different shell; it enumerates with the same IDs and string.
Thermaltake ships no Miku-specific software, and the Iris module of
"Command Center Pro" drives it unchanged.

## Interfaces

Read with `HidP_GetCaps` on Windows 10 (bcdDevice `0x6901`):

| Interface | Collection | Reports |
| --- | --- | --- |
| 0 | Generic Desktop Mouse | input 10, feature 9 |
| 1 col01 | Generic Desktop Keyboard | input 10, output 2 |
| 1 col02 | Consumer Control | input 3 |
| 1 col03 | **LED page 0x08, usage 0x4B** | input 28, **feature 2053** |
| 1 col04 | Generic Desktop Mouse | input 5 |

Every feature report on col03 is 2052 bytes after the report id. The driver
filters on that collection only.

## Evidence

The protocol was recovered statically from Command Center Pro's managed
`Iris.dll` and `HIDLib.dll` (profile layout in `FLASH`, slider conversions in
the Iris page, report framing in `HIDLib.Functions`). No vendor code is
included here.

## Verified on hardware (Miku Edition, firmware byte 0x80)

- `C4 08` returns `B0 55 AA 80`.
- `DF 0D` returns `B0 C0 0D 00 00 5p`: five profiles, active profile `p`.
- `C4 0C p` then a 0x05 read returns `05 B0 p <checksum> <2048 bytes>` for all
  five profiles, each with a valid checksum.
- Polling write on the active profile: `C4 10`, 0x05 write with the byte at
  offset 0 changed from `01` to `02`, `C4 00`. The read-back matched the
  intended block byte for byte, and writing the original block back restored
  it byte for byte.

Run the vendor software and a WebHID page at the same time and their commands
interleave; close Command Center Pro (`IrisMain`) first. It also rewrites the
active profile when it starts.

## Not verified

- 1500 Hz (`0x10`): the vendor tool writes it but reads it back as 1000 Hz.
  2000 Hz (`0x00`) was found stored on one profile, so the firmware accepts it,
  but the delivered report rate was not measured.
- Angle snapping and button response were decoded but not written on hardware.
- Profile switching (`DE 0D 00 00 5p`) was not exercised.
- Lighting (offsets 160..1898), button mapping and macros are not decoded.
