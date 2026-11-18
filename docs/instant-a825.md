# Instant A825

Protocol of the Instant Microelectronics A825 control interface, reverse
engineered from the vendor `DevDock.exe` and verified on a Sades Kaze.

## Identity and connection paths

- Vendor: Wuxi Instant Microelectronics (A825 chipset).
- Tested model: Sades Kaze (Instant A825), wired USB.
- USB: VID `0x30FA`, PID `0x1440`; the vendor configuration also lists PID
  `0x1E01`. Public A825 research lists PID `0x7F7F`.
- Product string `USB GAMING MOUSE`, manufacturer string `INSTANT`.
- Configuration collection: usage page `0xFF01`, usage `0x01`, interface 1.
- Report 7 is the only feature report. Windows reports an 8-byte feature
  report; the same report returns a 32-byte status block.
- Firmware/build word in the status block: `0x0954`.

## Evidence

- `SadesKaze(A825).[20241009].exe` → `DevDock.exe`, product `New825Tab`,
  32-bit MSVC + DuiLib, SHA-256
  `b76c4dff76598dbd8e3874d382ab1875feaa0979754c1e3e5dc12507b8cf1b87`.
- Chip vendor reference build: `Instant A825 Mouse Reference
  Driver.[20250716]` from instant-sys.com, same `New825Tab` codebase with a
  generic `Instant A825 Gaming Mouse` profile.
- Ghidra analysis of the Sades build; the function names below are the
  annotated names in that database. `docs/devdock-functions.md` lists the
  addresses; `docs/a825-config-records.md` lists every configuration record.
- A825 datasheet V1.01 (Instant Microelectronics).

## Transport

Commands are 8-byte feature reports:

```
07 <command> <p1> <p2> <p3> <p4> <p5> <p6>
```

Status read on report 7:

```
07 <state> 54 09 27 00 03 CB 11 <n> 00 <cpiLo> <cpiHi> 00 00 10 24 5A A5 ...
```

`54 09` is the build word `0x0954`. Bytes 17-19 are the fixed `24 5A A5`
marker. `state` and `n` change with device activity.

## Block access

Command `0x18` addresses a 16-bit little-endian configuration memory. Write:

```
07 18 03 <index> <addrLo> <addrHi> <data> <length-1>
07 18 09 00      <addrLo> <addrHi> 00     <length-1>
07 18 00 00      <addrLo> <addrHi> 00     00
```

Read:

```
07 18 03 00 <addrLo> <addrHi> 00 <length-1>
07 18 00 00 <addrLo> <addrHi> 00 00
07 18 05 <index> <addrLo> <addrHi> 00 <length-1>   → reply byte 1
07 18 00 00 <addrLo> <addrHi> 00 00
```

`07 18 10` enters and `07 18 00` leaves the mode the vendor app uses after a
save. `A825_BlockWrite` is `0x455A40`; `A825_BlockMode` is `0x455BA0`.

## Vendor command paths

| Command | Path | Purpose |
| --- | --- | --- |
| `18` | `A825_BlockWrite` / `A825_BlockMode` | Read/write the configuration image |
| `12` | `A825_LiveDpiAndButtons` (`0x486630`) | Live DPI value |
| `11` | `A825_LiveDpiAndButtons` | Commit |
| `09` | `A825_ButtonMap` (`0x486440`), `A825_ButtonMapFrame` (`0x454B30`) | Button map |
| `17` | `A825_KeyCodeFrame` (`0x454BA0`) | 16-bit key/function code |
| `13` | profile switch (`0x402700`) | Lighting/mode |
| `18 10`/`18 00` | `A825_BlockMode` | Enter/leave save mode |

`A825_BuildConfigImage` (`0x481400`) assembles the stored image as
offset/value records. `A825_WriteLightingConfig` (`0x480B00`) writes the
lighting blocks. `A825_ApplyLighting` (`0x469EB0`) collects the lighting UI
and calls the writer.

## Stored configuration

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

`0x0400-0x04FF` holds repeated 32-byte records beginning
`01 00 BB E3 7F 00 FC 08 06 E3 14 08 00 00 00 00`;
`0x0500-0x0FFF` is `FF` fill with `00 00` at every `0x100` boundary.

Blocks written by the vendor application:

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

Record `0x14` of `A825_BuildConfigImage` is:

```
(((byte[0x8104] & 3) * 2 + (byte[0x8298] & 1)) * 2
  + (byte[0x829D] & 1)) * 2 + (byte[0x829C] & 1)
```

Bits 4-3 of this record (`(byte >> 3) & 3`) are a 2-bit field. All four values
were written to `0x14` and read back correctly, but the measured report cadence
stayed at ~125 Hz for every value. The field is therefore not confirmed as the
polling rate; it may be applied only on save/reconnect or be a different
setting.

## DPI

`A825_LiveDpiAndButtons` sends:

```
07 12 <DPI/8> 00 00 00 00 00          mode 0
07 12 <DPI/16 high> <DPI/16 low> …    other modes
07 11 00 00 00 00 00 00              commit
07 09 …                              four button-map frames
```

The 23 DPI gears:

```
200 400 600 800 1000 1200 1400 1600 1800 2000
2400 3200 4000 4800 5600 6400 7200 8000 8800 9600
10400 11200 12800
```

Sending `0x12` on the tested unit did not change the stored image or the
status block. The six-stage CPI table was not found in `0x0000-0x0FFF`.

## Lighting

`A825_WriteLightingConfig` writes the stage colours and the `0x3A`/`0x3E`
fields. `A825_ApplyLighting` collects `light_color`, `light_color_en`,
`light_brightness`, `light_speed`, `light_symmetry` and `light_direction`.
The profile switch also sends `07 13 7F <byte> 00 00 20 07`.

## Validation

| Claim | Result |
| --- | --- |
| VID/PID, `0xFF01:0x01`, report 7, 8-byte feature reports | Observed |
| 8-byte command frames accepted | Observed |
| Block write and read-back at `0x3A` (`0x0B → 0x0A → 0x0B`) | Observed |
| Stored image `0x0000-0x0FFF` read byte by byte | Observed |
| Rate field `0x14` write/read-back | Observed; effect on cadence not observed |
| DPI `0x12` effect | Not observed |
| Vendor Apply block sequence | Captured from the vendor app |

## Not yet verified

- The mapping from the `0x14` 2-bit field to 125/250/500/1000 Hz.
- The six-stage CPI table location.
- Button-map and lighting semantics beyond the frames listed here.

## Devices

The A825 is a chipset. Public A825 mice:

- Sades Kaze (Instant A825) — tested.
- Ant Esports GM320 — public reverse-engineering project.
- AJAZZ NJ08.
- Kreo Harpy.
- Cybeart Ghost.

## Sources

- A825 datasheet V1.01, Instant Microelectronics.
- `SadesKaze(A825).[20241009].exe` (vendor application).
- `Instant A825 Mouse Reference Driver.[20250716]` (vendor reference build).
- `https://github.com/helllopratik/ant-gm320-linux-experimental`.
