# DevDock function map (Sades Kaze A825)

Binary: `DevDock.exe`, product `New825Tab`, 32-bit MSVC + DuiLib, from
`SadesKaze(A825).[20241009].exe`. Addresses are image-base relative.

The analysis database used the names below; the addresses are the evidence.

| Address | Name | Role |
| --- | --- | --- |
| `0x4554B0` | `A825_OpenDevice` | Enumerate HID interfaces with SetupDi and open the report-7 collection. |
| `0x455A40` | `A825_BlockWrite` | Write a config block: one `18 03` frame per byte, `18 09` finish, `18 00` commit. |
| `0x455BA0` | `A825_BlockMode` | Enter (`18 10`) and leave (`18 00`) block mode. |
| `0x480B00` | `A825_WriteLightingConfig` | Write lighting/configuration blocks at `0x1C`, `0x20`, `0x28`, `0x30`, `0x3A`, `0x3E`. |
| `0x481400` | `A825_BuildConfigImage` | Build the full image as id/value records; record `0x14` packs `byte[0x8104] & 3` above three flags; writing it did not change the measured report cadence. |
| `0x4862F0` | `A825_ReadInfo` | Read bytes through `18 03` / `18 00` / `18 05`. |
| `0x486440` | `A825_ButtonMap` | Send `09` button-map frames for the active profile. |
| `0x486630` | `A825_LiveDpiAndButtons` | Send `12` DPI, `11` commit, then four `09` frames. |
| `0x469EB0` | `A825_ApplyLighting` | Collect lighting fields and call `A825_WriteLightingConfig`. |
| `0x402700` | profile/mode switch | Set the active profile, call `A825_ButtonMap` and `A825_LiveDpiAndButtons`, send `13 7F …`. |
| `0x486FA0` | apply state collector | Collect UI state into the device object. |
| `0x454B30` | `A825_ButtonMapFrame` | One `09` frame: `byte2=map index`, `byte3=(action+8)*16+bit`. |
| `0x454BA0` | `A825_KeyCodeFrame` | One `17` frame carrying a 16-bit key/function code. |
| `0x460A60` | `MacroSenderThread` | Macro playback thread. |
| `0x4A3800` | `Keyboard_ApplyConfig` | Keyboard (not mouse) `14`/`13`/`18` frames. |
| `0x4A3A30` | `Keyboard_SetKeyColor` | Keyboard per-key colour. |
| `0x4A3BB0` | `Keyboard_KeyFrame` | Keyboard key/colour `13` frame. |

## Block write

`A825_BlockWrite(this, handle, address, data, length)`:

```
07 18 03 <index> <addrLo> <addrHi> <data> <length-1>
```

one frame per byte, then:

```
07 18 09 00 <addrLo> <addrHi> 00 <length-1>
07 18 00 00 <addrLo> <addrHi> 00 00
```

Addresses are little-endian. The wait between the finish and commit frames is
12 ms.

## Read

```
07 18 03 00 <addrLo> <addrHi> 00 <length-1>
07 18 00 00 <addrLo> <addrHi> 00 00
07 18 05 <index> <addrLo> <addrHi> 00 <length-1>   → feature report byte 1
07 18 00 00 <addrLo> <addrHi> 00 00
```

## Block mode

`A825_BlockMode` sends `07 18 10 00 00 00 00 00`, waits 5 ms, then
`07 18 00 00 00 00 00 00`.

## DPI frames

`A825_LiveDpiAndButtons`:

```
07 12 <DPI/8>                        mode 0
07 12 <DPI/16 high> <DPI/16 low>     other modes
07 11
07 09 × 4
```

The four `09` frames use:

```
byte2 = ((map >> 4) << 6) + profile
byte3 = (map << 4) + 8 + index
byte4 = ((flag0 * 2 + flag1) * 2 + flag2) * 2 + flag3
```

where `map` is `byte[0x7A2 + index]`, `profile` is `byte[0x750]`, and the
flags are `byte[0x79C..0x79F]`.

## Configuration image

`A825_BuildConfigImage` collects records with numeric ids:

| Id | Value |
| --- | --- |
| 0 | `0x5A` |
| 1 | `(-(flag) & 3) + (byte[0x74C] & 3) * 32` |
| 2 | `0xA5` |
| 3 | `byte[0x8068]` |
| 4 | `byte[0x8068] >> 8` |
| 5 | `byte[0x8064]` |
| 6 | `byte[0x8064] >> 8` |
| 7 | `byte[0x802C]` (key map byte 0) |
| 8+ | lighting and stage fields |

The record-to-image-address mapping is not resolved.
