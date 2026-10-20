# AJAZZ AJ200 / AJ200P AI family

This driver uses VID `0x363c`, usage `0xffa0:0x02`, output report `0x0b`
(127-byte body), and input reports `0x0a`/`0x0b`. It is independent of the
NJ07/NJ08 and GearHub AJAZZ protocols.

## Device catalogue

All IDs below share the configuration command family in AJAZZ desktop
configurator 2.2.5. Capability data is from that configurator's device catalogue
and packet encoders. This implementation contains original codecs and tests;
no vendor code, firmware binaries, serial numbers or radio addresses are included.

| Model | Sensor | Wired PID | Receiver PIDs | Hardware verification |
| --- | --- | --- | --- | --- |
| AJ200 NL AI MC | PAW3311 | `ed03` | `ed05` | Not tested |
| AJ200P NL AI MC | PAW3311 | `ed06` | `ed00` | Not tested |
| AJ200 NL AI PRO+ | PAW3395 | `ed07` | `ed08`, `fc08` | Not tested |
| AJ200P NL AI ULTRA | PAW3950 | `ed09` | `ed0a`, `fc0a` | Not tested |
| AJ200P NL AI ULTRA+ | PAW3950 | `ed0b` | `ed0c`, `fc0c` | Not tested |
| AJ200P NL AI ULTRA-3955 | PAW3955 | `ed1d` | `ed1e`, `fc1e` | Not tested |
| AJ200P AI MASTER | PAW3955 | `ed1b` | `ed1c`, `fc1c` | **Only `ed1c`, firmware 3.3.13** |
| AJ200P NL AI S ULTRA | PAW3955 | `ed25` | `ed26`, `fc26` | Not tested |

The PAW3955 `fc1e` nano receiver is named AJ200P NL AI ULTRA and advertises
8 kHz, whereas `ed1e` advertises 4 kHz. ULTRA+ excludes 125 Hz wirelessly.
These differences are retained rather than inferred from model names.

## Packet layout

The report ID is separate from the body. Outgoing bodies are zero-padded to 127
bytes: `[command, payloadLength, ...payload]`. Incoming bodies start with
`[command, length, status, ...payload]`; zero status means success. Reply length
includes the status byte except for DPI tables, where it counts data only.

| Command | Operation | Payload bytes |
| --- | --- | --- |
| `0x13` | Read identity, firmware, battery and active bank | 54 |
| `0x15` / `0x16` | Read / write button map | 21 or 33 |
| `0x17` / `0x18` | Read / write settings | 30, 31 or 39 for the listed products |
| `0x19` / `0x1a` | Read / write all eight DPI slots | 48 for legacy sensors; 64 for PAW3955 |
| `0x21` | Select active onboard bank | One zero-based bank index, `0..4` |

Read requests have no payload. Writes return an acknowledgement; settings, key
maps and DPI tables are then read back in full. Offsets below refer to payloads,
without report ID, command, length or status.

| Settings offset | Meaning |
| --- | --- |
| 0 / 1 | Wireless / wired polling-rate code |
| 2 / 3 | Enabled DPI count / zero-based active slot |
| 6 | LOD code, constrained by the product catalogue |
| 7 | Debounce in milliseconds, `0..20` |
| 8 / 10 | Motion Sync / angle snapping |
| 11 | Three-state ripple control, preserved |
| 15 | Sensor power saving: `1` enabled, `0` performance |
| 21–23 | DPI lighting theme RGB, separate from DPI-slot colours |
| 25 / 26 | Normal / deep sleep in 10-second units |
| 27 / 28 / 29 | DPI theme effect / brightness / speed |
| 30 | Optional BLE setting, preserved |
| 31–38 | Optional flywheel settings, preserved |

Button entries are three bytes: `[actionType, argument1, argument2]`. The seventh
wire entry (`key7`, zero-based slot 6, bytes 18–20) is retained without assigning
it a physical button. Wheel entries follow it on flywheel models.

Legacy DPI entries are six bytes. They pack two 10-bit, 50-DPI-unit axis values
minus one plus RGB; unused bits in the packed byte are preserved. PAW3955 entries
are eight bytes, with a shared high-nibble byte, two 16-bit little-endian axis
values and RGB. Both encodings are decoded and patched by the pure codec.

## Supported settings

