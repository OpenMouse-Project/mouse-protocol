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

## Supported settings

- Five firmware-managed onboard banks; edit the active bank after selecting it.
- Seven button entries; ULTRA+ and MASTER add four wheel/tilt entries.
- Mouse buttons, keyboard keys/modifiers, consumer controls, DPI actions and
  disabled buttons. Existing shortcuts, macros and unknown actions are preserved.
- Eight DPI slots, active slot and enabled slot count, separate X/Y values and
  per-slot RGB colours. Legacy sensors use six-byte/50-DPI entries. PAW3955 uses
  eight-byte entries with independent 20-bit axes, 1–80000 DPI.
- Model/connection-specific polling rates, LOD where supported, debounce,
  Motion Sync, angle snapping and normal sleep timeout.
- A separate DPI lighting theme colour, off/static/breathing, brightness and speed.

Three-state ripple control, deep sleep, BLE options and flywheel tuning are
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

The MASTER receiver has been read through this driver on Windows, including
identity, battery, all eleven mappings, DPI, lighting and settings. Earlier
hardware configuration experiments verified stored bank cycling and both kinds
of RGB data across all five banks, with the configurator closed. Further write
validation and OpenMouse integration checks are in progress for this draft.
