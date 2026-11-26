# Hitscan HID configuration layout

This is static analysis of the captured `Sys64/HIDUsb.dll`, SHA-256 `1ae0367badac219ec57fdfcf2d5fec128bd28c95aaf1b4916f40b08ec61da93c`. Addresses below are preferred image addresses (base `0x180000000`); subtract that base for RVAs. Evidence is the local LLVM rendering in `static/hidusb-assembly.txt`, not newly generated REA pseudocode. Nothing here claims hardware validation.

## Checksum

The helper at `0x18000EC10` takes `(buffer, start, end)` in RCX/EDX/R8D. It sums bytes over the half-open interval `[start,end)` modulo 256, then returns `(0x55 - sum) & 0xff`. The decisive tail is `0x18000ED06 mov eax,0x55; 0x18000ED0B sub al,r11b`.

Therefore a valid record including its checksum sums to `0x55` modulo 256. This is neither XOR nor a CRC. A value/checksum pair is `[value, (0x55-value)&255]`.

## Raw flash image versus normalized DLL structure

`ProtocolDataParser(raw, normalized)` at `0x180007430` parses a raw flash/configuration image into a DLL-side normalized structure. `CS_SetDllProtocolData` at `0x1800077D0` copies exactly `0x28BC` bytes into the DLL's cached normalized structure at preferred address `0x180024C60`. `ProtocolDataUpdate` (`0x1800077B0`) only calls its update worker after the parser has set a readiness flag at `0x18002751C`. The worker is `0x1800077F0`.

Offsets in the following table are raw flash offsets, not HID packet offsets. Parenthesized normalized offsets are where the parser places the decoded value.

| Raw location | Layout / observed meaning | Normalized destination |
| --- | --- | --- |
| `0x0000` | one byte value, one checksum; polling-rate read wrapper requests this address | `0x00` |
| `0x0002` | one byte value, one checksum; default `6` | `0x01` |
| `0x0004` | one byte value, one checksum; current-DPI read wrapper requests this address; accepted only if below normalized byte `1` | `0x02` |
| `0x0006` | one byte value, one checksum; default `0` | `0x03` |
| `0x0008` | one byte value, one checksum; default `0` | `0x04` |
| `0x000A` | one byte value, one checksum; default `0` | `0x05` |
| `0x000C + 4*i`, `i=0..7` | three DPI bytes plus checksum; defaults `FF FF 00` | `0x0F + 6*i` (three bytes) |
| `0x002C + 4*i`, `i=0..7` | RGB/color triplet plus checksum; default white | `0x12 + 6*i` (three bytes) |
| `0x004C` | four consecutive value/checksum pairs; `BufferToDPILed` | `0x3F..0x42` |
| `0x0060 + 4*i`, `i=0..15` | three-byte key-function mapping plus checksum | `0x4A + 3*i` |
| `0x00A0` | six bytes plus checksum; LED bar | `0x43..0x48` |
| `0x00A7` | one value plus checksum; LED bar supplementary field | `0x49` |
| `0x00A9` | one byte plus checksum, default `8` | `0x06` |
| `0x00AB` | one byte plus checksum; parser converts value to boolean; default `1` | `0x07` |
| `0x00AD` | one byte plus checksum, default `6` | `0x08` |
| `0x00AF` | one byte plus checksum; boolean; default `0` | `0x09` |
| `0x00B1` | one byte plus checksum; boolean; default `0` | `0x0A` |
| `0x00B3` | one byte plus checksum; boolean; default `0` | `0x0B` |
| `0x00B5` | one byte plus checksum; boolean; default `0` | `0x0C` |
| `0x00B7` | one byte plus checksum, default `6` | `0x0D` |
| `0x00B9` | one byte plus checksum, default `0` | `0x0E` |
| `0x0100 + 0x20*i`, `i=0..15` | shortcut record, 32-byte slot | `0x7C + 0x34*i` |
| `0x0300 + 0x180*i`, `i=0..15` | macro record, 384-byte slot | `0x3BC + 0x250*i` |

The macro region ends at `0x1B00` exclusive. Settings whose semantics are not named here need executable-side UI/use tracing; the DLL byte copy alone does not identify which is debounce, LOD, motion sync, or sensor mode. DPI's three bytes are likewise preserved as raw fields here: do not assume a generic integer encoding without following the selected sensor path.

Parser anchors: `MouseConfigParser` `0x180006FF0`, DPI/color loop `0x18000745E..0x1800074DF`, LED parser `0x1800074E1..0x1800075DF`, key/shortcut/macro loop `0x1800075DF..0x180007678`.

## Write construction

The update worker compares the requested normalized structure with its cached structure and emits writes for changed fields. Thus OpenMouse can update individual raw records rather than rewriting an entire image.

`0x1800076B0` is a generic write-packet builder. Its inputs are a command vector, data pointer, raw address, data length, and an extra byte selecting the queue record's first byte. The 20-byte internal command record has:

| Internal offset | Value |
| --- | --- |
| `0` | caller-selected queue/transport byte |
| `1` | `01` |
| `2` | `00` |
| `3` | `08` |
| `4` | `07` (write) |
| `5` | `00` |
| `6` | flash address high byte |
| `7` | flash address low byte |
| `8` | data length |
| `9..` | record data, with unused payload bytes zero |
| `19` | checksum over internal bytes `[3,19)` |