- Five firmware-managed onboard banks; edit the active bank after selecting it.
- Six physical button entries; ULTRA+ and MASTER add four wheel/tilt entries.
  Wire slot 7 (`key7`) has no corresponding control in the vendor UI and is
  preserved without exposing a fictitious AI button. The vendor's separate
  AI features attach to the forward/back buttons instead.
- Mouse buttons, keyboard keys/modifiers including the numpad, consumer/system
  controls (media, volume, brightness, browser and app launch), DPI actions and
  disabled buttons. Existing shortcuts, macros and unknown actions are preserved.
- Eight DPI slots, active slot and enabled slot count, separate X/Y values and
  per-slot RGB colours. Legacy sensors use six-byte/50-DPI entries. PAW3955 uses
  eight-byte entries with independent 20-bit axes, 1–80000 DPI.
- Model/connection-specific polling rates, LOD where supported, 0–20 ms debounce,
  Motion Sync, angle snapping and sensor performance/power-saving mode.
- One sleep control writes both normal and deep-sleep timers in the same settings
  block. Deep sleep is set to normal sleep plus 60 seconds, in the protocol's
  10-second units (including 1800/1860 seconds at the upper end). Reading does not
  change existing independent timers. The UI explains the coupling before saving.
- A separate DPI lighting theme colour, off/static/breathing, brightness and speed.

Three-state ripple control, BLE options and flywheel tuning are
preserved byte-for-byte. They are not reduced to unrelated generic controls.
Macro bodies, AI service features, receiver lighting, pairing, reset and firmware
update are outside this change.

## Experimental button actions

`[8,255,0]` cycles banks; `[8,0..4,0]` selects a bank. `[7,0,0]` cycles polling
rate; `[7,code,0]` chooses one rate (`125:8`, `250:4`, `500:2`, `1000:1`,
`2000:16`, `4000:32`, `8000:64`). These actions are exposed across the family
with an experimental connection-status note outside MASTER firmware 3.3.13.
Fixed-rate choices respect the current model/connection's advertised rates.
The cycle action's exact sequence on other firmware is unverified.

Evidence for MASTER 3.3.13 is static analysis of its key-action dispatcher:
type 7 at `0x901393da`, rate table at `0x901334d4`; type 8 at `0x90139400`,
next-bank routine at `0x901333ae`. Bank cycling has also been invoked using the
physical bottom button. The other three paths have not yet been physically
invoked. Types 12 and 13 have no established effect and are not offered.
Short-press mapping does not rewrite the firmware's long-press pairing handler.

## Transaction and verification rules

Entire read/modify/write operations are queued. Every write waits for its
acknowledgement, settles, then reads back the complete block. Acknowledgement
alone is not success. The driver checks the active bank before and after a
write and refuses a stale bank after a physical profile change.

Settings are 30 bytes plus an optional BLE byte and eight flywheel bytes.
Key maps are 21 or 33 bytes; DPI tables are 48 or 64. Unknown layouts are
rejected. Input length includes status except for the DPI-table response.
Status reads do not switch profiles or write configuration.

The MASTER receiver has been exercised through this driver on Windows, including
identity, battery, the full eleven-slot key map, DPI, lighting and settings.
Write/read-back checks cover key assignment, separate DPI axes, stage values,
colours and count, active stage, polling, LOD, debounce (including 0 ms), Motion
Sync, angle snapping, sensor performance/power-saving mode and lighting.
Coupled normal/deep sleep was accepted at 10/70, 180/240 and 1800/1860 seconds.
These checks verify stored timer bytes, not elapsed sleep/wake timing.
The values survived closing and reopening the HID connection; power cycling has
not been verified. Tests restored fresh snapshots of the user's settings.

Earlier hardware experiments verified stored bank cycling and both kinds of RGB
data across all five banks, with the configurator closed. Other listed interfaces
remain catalogue-based and covered by simulated transport tests only.

## OpenMouse integration

The public `@openmouse/protocol/ajazz/aj200p` subpath exports codecs and the
catalogue. The root namespace is `ajazzAj200p`; the registered WebHID client is
`AjazzAj200pHidClient`. Settings use existing `MouseStatus` fields and setters.
Two optional, declarative `MouseUiHints` additions let consumers keep lighting
controls in one place (`hideAdvancedLighting`) and explain coupled sleep timers
(`sleepNote`). Consumers that do not use these hints remain compatible.

The OpenMouse companion changes enable this family's generic settings cards,
editable per-DPI-stage colours and staged-edit protection when the physical
button switches banks. They are being tested locally and have not yet been
submitted as a separate application PR.
