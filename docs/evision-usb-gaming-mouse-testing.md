# Evision USB Gaming Mouse (`04d9:fc5e`)

A wired Holtek gaming mouse sold under Evision's brand. It runs the same
RDCfg OEM firmware family as the Redragon M612/M724, so the driver is the
shared `src/drivers/redragon/hid.ts` client with an Evision model descriptor
(`src/redragon/evision.ts`).

## Evidence

- **This unit**, USB `04d9:fc5e`, product string `USB Gaming Mouse`,
  manufacturer string empty. Read on Linux over hidraw on 2026-11-07 with
  `HIDIOCGFEATURE`/`HIDIOCSFEATURE` on interface 2.
- **Read-only memory dump** of `0x0000-0x07ff`, in
  `captures/evision-usb-gaming-mouse/memory-dump.hex`.
- **Write path**: an idempotent polling write and a DPI round trip
  (1000 -> 800 -> 1000 on the active stage) both read back what was sent. The
  settings memory was byte-identical to the dump afterwards.

No vendor application or vendor documentation was used. The memory layout
and code table below are borrowed from the M724, whose RDCfg model (`0xCFF`)
this firmware matches; only the differences observed on this unit are
asserted.

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

The one wire difference from the M724 is the answer's byte 3: `0x60 + addressHigh`
here, `0x32 + addressHigh` there. `RedragonModel.replyAddressBase` carries it;
without it the shared decoder rejects every reply.

## Settings memory (p = profile 0-4)

Same layout as the M724:

| address | bytes | content |
|---|---|---|
| `0x20 + 2p` | 1 | scroll speed (not exposed) |
| `0x2a` | 2 | lift-off `[level, 00]`, 0 low, 1 medium, 2 high |
| `0x2c` | 2 | active profile `[p, 00]` |
| `0x32 + 2p` | 1 | polling code `1000 / Hz` (1, 2, 4, 8) |
| `0x40 + 2p` / `0x100 + 2p` / ... | 1 | active DPI stage 0-4 per profile base |
| base + 4 + 6n | 5 | stage n `[enabled, x, xRange, y, yRange]` |
| base + 0x42 + 4s | 4 | button slot s |
| `0x448 + 8p` | 8 | lighting `[flag, R, G, B, mode, speed, kind, brightness]` |

The factory state read from this unit: active profile 2, all five profiles at
500 Hz, every profile's stages at codes 11, 22, 45, 67, 140 -> 500, 1000,
2000, 3000, 6200 DPI on the M724's 0xCFF table, and a red breathing block on
profile 2.

## DPI

The observed codes are all entries in the M724's 0xCFF table
(`REDRAGON_M724_DPI_CODES`), so the labels and encoder are reused. The
highest label (12400) was not written to this unit; the range above 6200 is
the table's, not an observed hardware limit.

## Not exposed yet

- **Buttons**: the button block is 4-byte slots like the M724's, but this
  unit maps side keys to keyboard usages at offsets the M724 descriptor calls
  wheel up/down. Until the physical button names are captured, the model
  leaves `buttons` unset and the status omits the button editor.
- **Lighting**: the `0x448` blocks hold the same eight-byte shape, but the
  effect table is not known to match the M724's. `lighting` is left unset.
