# Zaunkoenig WebHID protocol

Source: the public [Zaunkoenfigurator](https://zaunkoenig.co/zaunkoenfigurator), inspected 2026-08-11. The implementation mirrors the shipped browser code; it has not yet been verified on physical hardware.

## Devices and interface

| Model | VID:PID | Vendor usage page | DPI range | LOD values |
| --- | --- | --- | --- | --- |
| M3K | `0483:a462` | `ff00` | 50–20,000, step 50 | 1, 2, 3 mm |
| M2K | `0483:a3cf` | `ff00` | 100–12,000, step 100 | 2, 3 mm |

The configurator requires a top-level collection on usage page `0xff00`. It reads feature report 2 for a NUL-terminated firmware string and accepts firmware containing `parawizard new v0.8`. Feature report 3 carries the configuration.

## Configuration report

The first two configuration bytes are one little-endian word:

| Bits | Mask | Meaning |
| --- | --- | --- |
| 15 | `8000` | Primary button: 0 left, 1 right |
| 14 | `4000` | Angle snapping |
| 13 | `2000` | USB speed: 0 Full-speed, 1 High-speed |
| 12–11 | `1800` | Polling interval: 0=8 kHz, 1=4 kHz, 2=2 kHz, 3=1 kHz |
| 10–9 | `0600` | LOD: M3K code + 1 mm; M2K code in mm |
| 8–0 | `01ff` | DPI index: `(index + 1) * model step` |

Full-speed USB is effectively limited to 1 kHz, but the interval bits remain stored and become active again on High-speed USB.

For a normal write, call `sendFeatureReport(3, [configLo, configHi, 0x00, 0x00])`, then read report 3 and confirm the resulting word. The factory-reset payload is `[0x00, 0x00, 0xff, 0xff]`.

The M3K factory defaults documented by Zaunkoenig are High-speed USB, 8 kHz, 2 mm LOD, angle snapping off, left primary, and 800 DPI. The corresponding configuration word is `0x220f`.

## Implementation

- Codec and constants: `src/zaunkoenig/index.ts`
- WebHID client: `src/drivers/zaunkoenig/hid.ts`
- Codec and transport tests: `src/drivers/zaunkoenig/*.test.ts`

Before marking the device table as verified, capture report 2 and report 3 from an M3K, apply each setting separately, confirm the readback, and restore the starting word. Avoid factory reset during the first hardware pass.
