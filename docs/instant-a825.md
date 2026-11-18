# Instant A825 / Sades Kaze protocol

This document describes what is known about the Instant A825 control protocol
as used by the Sades Kaze. It separates behaviour observed on the device from
behaviour read out of the vendor binary.

## Device

- Vendor: Wuxi Instant Microelectronics (A825 chipset).
- Sades model: Kaze, `Sades Kaze (Instant A825)`.
- USB: VID `0x30FA`, PID `0x1440` (tested unit); vendor configuration also
  lists PID `0x1E01`. Public A825 research lists PID `0x7F7F`.
- Product string: `USB GAMING MOUSE`; manufacturer string: `INSTANT`.
- Control collection: usage page `0xFF01`, usage `0x01`, interface 1.
- The collection exposes one feature report, report ID `0x07`. Windows reports
  a feature report length of 8 bytes.
- The same report returns a 32-byte status block; the device accepts
  `HidD_GetFeature` with a 32-byte buffer and fills the first 19 bytes.

The A825 datasheet states: 32 KB storage, six CPI levels selected from 23
values (`200 … 12800`), four configuration groups, report rates
125/250/500/1000 Hz, and ten backlight effects.

## Transport

Commands are 8-byte feature reports:

```
07 <command> <p1> <p2> <p3> <p4> <p5> <p6>
```

Status read on report 7 returns:

```
07 <state> 54 09 27 00 03 CB 11 <n> 00 <cpiLo> <cpiHi> 00 00 10 24 5A A5 ...
```

`54 09` is the build word `0x0954`. Bytes 17-19 are the fixed marker
`24 5A A5`. `state` and `n` change with device activity.

## Block access

Command `0x18` accesses a 16-bit, little-endian addressed configuration
memory. Writing a block:

```
07 18 03 <index> <addrLo> <addrHi> <data> <length-1>
07 18 09 00      <addrLo> <addrHi> 00     <length-1>
07 18 00 00      <addrLo> <addrHi> 00     00
```

Reading a block:

```
07 18 03 00 <addrLo> <addrHi> 00 <length-1>
07 18 00 00 <addrLo> <addrHi> 00 00
07 18 05 <index> <addrLo> <addrHi> 00 <length-1>   → reply byte 1
07 18 00 00 <addrLo> <addrHi> 00 00
```

`07 18 10` enters and `07 18 00` leaves the mode the vendor app uses after a
save.

Verified on the Kaze: the byte at `0x3A` read as `0x0B`; a block write set it
to `0x0A`; a read returned `0x0A`; restoring `0x0B` read back `0x0B`.

## Stored configuration image

`0x0000-0x0FFF` was read byte by byte. Non-empty regions:

- `0x0000-0x008F` — device configuration (see below).
- `0x0400-0x04FF` — repeated 32-byte records beginning
  `01 00 BB E3 7F 00 FC 08 06 E3 14 08 00 00 00 00`.
- `0x0500-0x0FFF` — `FF` fill with `00 00` at every `0x100` boundary.

The tested unit's `0x0000-0x008F`:

```
0000: 5A 03 A5 40 14 FA 30 00 21 22 23 24 25 26 20 15
0010: 00 00 00 32 08 41 DF 18 19 3F 06 00 F3 FF 00 00
0020: 00 02 DF EF 5F 00 00 FF 41 FD 10 DF 00 FF FF FF
0030: 10 10 FF 3F 00 00 00 00 00 00 0B 00 00 00 00 00
0040: 00 00 00 61 21 22 23 24 25 26 20 15 00 00 00 00
0050: 21 22 23 24 25 26 20 15 00 00 00 00 00 00 00 00
0060: 21 22 23 24 25 26 20 15 00 00 00 00 00 00 00 04
0070: 08 04 10 04 18 04 41 00 00 20 04 A0 0F 0D 01 02
0080: 00 18 94 49 09 14 24 09 13 0A 09 08 00 00 00 00
```

The vendor app's saved-image writer (`0x480B00`, named
`A825_WriteLightingConfig` in the analysis database) writes these blocks:

