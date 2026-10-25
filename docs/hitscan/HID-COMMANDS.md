# Hitscan HID command recovery

Static manual interpretation of `static/hidusb-assembly.txt` (LLVM disassembly of the captured `HIDUsb.dll`, SHA-256 `1ae0367badac219ec57fdfcf2d5fec128bd28c95aaf1b4916f40b08ec61da93c`). Addresses below are preferred-image virtual addresses, image base `0x180000000`. These are assembly-derived findings, separate from REA Evidence. No DLL or device execution was performed for this report.

## Packet and queue distinction

All command constructors below initialize a 17-byte wire buffer. Its first two bytes are `08 opcode`. The checksum byte at offset 16 is `(0x55 - sum(wire[0:16])) & 0xff`, established by calls to helper `0x18000EC10` and its tail `0x18000ED06..0x18000ED0E`. Unspecified bytes are zero in these constructors.

| Wire offset | Meaning established by builders |
|---|---|
| 0 | `08` (first Windows HID buffer byte; report ID interpretation belongs to transport) |
| 1 | Opcode |
| 2 | Zero for the constructors in this matrix |
| 3..4 | Big-endian flash address for flash operations; otherwise usually zero or special fields |
| 5 | Data length or special flags/length byte |
| 6..15 | Up to ten payload bytes |
| 16 | Checksum over offsets 0..15 |

`UsbServer_*` queue records are 20 bytes: three internal bytes followed by the 17-byte wire buffer. Internal byte 0 marks a final packet for aggregation, byte 1 is the send-ready flag, and byte 2 is a dispatch tag. `UsbServer_InitWriteCommand` at `0x18000F440` clears 20 bytes and sets its first two bytes to `01 01`; those bytes are NOT a wire header. `UsbReaderWriterServer` sends from queue+3 (`0x1800119D2`) with length `0x11` (`0x1800119DB`).

## Command matrix

Data and length references below use **wire** offsets. Matrix scope covers all named server command constructors from `0xF4E0` through `0x10F57`, plus the direct discovery/CID interfaces. Names preserve the DLL's spelling, including `Falsh`.

| Opcode | Operation | Constructor VA | Length at wire[5] | Payload/notes |
|---|---|---|---|---|
| `01` | ReadEncryption / ReadCidMid; direct GetDeviceInfo | `18000F630`, alias `F780`; direct `18000C920` | `08` | Four pseudorandom bytes at wire[6..9]; direct GetDeviceInfo returns response[10..12]. Server and direct info builder share packet format. Encryption meaning beyond export name is unverified. |
| `02` | SetPCDriverStatus | `18000F790` | `01` | wire[6] = one-byte status parameter. |
| `03` | ReadOnLine / GetDeviceOnLine | `18000F8C0`; direct `18000CD40` | `00` | Direct result = response[6] > 0. |
| `04` | ReadBatteryLevel / GetBatteryLevel | `18000F9A0`; direct `18000D190` | `00` | Direct output is response[6], response[7], and BE16(response[8..9]). Exact semantic labels for those fields need UI-side confirmation. |
| `05` | EnterDonglePairWithCidMid | `18000FA90` | `02` | wire[6] = first parameter; wire[7] = second. `EnterDonglePair` at `FA80` supplies both zero. |
| `05` | EnterDonglePairOnlyCid | `18000FB80` | `02` | wire[6]=0, wire[7]=0, wire[8]=CID parameter. This apparently unusual placement is literal assembly (`FBAA`, `FBC9`, `FBD0`). |
| `06` | ReadDonglePairStatus | `18000FC70` | `00` | Other bytes zero. |
| `07` | Flash/config write | See configuration recovery | variable, <=10 | Server response matcher specifically requires a full 17-byte echo for opcode 07. |
| `08` | ReadFalshData | `18000F4E0` | chunk size <=10 | Address BE16 at wire[3..4]; reads split into ten-byte chunks; bytes 6..15 initially zero. |
| `09` | SetClearSetting | `18000FD60` | `00` | Factory/clear setting command per name; no runtime validation. |
| `0B` | SetVidPid | `18000FE40` | `04` | Payload = `[(vid >> 8) & 0x0f, vid & 0xff, (pid >> 8) & 0x0f, pid & 0xff]`. High bytes are explicitly masked to a nibble, not full 16-bit fields. |
| `0C` | SetDeviceDescriptorString | `18000FF50` | chunk size <=10 | wire[3] = total byte count, wire[4] = byte offset; chunks carry descriptor bytes in wire[6..15]. Input encoding and valid length need caller-side confirmation. |
| `0D` | EnterUsbUpdateMode | `1800101E0` | `00` | Mode change only established statically; do not treat as a normal settings operation. |
| `0E` | ReadConfig | `1800102C0` | `00` | Other bytes zero. |
| `0F` | SetCurrentConfig | `1800103A0` | `01` | wire[6] = selected config parameter. |
| `11` | EnterMTKMode | `180010490` | `00` | Meaning beyond name unverified. |
| `12` | ReadVersion / GetVersion | `180010570`; direct `18000CBC0` | `00` | Direct result = BE16(response[6..7]). |
| `14` | Set4KDongleRGB | `1800106A0`; direct `18000D530` | `0A` | Copies ten input bytes to wire[6..15]. |
| `15` | Get4KDongleRGBValue | `1800107A0`; direct `18000D6B0` | `00` | Direct result copies response[6..15]; success additionally tests response[5] > 0. |
| `16` | SetLongRangeMode | `1800109E0`; direct `18000DB60` | `0A` | wire[6] = mode parameter; remaining payload zero. Length is literally 10 although only one nonzero byte is supplied. |
| `17` | GetLongRangeMode | `180010AD0`; direct `18000DD00` | `00` | Direct result = response[6]. |
| `18` | SetDongleRGBBarMode | `180010C90`; direct `18000E550` | `0A` | wire[6] = input[0] when input[6] != 0, otherwise 0; wire[7..11] = input[1..5]; remaining data zero. |
| `19` | GetDongleRGBBarMode | `180010DA0`; direct `18000E6C0` | `00` | Direct copies response[6..12], success additionally response[5] > 0. |
| `1A` | SetDongleIDToMouse | `180010E70`; direct `18000E870` | `0A` | Copies ten input bytes to wire[6..15]. |
| `B3` | GetSlaveVersion | `180010BB0`; direct `18000DE90` | `00` | Direct result = BE16(response[6..7]). |
| `F0` | WriteCidMid | direct `18000D9C0` | `83` | wire[6..8] = three parameters. Response returns [6], [7], and response[5] >> 7; additionally requires checksum(response[6:7]) == response[8]. The odd one-byte checksum coverage is literal (`DA42..DA63`). |
| `F1` | ReadCidMid (direct variant) | direct `18000D850` | `83` | Same result extraction/extra one-byte checksum as F0 (`D8B3..D8E4`). Distinct from the server ReadCidMid alias of opcode 01. |

