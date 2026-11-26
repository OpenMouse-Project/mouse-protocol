# Hitscan installed device identities

## Configured IDs

The captured installed file `installed/Sys64/usersetting/Config.ini` supplies the device table. SHA-256: `ce6c08639c5c5208665c7e73e633cd4a1b2951dac67af4c850679daeb8b353b2`.

| INI option | Stored text | Base64 decoded bytes / literal | Normalized meaning |
|---|---|---|---|
| VID | `Mzc3MCA=` | `3770 ` | Vendor `0x3770` |
| USB_PID | `MDEwMA==` | `0100` | Wired product `0x0100` |
| Wireless_PID | `MDIwMA==` | `0200` | Wireless product `0x0200` |
| Wireless8_PID | `MDMwMA==` | `0300` | 8K wireless product `0x0300` |
| Wireless2_PID | empty | empty | No separate configured 2K PID |
| Wireless4_PID | empty | empty | No separate configured 4K PID |
| InterfaceId | `1` | literal | Windows interface 1 |
| DeviceId | `5` | literal | Windows collection 5 |
| CID | `NTA=` | `50` | Customer ID decimal 50, byte `0x32` |
| DeviceTotal | `2` | literal | Two drive/model records |

Whitespace normalization is established in the main EXE config reader at `0x14007C550`: base64 decoding calls imported `QByteArray::fromBase64` at `0x14007C812`; it subsequently replaces newline with empty text (`7C83B..7C863`) and space with empty text (`7C892..7C8BA`). The two source literals are newline at `0x140116E58` and space at `0x14011F064`. Therefore the trailing space in decoded VID is removed by shipped code.

CID is read using the `CID` key literal at `0x14011AE4C` (`0x140063135..0x140063175`) and converted with base 10 (`0x14006317B..0x140063184`, `r8d=0x0A`). The resulting byte is stored at object offset 0x48 (`0x14006318A`). This establishes decimal 50, not hexadecimal 0x50.

The VID/PID values are hexadecimal Windows USB identifier strings, not decimal readings of those digits. The DLL formats the lookup using `vid_%ls&pid_%ls&mi_%02d&col%02d` (DLL file offset `0x19868`). The actual default finder at `0x18000B160` passes interface=1, collection=5 to `UsbFinder_FindHidDevicesByDeviceId` (`0x18000B190..0x18000B1A5`). The main EXE's explicit finder call at `0x14007387E` also passes interface=1, collection=5.

These values describe shipped configuration, not a live hardware enumeration or HID descriptor. Windows collection index 5 is not interchangeable with HID usage number 5; the WebHID usage page/usage still requires descriptor evidence.

## Model records

Both configured records contain the same hardware/default settings except MID:

| Field | Drive1 | Drive2 |
|---|---|---|
| MID | `01` | `02` |
| Sensor | base64 `MzM5NQo=` -> `3395\n`, normalized `3395` | same |
| MM | `NRF52840` | same |
| DM | `CX52650N` | same |
| D4M | `CH32V305` | same |
| DPIMaxGrade | 4 | 4 |
| KeyNumber | 6 | 6 |
| XIn1 | 3 | 3 |
| DPIRange | `50,4050,50,4100,26000,50,0x11` | same |
| Default DPI stages | `400,800,1600,3200,3200,4000,6000,8000` | same |
| Adveanced (literal misspelling) | `0,1` | same |

The range is consistent with 50..26,000 DPI in steps of 50, with two configured ranges and an extra `0x11` encoding parameter. Its mapping to sensor bytes must be established by the DPI encoder, rather than dropping that parameter. The file supplies eight stored defaults while maximum enabled grades is four.

The INI does not provide a marketing model name. Calling these records Hyperlight, or assigning Drive1/Drive2 to shell colors based on image filenames alone, would be inference. Preserve MID distinctions in integration until their response fields and UI mapping are verified.

## Main executable tracing anchors

Main image base `0x140000000`; IAT slots and call sites:

- `UsbFinderC_FindHidDevicesByDefaultDeviceId`: IAT `0x140111058`; calls `0x140030B3C`, `0x140063B1A`, `0x1400693EA`.
- `UsbFinderC_FindHidDevicesByDeviceId`: IAT `0x1401110C8`; explicit call `0x14007387E`.
- Function `0x140030A50` calls the default finder from a list of VID/PID strings.
- Near `0x140063ADB..0x140063B1A`, object fields `+0x58` and `+0x60` provide the VID/PID string arguments.
- Global `0x1403C5040` holds model-record collection state; `0x140068240` copies a selected record into global `0x1403C4FE0`. Its first three QString fields are at offsets 0, 8, 16; subsequent scalar fields at 0x18..0x21, further strings at0x28/0x30, shared object at0x38.
- Constructor `0x14002A250` initializes a model record; it does not hard-code the nonempty IDs. Config reader `0x14007C550` is the useful point for further settings provenance.

No hardware requests were issued during this identity recovery. The source files and disassembly are sufficient to reproduce these findings offline.