| Address | Length | Meaning (from code) |
| --- | --- | --- |
| `0x0000` | 2 | Header |
| `0x0007` | 25 | Key map |
| `0x001C` | 2 | Stage-enable mask and flags |
| `0x0020` | 8 | Stage colours A |
| `0x0028` | 8 | Stage colours B |
| `0x0030` | 4 | Sensor options |
| `0x003A` | 1 | Lighting direction/symmetry |
| `0x003E` | 2 | Lighting |
| `0x0F80` | 2 | Trailer |

`0x3A` holds
`((direction & 3) + (symmetry + flag * 2) * 4) * 16 + (count - 1)`.
It is not the polling rate.

## Polling rate

The full configuration builder (`0x481400`, `A825_BuildConfigImage`) assembles
records keyed by their byte offset. Record `0x14` is:

```
(((byte[0x8104] & 3) * 2 + (byte[0x8298] & 1)) * 2
  + (byte[0x829D] & 1)) * 2 + (byte[0x829C] & 1)
```

The top two bits (`byte[0x8104] & 3`) are a 2-bit field. Writing all four
values to `0x14` read back correctly, but the measured report cadence stayed
at ~125 Hz for every value, so this field is **not confirmed** as the polling
rate; it may be applied only on save/reconnect or be a different setting.

The complete 80-entry record table is in
[a825-config-records.md](./a825-config-records.md).

## DPI

`A825_LiveDpiAndButtons` (`0x486630`) sends:

```
07 12 <DPI/8> 00 00 00 00 00          when mode == 0
07 12 <DPI/16 high> <DPI/16 low> …    otherwise
07 11 00 00 00 00 00 00              commit
07 09 …                              four button-map frames
```

The 23 DPI gears are:

```
200 400 600 800 1000 1200 1400 1600 1800 2000
2400 3200 4000 4800 5600 6400 7200 8000 8800 9600
10400 11200 12800
```

Sending `0x12` on the Kaze did not change the stored image or the status
block. The six-stage CPI table was not found in `0x0000-0x0FFF`.

## Lighting

`A825_WriteLightingConfig` writes the stage colours and the `0x3A`/`0x3E`
fields. `A825_ApplyLighting` (`0x469EB0`) collects `light_color`,
`light_color_en`, `light_brightness`, `light_speed`, `light_symmetry` and
`light_direction` from the vendor profile and calls the writer.

The vendor app's Apply also sends `07 13 7F <byte> 00 00 20 07` from the
profile switch (`0x402700`).

## Vendor Apply capture

The Apply button writes 32-byte blocks from `0x0000` to `0x02C0`, then
`0x0F80`, then enters/leaves block mode:

```
0000: 5A 03
0007: 00 21 22 23 24 25 26 20 15 00 00 00 32 08 41 DF 18 19 3F 06 00 F3 FF 01 00
0020: 00 02 DF EF 5F 00 00 FF 41 FD 10 DF 00 FF FF FF 10 10 FF 3F 00 00 00 00 00 00 0B ...
0040..02C0: 32-byte blocks
0F80: 00 00
07 18 10 00 00 00 00 00
07 18 00 00 00 00 00 00
```

## Evidence status

| Claim | Evidence |
| --- | --- |
| VID/PID, collection, report ID 7, 8-byte feature reports | Device + Windows HID caps |
| 8-byte command frames accepted | Device |
| Block read/write framing and read-back | Device |
| Stored image contents `0x0000-0x0FFF` | Device |
| `0x3A` lighting fields | Vendor code (`0x480B00`) |
| Rate field `byte[0x831A] & 3` | Vendor code (`0x481400`) |
| DPI `0x12` encoding | Vendor code (`0x486630`) |
| Apply block sequence | Captured from the vendor app |

## Devices

The A825 is a chipset, not a model. The vendor's generic reference build is
`Instant A825 Gaming Mouse` (`instant-sys.com`, 2025-07-16) and is the same
`New825Tab` codebase as the Sades OEM build. Public listings of A825 mice:

- Sades Kaze (Instant A825) — tested unit.
- Ant Esports GM320 — public reverse-engineering project.
- AJAZZ NJ08.
- Kreo Harpy.
- Cybeart Ghost.

The protocol in this document is the vendor reference implementation, so it
applies to the same firmware family rather than only the Kaze.

## Open questions

- Record-to-address mapping in `A825_BuildConfigImage`, including record 7.
- The six-stage CPI table location.
- Button-map and lighting encodings beyond the frames listed here.
