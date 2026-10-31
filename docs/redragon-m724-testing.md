# Redragon M724 K1NG 1K (`04d9:fc7a`)

Holtek wired mouse, 5 onboard profiles. It shares the transport and memory
layout of the Predator M612 (`docs/redragon-m612-testing.md`); the driver is
one client (`src/drivers/redragon/hid.ts`) with a per-model descriptor
(`src/redragon/m724.ts`, `src/redragon/m612.ts`).

## Sources

- **Static analysis of RDCfg.exe**, the vendor app (sha256
  `ddfab8823bec7c0c865325fc8c5f801a70f628391445c028deb43dc5f1dd7294`),
  with REA/Ghidra. Function addresses below are in that binary.
- **hidraw on Linux**: `F2` reads of the whole settings memory and bracketed
  writes, each read back (`HIDIOCSFEATURE` / `HIDIOCGFEATURE` on MI_02).
  Results in `captures/redragon-m724/`.
- Each write was confirmed on the mouse: DPI and stages by feel, polling by
  the interval between interrupt-IN reports, LED by sight, buttons by the
  keyboard-interface report they produced.

## USB layout (`usbhid-dump`)

- IF 0: boot mouse, 8-byte input.
- IF 1: boot keyboard (key and shortcut assignments).
- IF 2: vendor collection `0xFFA0:0x01`. Feature reports 2 (16 B), 3 (64 B),
  4-6 (macros, not used), input reports 7-8.

## Transport

| frame | meaning |
|---|---|
| `02 F3 lo hi len 00 00 00 data≤8` | write `len` bytes at `hi:lo` |
| `02 F2 lo hi len` then GET report 2 | read; answer `02 08 lo 32+hi len 00 FA FA data` |
| `03 F2 lo hi 20` then GET report 3 | 32-byte read (RDCfg `QueryDpi`); works on the M724, not used by the driver |
| `02 F1 02 code` | commit: 01 profile, 02 DPI, 04 lighting, 08 polling and lift-off, 10 after the active stage |
| `02 F5 00` / `02 F5 01` | session bracket |

RDCfg brackets only its full push (`FUN_0044fd20`); its per-setting Apply
paths send the write and that area's commit. The driver brackets every write
and sends the whole commit block `04 01 02 08 10`, which RDCfg sends after
button writes (`FUN_0044b740`).

A write without its commit is stored but runs only after replug. The
profile byte is the exception that needs more: `F1 02 01` alone stores the
new profile but keeps the old one running; with the whole block after it the
LED and DPI of the new profile apply at once.

## Settings memory (p = profile 0-4)

Profile bases come from RDCfg's table at `0x49f7c0` (`0x40 0x100 0x1b0 0x260 0x310`).

| address | bytes | content | RDCfg |
|---|---|---|---|
| `0x20 + 2p` | 1 | scroll speed (report-3 write `03 F3 20 00 0A`); documented, not exposed | `FUN_0044a140` |
| `0x2a` | 2 | lift-off `[level, 00]`, 0 low (factory), 1 medium, 2 high | `FUN_0044a9e0` |
| `0x2c` | 2 | active profile `[p, 00]` | `FUN_0044ab40` |
| `0x32 + 2p` | 1 | polling code `1000 / Hz` (1, 2, 4, 8) | `FUN_00449f10` |
| `0x3c` | 1 | `1f` | `FUN_0044d860` |
| base + 2 | 1 | active DPI stage 0-4 | `FUN_0044a230` |
| base + 4 + 6n | 5 | stage n `[enabled, x, xRange, y, yRange]` | `FUN_0044a380` |
| base + 0x42 + 4s | 4 | button slot s | `FUN_0044eb80` |
| `0x448 + 8p` | 8 | lighting `[flag, R, G, B, mode, speed, kind, brightness]` | `FUN_004495e0` |

Polling is per profile on the M612 as well: its factory push writes
`0x32 = 02 00 02 00 02 00` and `0x38 = 02 00 02 00`, the 500 Hz of all five
profiles.

### Model selection

RDCfg reads `Default.bin`: model code `Name1 ^ Name2` = 10631 ^ 9592 =
`0xCFF`, `Light=0`, `LIFT=0`, `Count=5`, `Wheel=10`. `LIFT=0` hides the
lift-off control for the M724, but the mouse keeps a value written at `0x2a`
and the tracking height changes.

### DPI

Slider positions 1-92 (`FUN_004288f0`), labels from `FUN_004237a0`:
200-6200 in steps of 100, then 6400-12400 in steps of 200. Codes come from
the dword table at `0x49f13c`; range 1 doubles the step, so 6400-12400 reuse
the code of half their value.

| DPI | wire |
|---|---|
| 800 | `12 / 0` |
| 1200 | `1b / 0` |
| 1600 | `24 / 0` |
| 2400 | `36 / 0` |
| 3500 | `4f / 0` |
| 5500 | `7c / 0` |
| 12400 | `8c / 1` |

The first driver read the slot writes as `[F3 sub profile section ...]` with
`code = dpi * 9 / 400`. The bytes were really `addrLo addrHi len`, and the
formula is only close to RDCfg's table.

### Lighting

`FUN_004495e0` with `Light=0` writes bytes 1-7 of each profile's block, then
`F1 02 04`. Speed is `9 - slider` (1 fastest, 8 slowest), brightness 1-3.

| effect | mode | kind | OpenMouse |
|---|---|---|---|
| FULL LIGHTED | 1 | 1 | Static |
| BREATHING | 2 | 1 | Breathing single |
| 7 COLOR BREATHING | 2 | 3 | Breathing random |
| RAINBOW | 3 | 1 | Spectrum |
| FLASH | 4 | 1 | Single Flash |
| WAVE | 5 | 1 | Wave |
| OFF | 0 | 0 | Off |

### Buttons

`FUN_0044fbf0` writes slots 0 to `Count - 1` and the wheel to slots
`Wheel` and `Wheel + 1` (10 and 11). The mouse also holds slots 5 and 6: the
DPI button (`88`) and the profile button (`8d`).

Actions come from RDCfg's 56-entry table at `0x49f280`
(`[fun, b0, b1, b2, b3]`): the M612's codes, except the lighting cycle, which
is `9b 04` under `Light=0`. RDCfg writes a single key as `90 00 usage 00`
and a combination as `8f modifiers usage 00`. Media keys are
`8e 01 usage`, on the consumer page.

## Confirmed on hardware (2026-10-31)

| write | result |
|---|---|
| profile 1 stage 1 → 1600 | cursor about twice as fast |
| profile → 2 with `F1 02 01` only | stored; LED and DPI unchanged |
| profile → 2 with the whole block | profile 2's red breathing and 2400 DPI |
| profile 2 active stage → 4 | 2400 → 5500 DPI |
| profile 2 polling → 125 Hz | median report interval 8.00 ms; back to 1000 Hz, 1.00 ms |
| profile 2 LED → static green | solid green |
| profile 2 front side button → `90 00 04 00` | keyboard interface sends usage `04` (A) |
| lift-off → 2 | tracking stops at a different height |

Every test was restored afterwards and a fresh dump matched
`memory-dump.hex` byte for byte.

## Not covered

- Macros (report 4, `FUN_0044db70`) and RDCfg's sniper, fire-key editor and
  browser keys (`8e 01 ff id`, meaning unclear).
- Scroll speed: mapped above, but OpenMouse has no device-side scroll-speed
  control yet.
- Which stages the DPI button cycles: the stage `enabled` byte is kept as
  read.
