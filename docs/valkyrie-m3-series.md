# Valkyrie VK M3 series: identity and protocol research

Status: **identity and polling/DPI codecs; no registered driver**. Physical
VK M3 Lite hardware passed identity reads on the receiver and wired paths, and
bounded polling/DPI write-read-restore checks on wired USB and the receiver.
Buttons and browser/Bridge integration are not verified. This contribution
does not make the mouse configurable in the public OpenMouse application yet.

## Evidence and provenance

Research performed on Windows on 2026-09-07 using an installed VK M3 Series
package whose `config.xml` declares software version `1.0.0.4`.

- `VK M3 Series.exe` SHA-256:
  `45ea3f748a2cacc226db2f1f57a315067b98fb167539381bee56a68ceba3343b`.
- `config.xml` SHA-256:
  `39de7aa9b2e219996dfe4198fc0d16c0976a53c54c3cd48660afb53f6e6d4ddd`.
- Static analysis: Ghidra 12.1.3, PE32/x86, image base `0x00400000`.
  Whole-program analysis reached its time limit; specific transport and identity
  routines were subsequently decompiled successfully.
- Runtime evidence: independent hidapi 0.15.0 queries, a hidapi 0.14.0.post4
  comparison, and Frida 17.17.0 traces at the application's transport routines
  during startup. These are application-level HID bytes, not a USB bus capture.
- [Sanitized identity fixture](../captures/valkyrie-m3-lite-identity.json).
- [Wired read/write/restore fixture](../captures/valkyrie-m3-lite-wired.json).
- [Wireless retry fixture and verification](../captures/valkyrie-m3-lite-wireless.json).

No vendor binaries, decompiled source, device paths, serial numbers, or account
information are included. Function addresses below identify locally inspected
evidence in the hashed executable, not redistributable vendor source.

## Identity and discovery

| Property | Observed value |
| --- | --- |
| VID:PID | `249A:5C2F` |
| Manufacturer / product | `XCTECH` / `Wireless-Receiver` |
| USB release number | `0x0184` |
| Connection | 2.4 GHz receiver |
| Interface 0 | usage page `0x0001`, usage `0x0002` |
| Interface 1 collections | `0x0001:0x0006`, `0x000C:0x0001` |
| Configuration interface 2 | `0x0001:0x0000` |
| Protocol model code | `M220` (VK M3 Lite) |

Direct USB enumerated as `248A:5D2E`, manufacturer `XC TECH`, product
`VK M3 lite`, release `0x0317`. Its configuration interface is also interface 2,
usage `0x0001:0x0000`. Wired identity reports model `M220`, raw firmware field
`0x0317`, sensor selector `0x11`, battery-status byte 1 and percentage 100.
The reconstructed configuration descriptor is identical to the receiver's.

The vendor config maps `M220` to **VK M3 lite** and `E023` to **VK M3**.
Both models share USB IDs. A VID/PID match alone must not select a model.
`E023` has not been observed on hardware in this investigation.

Additional config-only candidates, not verified paths:

- Lite: wired `248A:5C2E`. The other configured Lite paths were exercised above.
- M3: wired `248A:5C2E`, `248A:5D2E`, `248A:5E2E`; wireless `249A:5C2F`.
- The XML also has inconsistent wireless rows: numeric VID `249A`, but an
  interface string containing `VID_248A&PID_5C2F&MI_02`. Do not convert that
  inconsistent string into an additional verified USB ID.

hidapi's **reconstructed** descriptor for interface 2 was:

```text
05 01 09 00 a1 01 75 08 95 20 81 03 c0
```

It describes 32 bytes of constant input and advertises no output or feature
reports. Windows native output writes nevertheless succeeded. This does not
prove that a browser can issue the same writes. WebHID was not tested.

## Confirmed identity exchange

The codec's request is the 32-byte **payload**. Native HID APIs require a leading
zero report ID, giving 33 bytes in the write call:

```text
TX (native write, 33 bytes):
00 10 00 00 00 00 00 00 00 00 00 00 00 00 00 00
00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00

RX (hidapi input, 32 bytes, already without report ID):
10 00 01 0b 4d 32 32 30 84 01 11 01 00 4e 01 00
00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 c7
```

Offsets below refer to the 32-byte payload, excluding the transport report ID.

| Offset | Meaning / observation |
| --- | --- |
| 0 | Identity command `0x10` |
| 1 | Successful response status `0x00` |
| 2 | Observed `0x01`; semantic meaning not established |
| 3 | Observed `0x0B`; consistent with 11 data bytes, not independently established |
| 4–7 | Four ASCII model-code bytes (`M220`) |
| 8–9 | Little-endian raw firmware-version field (`0x0184`) |
| 10 | Vendor sensor selector (`0x11`); physical sensor model not established |
| 11 | Raw adjacent sensor/variant field (`0x01`); semantics unknown |
| 12 | Raw battery-status field (`0x00`); flag meanings unknown |
| 13 | Battery percentage (`0x4E` = 78 in the capture) |
| 14 | Raw connection-status field (`0x01`); enum meanings unknown |
| 15–30 | Reserved/unknown; zero in the capture |
| 31 | Sum of bytes 4–30 modulo 256 (`0xC7`) |

The parser validates the observed identity header, checksum and battery range,
and keeps ambiguous fields raw. Unknown printable ASCII model codes can be
decoded but must not be treated as supported products.

Static evidence:

- `0x0044A240`: zeroes the request, sets native bytes 0–1 to `00 10`, computes
  the checksum over native bytes 5–31, writes 33 bytes, and waits for input
  with zero at payload offset 1.
- `0x0044C330`: overlapped `WriteFile` wrapper.
- `0x0044C410`: overlapped `ReadFile` wrapper; removes a leading zero report ID
  when present. Recorded return length: 32.