This is an internal queue layout. Establish the transport's stripping/wrapping separately before using it as a WebHID report.

Single-byte settings are written with their own record checksum (2 data bytes). DPI and RGB records are written as 4 bytes, key mappings as 4 bytes, LED bar as 7 bytes, and LED supplemental field as 2 bytes. The worker's inlined writers use the same `08 07 00 address_hi address_lo length data... checksum` layout. DPI/color write anchors `0x180008300..0x180008500`, LED writes `0x18000850B..0x1800089D4`, key writes `0x1800089D4..0x180008AEC`.

Shortcut and macro writes are split into chunks of at most 10 data bytes when they exceed one packet (`0x180008CFD` and `0x180008FF2` threshold comparisons and calls to `0x1800076B0`). Nonfinal chunks use internal offset 0 value `0`; final chunk uses `1` (`0x180008D05/0x180008D32`, `0x180008FFD` and final branch at `0x180009017`). This flag's effect on physical transport still needs queue-consumer tracing. Preserve per-record checksums within the chunks in addition to the outer command checksum.

## DPI and LEDs

`BufferToDPIColor` (`0x180007250`) checks three bytes and their checksum; if valid, it writes the three bytes into destination offsets 3..5. It defaults those destination bytes to `FF FF FF`.

`BufferToDPILed` (`0x1800072A0`) reads four independent value/checksum pairs, defaulting the normalized four bytes to `02 80 03 01`. The full parser maps these at raw `0x4C` to normalized `0x3F`.

`BufferToLedBar` (`0x180007350`) checks six bytes together and defaults the six destination bytes to `01 FF FF FF 08 09`; it separately checks raw local offset 7's value against local offset 8's checksum and defaults that seventh normalized byte to `01`.

## Key maps and shortcuts

`BufferToKeyFunMap` (`0x1800073E0`) converts a four-byte record `[a,b,c,checksum(a,b,c)]` to three normalized bytes, default `00 00 00`. Mapping category and code semantics still require application-side enum tracing.

`ShortcutKeyToBuffer` (`0x180009370`) encodes a normalized shortcut with a count byte at offset 0 and 8-byte events starting at normalized offset 4. Supported count is 2..6. Encoded record:

```
byte 0: count
then count * 3-byte events:
  byte 0: event kind in bits 7..6 | normalized event byte 1
  byte 1: normalized event byte 2
  byte 2: normalized event byte 3
then one checksum over [0, 1 + 3*count)
```

Event type normalized byte 0 maps `0 -> 0x80`, `1 -> 0x40`, other -> `0`. The decoder masks low nibble (`&0x0F`) into normalized event byte 1 and decodes top bits `0x80 -> 0`, `0x40 -> 1`, other -> `2`; normalized event dword at +4 becomes 0. Event direction semantics (press/release) are not established just by this numeric transformation.

`BufferToShortcutKey` (`0x180009450`) has unusual observed behavior: it computes a checksum and **writes** it into the input record at `1+3*count` (`0x180009484`), then rejects if that computed checksum is zero. It does not compare the stored checksum there. This may be a shipped bug. An OpenMouse decoder should validate input explicitly rather than copying this mutation as intended protocol behavior. Invalid count leads to normalized count zero and zeroed event slots.

## Macros

`MacroKeyToBuffer` (`0x180009560`) and `BufferToMacroKey` (`0x180009640`) use:

| Raw macro slot offset | Layout |
| --- | --- |
| `0` | name length |
| `1..30` | name bytes (decoder accepts length 1..30 and otherwise leaves empty) |
| `31` (`0x1F`) | event count |
| `32` (`0x20`) | start of packed events, five bytes each |
| `32 + 5*count` | checksum over `[31,32+5*count)` |

Decoder accepts event count 2..70 and validates the stored checksum; invalid count/checksum yields zero event count and zero events. Each packed event decodes to an 8-byte normalized event:

```
packed[0] top two bits -> normalized event type 0/1/2 as for shortcuts
packed[0] low nibble -> normalized event byte 1
packed[1] -> normalized event byte 2
packed[2] -> normalized event byte 3
(packed[3] << 8) | packed[4] -> normalized LE uint32 at event +4
```

The encoder masks normalized byte 1 with `0x0F` and stores only the lower 16 bits of that uint32 as big endian. Name bytes have no separately checked checksum in this conversion routine. Encoding a macro requires at least `33+5*count` bytes, at most 383 for 70 events, fitting the 384-byte flash slot.

The update worker writes whole changed macro records in chunks, advancing slot addresses by `0x180` and normalized structures by `0x250` (`0x180009224..0x18000924B`). Its packed-buffer length is `33+5*count`: `0x180008FCC` computes `33+4*count`, followed by `0x180008FD3 add ebx,eax` to add the fifth count term. Shortcut packed write length is `2+3*count` (`0x180008CE9..0x180008CEC`), including its count and checksum bytes.

## Remaining evidence needed

- Application mapping from normalized setting indices to semantic names and allowed values.
- Selected-sensor DPI encoding; the shipped `driver_sensor.h` contains per-sensor tables but is not proof every table is used for the connected model.
- VID/PID and HID collection/report selection, queue-to-wire transformation, response parsing, timeout/retry rules.
- Runtime confirmation of read/write behavior and persistence, without firmware or pairing side effects.

All layout rows above are derived from static instructions. A complete functional driver requires these missing transport/model-specific facts as well.
