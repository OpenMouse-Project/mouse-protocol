# Redragon M901 Perdition (`04d9:fc5e`, M901-K-2)

A wired Holtek gaming mouse. `04d9:fc5e` is the **M901-K-2 "Perdition4"**
variant; `mouse_m908` lists it as a generic-protocol device, and
`usb-mouse-config` documents the same DPI codes and memory addresses for the
family. The driver is the shared `src/drivers/redragon/hid.ts` client with the
M901 model descriptor (`src/redragon/m901.ts`).

## Evidence

- **This unit**, USB `04d9:fc5e`, product string `USB Gaming Mouse`,
  manufacturer string empty. Read on Linux over hidraw on 2026-11-07 with
  `HIDIOCGFEATURE`/`HIDIOCSFEATURE` on interface 2.
- **Read-only memory dump** of `0x0000-0x07ff`, in
  `captures/redragon-m901/memory-dump.hex`.
- **Write path**: an idempotent polling write and a DPI round trip
  (1000 -> 800 -> 1000 on the active stage) both read back what was sent. The
  settings memory was byte-identical to the dump afterwards.
- **Public references**: `dokutan/mouse_m908` (PID table: M901-K-2
  "Perdition4" `0x04d9:0xfc5e`, generic support) and
  `ernesto-elsaesser/usb-mouse-config` (same `F2`/`F3`/`F5` framing, the
  `0x42/0x102/0x1b2/0x262/0x312` DPI blocks, the 20-slot keymap addresses,
  the `0x449 + 8p` effect blocks, and the 0xCFF DPI code table).

## USB layout

- IF 0: boot mouse.
- IF 1: boot keyboard.
- IF 2: vendor collection `0xFFA0:0x01`, feature reports 2 (16 B), 3 (64 B),
  4-6 (macros, not used), input reports 7-8.

## Transport

| frame | meaning |
|---|---|
| `02 F3 lo hi len 00 00 00 data<=8` | write `len` bytes at `hi:lo` |
| `02 F2 lo hi len` then GET report 2 | read; answer `02 08 lo 60+hi len 00 FA FA data` |
| `02 F1 02 code` | commit: 01 profile, 02 DPI, 04 lighting, 08 polling and lift-off, 10 after the active stage |
| `02 F5 00` / `02 F5 01` | session bracket |

The one wire difference from the M612/M724 is the answer's byte 3:
`0x60 + addressHigh` here, `0x32 + addressHigh` there.
`RedragonModel.replyAddressBase` carries it; without it the shared decoder
rejects every reply.

## Settings memory (p = profile 0-4)

Same layout as the M724:

| address | bytes | content |
|---|---|---|
| `0x20 + 2p` | 1 | scroll speed (not exposed) |
| `0x2a` | 2 | lift-off `[level, 00]`, 0 low, 1 medium, 2 high |
| `0x2c` | 2 | active profile `[p, 00]` |
| `0x32 + 2p` | 1 | polling code `1000 / Hz` (1, 2, 4, 8) |
| `0x42`, `0x102`, `0x1b2`, `0x262`, `0x312` | 1 | active DPI stage per profile base |
| base + 4 + 6n | 5 | stage n `[enabled, x, xRange, y, yRange]` |
| `0x82 + 4s` + 0xc0p | 4 | button slot s (20 slots per profile) |
| `0x449 + 8p` | 7 | effect `[R, G, B, modeLow, speed, modeHigh, brightness]` |

The factory state read from this unit: active profile 2, all five profiles at
500 Hz, every profile's stages at codes 11, 22, 45, 67, 140 -> 500, 1000,
2000, 3000, 6200 DPI, and a red breathing effect on profile 2.

## DPI

The 0xCFF code table in `usb-mouse-config` matches the M724's exactly
(`0x04`=200 through `0x8c`=6200 range 0, `0x48`=6400 through `0x8c`=12400
range 1), and every observed factory code is an entry. The product page's
higher presets (16400/24000 DPI) are not in this captured table, so the model
caps at 12400 rather than inventing a code.

## Not exposed yet

- **Buttons**: `usb-mouse-config` documents the 20 slot addresses per profile
  and the factory mapping (left/right/middle, DPI up/down, LED toggle, then keys
  1-0/Enter on the side panel). The physical order of the 12 side buttons is
  not verified on this unit, so `buttons` stays unset and the status omits the
  button editor instead of writing a guessed layout.
- **Lighting**: the 7-byte `0x449 + 8p` block is captured, but the effect
  names and the two mode bytes are not verified here. `lighting` stays unset.
