# Hitscan Utility 1.0.2 HID protocol

Recovered from the installed Windows executable, its `HIDUsb.dll`, and `usersetting/Config.ini`. This reference covers every device entry in that installed version. It does not establish support for later utilities or firmware generations.

## Device selection

| Vendor | Product | Transport |
| --- | --- | --- |
| `3770` | `0100` | Wired |
| `3770` | `0200` | Standard wireless receiver |
| `3770` | `0300` | 8K wireless receiver |

The file configures CID **decimal 50** (`0x32`) and MIDs 1 and 2. Both model entries specify sensor 3395, four enabled DPI stages, eight stored stage defaults, and six physical buttons. The file does not supply retail model names. Empty 2K/4K PID options do not add extra product IDs.

Windows selects interface 1, collection 5. These are Windows path indices, not WebHID usage-page/usage values. The client matches an exact VID/PID and a collection declaring report 8 with 128-bit input and output bodies. Descriptor compatibility and hardware behavior are unverified; none of the configured IDs appeared in the present-device enumeration made during this investigation.

## Wire framing

The normal device transport uses **output report 8 and input report 8**, established by `WriteFile`/`ReadFile` in the vendor DLL. Do not substitute feature reports because other CompX-family drivers use them.

Windows buffers contain 17 bytes. WebHID takes the report ID separately, leaving a 16-byte payload:

| Payload offset | Meaning |
| --- | --- |
| 0 | Command |
| 1 | Reserved, zero in normal requests |
| 2, 3 | Address high, low for flash commands |
| 4 | Data length / command-specific flag |
| 5..14 | Up to ten data bytes |
| 15 | `(0x55 - reportId - sum(payload[0..14])) & 255` |

Command `07` writes flash and must receive a complete byte-for-byte echo. Command `08` reads flash; validate command, address, length, reserved byte, and checksum before accepting its data. Scalar `[value, checksum]` records and three-byte DPI/color/button records have their own inner checksum so the record sums to `0x55` as well.

The DLL queues a three-byte host header before its wire buffer. That header is not sent to the mouse. It has final-chunk, send-ready, and callback dispatch fields. The reusable codec omits those host-only fields.

Read and write chunks contain at most ten bytes. The normal base configuration is `0xC0` bytes; the last configured macro slot ends at `0x1B00` exclusive. The vendor's function named `ReadAllFlashData` reads only the first `0xC0` bytes.

Normal synchronous transactions wait 100 ms, up to three attempts. The server uses a different retry path. Input command `0A` is an unsolicited notification, not an acknowledgement. The client serializes whole flash transfers, rejects malformed/stale replies, requires exact write echoes, and reads back every written byte.

## Implementation

`src/hitscan/index.ts` exports the codec and opaque raw configuration/shortcut/macro APIs through `@openmouse/protocol/hitscan` and the root `hitscan` namespace. `src/drivers/hitscan/hid.ts` exports `HitscanHidClient` through `@openmouse/protocol/drivers/hitscan/hid`.

```ts
import { HitscanConfig, hitscanBuildCommand, HITSCAN_COMMAND } from '@openmouse/protocol/hitscan';
import { HitscanHidClient } from '@openmouse/protocol/drivers/hitscan/hid';

const client = new HitscanHidClient(device);
const config = new HitscanConfig(await client.readFlash(0, 0xc0));
const pollingCode = config.scalar(0);
const rawStage = config.dpiStage(0); // Three sensor bytes, checksum validated.
const versionReply = await client.exchange(hitscanBuildCommand(HITSCAN_COMMAND.firmware));
await client.close();
```

Flash writes take an explicit address and complete encoded record. Preserve unknown bytes and read the existing profile before changing it. Shortcut and macro codecs preserve event categories and key bytes without inventing physical button action names. Macro names remain opaque bytes; delay fields are unsigned big-endian 16-bit values whose physical time unit is not asserted by the raw codec.

`hitscanEncodeButton`/`hitscanDecodeButton` cover confirmed mouse buttons, DPI loop/up/down, polling switch, disabled actions, and opaque shortcut/macro parameters. Unknown action triples round-trip unchanged. Shortcut and macro storage is associated with the physical button; their action parameters are not assumed to be storage slot indices.

`hitscanEncode3395Dpi` follows the selected model's two-range encoder and returns both a checksummed record and `effectiveDpi`. Through 4050 DPI the encoder uses 50-DPI steps; above that threshold it uses 100-DPI steps. For example, the app's 4150 request encodes as 4100. `HITSCAN_3395_DPI_VALUES` lists exact representable values, and `hitscanDecode3395Dpi` recognizes canonical equal-axis records. Do not replace this with another brand's generic 3395 encoder. The configured models' conversion is part of the protocol.

`HITSCAN_SETTING_ADDRESS` names confirmed settings: polling, stage count/selection, LOD, debounce, Motion Sync, angle snapping, ripple control, auto-sleep and sensor mode. Polling encodes 125/250/500/1000/2000/4000/8000 Hz as 8/4/2/1/16/32/64; availability still depends on transport and model. Debounce uses 0..8 milliseconds. Sleep selection values are retained as raw codes because code and translation strings do not establish one consistent physical-duration mapping. `HID-SETTINGS.md` supplies the handler and setter evidence.

This is a protocol codec and standalone transport client. It is not yet registered as an OpenMouse settings/UI adapter. Runtime model identification, capability limits, and safe UI semantics should be confirmed before registering such an adapter. Hardware tests are still required for all three transports and both MIDs.

## Full recovered material

Sanitized static-analysis notes are included under [`docs/hitscan/`](hitscan/):

- [`HID-IDENTITY.md`](hitscan/HID-IDENTITY.md): IDs, CID/MIDs, configured defaults and analysis anchors.
- [`HID-COMMANDS.md`](hitscan/HID-COMMANDS.md): command matrix, response matching and retry details.
- [`HID-CONFIG.md`](hitscan/HID-CONFIG.md): raw/normalized layouts, checksums, DPI, buttons, shortcuts, macros and parser quirks.
- [`HID-SETTINGS.md`](hitscan/HID-SETTINGS.md): UI-to-flash mappings, polling codes, DPI encoding and unresolved sleep units.
- [`HID-BUTTONS.md`](hitscan/HID-BUTTONS.md): action codes, UI mappings and unresolved action semantics.

The complete vendor installation, derived binaries, and REA Evidence bundles remain in the local research capture and are not part of this source contribution. REA used portable Ghidra 12.1.4 and JDK 21 in a temporary tool directory. No mouse commands, pairing, resets, identity changes, or firmware operations were issued.

## Evidence limits

The IDs and model records come from the shipped file plus its decoding code; they are not hardware observations. Decompilation is derived pseudocode, not original C++. Exact report usage-page/usage, retail model naming, firmware persistence behavior, and per-firmware capability limits remain unknown. Per-function REA records retain their provider/profile identity and warnings. The detailed reports label manual disassembly findings separately from REA Evidence.