- `0x0044A880`: selects usage `0x0001:0x0000`, issues identity, extracts
  bytes 4–7 as the model code, and matches config entries.
- `0x00431120`: consumes bytes 8–14 for firmware/sensor/battery state;
  byte 13 is passed to battery UI controls as the percentage.

## Verified wired and wireless polling and DPI

Wired USB and the reconnected receiver returned complete, checksum-valid
replies to reads `0x12` and `0x13`.
Both are zero-filled 32-byte request payloads with the command at byte 0.

| Field | Polling read | DPI read |
| --- | --- | --- |
| Response bytes 0–3 | `12 00 01 01` | `13 00 01 19` |
| Byte 4 | Polling code | Low nibble: enabled count; high nibble: raw selected index |
| Bytes 5–28 | Reserved/unknown | Six little-endian X/Y pairs; pair i starts at `5 + 4*i` |
| Bytes 29–30 | Reserved/unknown | Reserved/unknown |
| Byte 31 | Sum of bytes 4–30 modulo 256 | Same |

Polling menu construction at `0x0041D220` establishes `1 = 1000 Hz`, `2 = 500 Hz`,
`4 = 250 Hz`, `8 = 125 Hz`. These are encoded setting labels; actual report
timing was not measured. Codes 1 and 2 were exercised in write/read-back tests.
The codec rejects code 3 and other values outside this documented set.

DPI decoding remains raw in the public API because the scale depends on the
sensor selector. For selector `0x11`, vendor `0x0041DDC0` maps raw values below
200 to `raw*50`, 200–220 to `(raw-100)*100`, and above 220 to `(raw-208)*1000`.
Vendor `0x0041DC60` is the encoder. The local utility uses only exactly
representable values; physical CPI was not independently measured.

Writes use 32-byte payloads plus report ID zero in the native API. They clone a
validated complete read reply, preserve unknown bytes, change the intended
fields, and recompute byte 31:

- Polling: command `0x02`, header `02 00 01 01`, change byte 4.
- DPI: command `0x03`, header `03 00 01 25` (the literal `0x25` differs from the
  read header), replace both axes of one stage. This follows vendor `0x00434280`.
  The exported raw-value encoder is restricted to selector-`0x11` values 1–232;
  callers must establish the model/sensor and restrict writes to enabled stages.

The vendor polling setter `0x00434930` passes a 65-byte buffer. That size did
not complete as requested in the native probe; the tested implementation uses
33 bytes for both writes. A 33-byte polling restore was acknowledged and read
back successfully before further tests.

Hardware checks changed DPI stage 0 from raw `49/49` to `50/50` and restored the
complete original read packet; polling changed from code 1 to 2 and back to 1.
Both operations were then repeated on wired USB and the receiver using the built
TypeScript codecs through node-hid 3.4.0, with exact full-packet restoration checks. Other settings bytes
were unchanged. Flash persistence across a power cycle was not tested.

## Receiver startup framing anomaly and recovery

The vendor startup routine `0x00431120` issues `0x11` followed by `0x12`
(polling settings), `0x13` (DPI settings), and further settings reads. Tested
requests have the same zero-filled 33-byte native shape as identity with a
different command byte.

During the initial receiver session, unlike identity, these did **not** return
correctly aligned complete replies. Example immediately following an identity read:

```text
TX: 00 12 followed by 31 zero bytes
RX: 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
    00 00 00 01 00 00 00 00 12 00 01 01 01 00 00 00
```

The expected-looking `12 00 01 01` header appears at offset 24. Subsequent
buffers begin with data resembling the previous response's tail. Repeated
`0x13` queries returned the same shifted-looking buffer. The vendor executable's
own startup trace reproduced this behavior; it is not exclusive to hidapi.
The same shifted bytes were present in the raw 33-byte Windows input buffer,
before removal of the zero report ID. Wired replies were correctly aligned.

Joining one response's last eight bytes with the next response's first 24 bytes
does not establish a valid packet: checksum-like bytes land at offset 27, and
the resulting sums fail for richer replies such as `0x13`. Do not rotate,
splice, or decode these buffers based on appearance alone.

The vendor transaction helper at `0x0044A340` accepts a positive read whose
second byte is zero, without checking the command echo or checksum. A future
driver must not copy that acceptance rule.

After switching to wired USB and reconnecting wirelessly, reads `0x10` through
`0x13` returned complete checksum-valid packets. The built codecs then passed
receiver DPI and polling write/read-back checks and exact restoration of both
original settings packets. No packet rotation or splicing was introduced.
Reconnection preceded recovery, but the underlying cause remains unknown.
Malformed replies must still be rejected if the fault recurs.

## Integration boundary and next checks

Packet semantics belong in `mouse-protocol`. OpenMouse Bridge's native adapter
can enumerate interfaces and attempt output writes without WebHID collection
filtering; see the
[inspected adapter revision](https://github.com/OpenMouse-Project/OpenMouse-Bridge/blob/127f88f93dba234a20c32a6c95e5a69e847137b9/native-hid/src/hid-device-adapter.mjs).
There is no Valkyrie brand entry at that revision. Native transport eligibility
does not establish a working driver.

Before registering a driver:

1. If the framing fault recurs, compare completed native `ReadFile` buffers with
   raw USB IN transfers to locate it and determine whether data is lost.
2. Test additional firmware revisions and models; wired `248A:5D2E` and receiver
   `249A:5C2F` are the only paths exercised here.
3. Test browser output access rather than inferring it from native success.
4. Extend the bounded checks to other settings and paths only with
   captures, read-back verification, and restoration of original values.
5. Register only verified paths, including Bridge dispatch if native access
   proves necessary.