No opcode `00`, `0A`, `10`, or `13` constructor was established by this bounded command-builder pass. This does not prove the hardware never supports those values.

## Flash read wrappers

`UsbServer_ReadFalshData(address, length, dispatchTag)` at `0x18000F4E0` uses ten-byte chunks, increments the address by ten, marks only the final queue record's internal byte 0, and stores the third parameter in internal byte 2. Its public wrappers establish:

| Wrapper | VA | Address | Count | Dispatch tag |
|---|---|---:|---:|---:|
| ReadAllFlashData | `18000F620` | `0000` | `C0` | 1 |
| ReadCurrentDPI | `180010650` | `0004` | 1 | 0 |
| ReadReportRate | `180010660` | `0000` | 1 | 0 |
| ReadDPILed | `180010670` | `004C` | 8 | 0 |
| ReadLedBar | `180010680` | `00A0` | 9 | 0 |

The `C0` ReadAllFlashData count is only the base config region, not the full shortcut/macro address space.

## Responses, matching and batching

Direct request helper `UsbFinder_GetDeviceData` (`0x18000C640`) writes 17 bytes (`C730`), then waits up to 100 ms (`C753`) per attempt, with a maximum of three write attempts (`C7D7..C7DC`). It accepts a response only when checksum(response[0:16]) == response[16] (`C760..C77D`) and response[1] == request[1] (`C77F..C78A`). It restarts the input read for unrelated responses. These facts do not establish every higher-level command succeeded.

Server response processing at `0x180010F70` special-cases unsolicited opcode `0A` (`10FA4`), copies its ten data bytes (`10FBE..10FCF`) to battery/status state, and does not require it to match the command queue. The exact unsolicited state bit meanings need separate caller/config analysis.

For ordinary queued replies (`0x180011177` onward), it requires a nonempty queue, internal byte 1 == 0 (sent), and response[1] == queuedWire[1] (`111B2..111C2`). For opcode 07, it compares all 17 reply bytes with the queued request (`111C8..111E1`); mismatch restores ready flag = 1 (`11243..1124E`) for retransmission.

For an accepted reply, it saves the original request and response, except the callback's request-length byte is updated from response[5] (`111E6..11211`). It removes the head request, appends the completed 20-byte record to a response batch, and waits until the original internal byte 0 is nonzero (`1128E..11291`). It then clears a 0x2000-byte aggregate buffer and copies **ten bytes per response**, regardless of response length (`112E0..11302`), while separately summing the response length bytes (`11308..1130C`). Consequently batched parsing must preserve ten-byte chunk strides; concatenating only actual lengths would differ for nonfinal short packets.

If the batch's internal dispatch tag is 1..80 (`1134A..11356`), a separate config parser is called. Otherwise the callback gets original request, request length 17, aggregate buffer, and summed response lengths, with special handling for opcodes 03 and 04 (`1135D..113C3`).

## Host-only exports

`UsbServer_SetBatteryOptimizeEnable` (`180010880`), `SetBatteryOptimizeLastBattery` (`1800108A0`), `SetBatteryOptimizeParam` (`1800108C0`), and `SetBatteryOptimizeSection` (`180010900`) alter host state/threshold tables. The first three do not create HID command packets. They should not be assigned invented wire opcodes just because they are DLL exports.

## Remaining limits

Exact VID/PID/usage matching, WebHID transport compatibility, feature vs output report selection, firmware bootloader packets, UI-level setting meanings, and runtime acknowledgements are outside this report's command-builder pass. Firmware upgrade exports exist, but their flash/update sequence has not been reconstructed here. Static command names are not proof of firmware support on every Hitscan model.
