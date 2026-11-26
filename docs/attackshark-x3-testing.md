# Attack Shark X3 testing notes

Native X3 support (2.4 GHz receiver `1d57:fa60`, wired `1d57:fa61`). The
protocol is taken from the MIT licensed repo enthonyaraujo/attacksharkx3-linux,
read only. **No part of it has been run against our own X3 hardware yet.**
Settings are HID feature reports on the config collection (usage page `0x000B`,
interface MI_02), which browsers cannot reach, so this runs through OpenMouse
Bridge or the desktop app.

## Identity

| Path | VID:PID | Config collection | Battery collection |
|---|---|---|---|
| Receiver | `1d57:fa60` | usage page `0x000B`, MI_02 | usage page `0x000A`, input report `0x03` |
| Wired | `1d57:fa61` | same | same |

The X3 path is gated on the receiver message naming model id `0x4d`
(`03 <model> 40 01 <pct>`) plus the X3 product ids. Any other model id keeps
today's behaviour.

## Reports (all feature reports, report id first)

| Id | Length | Content |
|---|---|---|
| `0x0C` | 10 | commit lead `0C 0A 01 FE 01 FE 00 00 00 00` |
| `0x04` | 56 | LOD, ripple, stage mask, angle snap, motion sync, 8 DPI slots (raw = dpi/50 - 1), active stage, 8 RGB colours, checksum at 50..51 |
| `0x05` | 15 | deep sleep, sleep (half minutes), debounce (2 ms units), checksum at 11..12 |
| `0x06` | 9 | polling code and complement |
| `0x08` | 59 | 18 button slots of 3 bytes, checksum at 57..58 |
| `0x09` | 64, 64, 12 | macro upload chunks, slot 2, checksum over the 128 byte block from offset 0 |

The X3 has no read-back. The library keeps the full settings per product id and
every change sends the whole burst in the order `0C, 04, 05, 06, 08`. The UI
therefore shows defaults until the first write, and the first write overwrites
settings changed elsewhere (this matches the reference).

## Pacing

500 ms after every report of a burst on the receiver, 15 ms on wired, as in the
reference, which saw polling changes ignored on the receiver at 15 ms. A burst
takes about 2.5 s on the receiver. The wired 15 ms value was not validated, and
the reference's own analysis of the vendor app suggests it may use 500 ms on
wired too. Macro chunks use 15 ms on both.

## Buttons, macros, profiles

- Remappable: Left, Right, Middle, Forward (slot 6), Back (slot 7). Actions:
  clicks, Forward/Backward, double click, fire, scroll, DPI cycle/+/-, Easy Aim,
  media, My Computer, Browser Home, Off, Macro, and keyboard shortcuts typed as
  `Ctrl+Shift+Alt+Win+<key>` (A-Z, 0-9, F1-F12, Enter, Esc, Backspace, Tab, Space).
- Slots 3, 4, 5 and 8 (factory `0D`, `3C`, `0F`, `3C`) are never touched; their
  physical buttons are unknown. At least one slot must stay Left Click.
- Macros: key press and release events, up to 50, slot 2 only.
  `uploadMacro({events})`, then `setButtonMapping(button, "Macro")`. The
  protocol has no delays, mouse-button events or repeat modes.
- Profiles: not supported. The protocol has one profile (byte `0x01`) and no
  select report.

## Battery

Battery is derived from the reference (`03 10 [raw] 01 09` on usage page
`0x000A`, voltage = raw/16, reference lithium curve, charging = flag bit 1) and
is not yet confirmed on our hardware.

## Model id question: 0x4d versus 0x10

The `DeviceId` table names `0x4d` as X3, but the battery packet starts
`03 10`, the same shape as an R1 message (`0x10`). Once `0x4d` has been learned
the library routes `03 10 xx 01 09` to the X3 battery parser. Before that, such
a packet still reads as an R1. If a real X3 never sends a `0x4d` message, the
X3 path never activates. Wired `fa61` receives no receiver messages, so it can
not be named `0x4d` and stays read-only until the maintainer picks an
identification source.

## Unknowns

Wired identification, factory `0x3C` slots, byte 49 `0x01` and trailing zeros of
`0x04`, power byte 8 `0xFF`, whether a commit is needed after a macro upload,
LOD naming (Low = 1 mm, High = 2 mm), battery scale and charging bit.

## Steps for a tester with a real X3 (through Bridge)

1. Plug in the receiver, open OpenMouse through Bridge, export the diagnostic
   and confirm the collections include `0x000B` and `0x000A`, and the device is
   named Attack Shark X3 (model id `0x4d`). If it is named R1 or unnamed, stop
   and report the receiver message bytes.
2. Change polling to 500, 250, 125 and 1000, waiting about 3 s each, and check
   with a polling-rate tool (evhz) that it applies.
3. Change DPI stage values, active stage, stage count and colours; confirm the
   cursor speed and LED colour follow.
4. Toggle lift-off, ripple, angle snapping and motion sync; set sleep and
   debounce. Confirm a polling change afterwards did not reset them.
5. Remap Forward to `Ctrl+X`, Back to DPI Cycle, Middle to Play/Pause; verify
   each, and that Left cannot be set to Off.
6. Upload a macro (7 taps of key `0x06`), bind it with `Macro` and press the
   button. Report whether it plays or needs a follow-up commit.
7. Watch the battery value for a while, then plug in charging, and report the
   raw bytes of `03 10 xx 01 09` against a known charge level.
8. If you own a wired `fa61` unit, report what the diagnostic shows.
