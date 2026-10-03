# Redragon M690 PRO testing notes

The M690 PRO ("MIRAGE PRO", 8000 DPI, wired and 2.4 GHz wireless) is a
SinoWealth design, unrelated to the Holtek M612/M724 protocol in the same
`redragon` entry point. It is a different product from the older M690 /
M690-1 "MIRAGE2" (2400 DPI) and the M690 MAX (S205 sensor, Bluetooth); the
MAX's software is a different platform (an "eevision" app naming a
`VS09M58A` chip) and does not detect the PRO.

| Path | VID:PID | bcdDevice | Product string |
| --- | --- | --- | --- |
| USB cable | `258a:002e` | 2.95, 2.97 | `M690-PRO` |
| 2.4 GHz receiver | `258a:002f` | 6.05 | `M690-PRO` |

Three units were examined: mouse firmware 2.95 (one unit) and 2.97 (two
units), every receiver 6.05. Each mouse ships with its own receiver, paired
to it. A factory-fresh unit's cable and receiver banks were byte-identical;
its receiver bank is the factory fixture in the tests.

The three-position switch (OFF / ON / ECO) also disconnects USB: over the
cable the mouse only enumerates while the switch is on ON or ECO.

`258a:002f` is listed in public USB databases as a generic "SINOWEALTH 2.4G
Wireless Receiver", so other brands may reuse it. The driver therefore also
requires the vendor collection, and checks the settings block is the M690
PRO's before it writes anything (see "Battery and link status in a browser"
for why it cannot use the identify answer, `"2945"`).

## USB shape (USBPcap descriptors, WebHID dump)

- IF 0: boot mouse, 7-byte input `[buttons, x16, y16, wheel, AC pan]`. The
  receiver's descriptor differs cosmetically (75 bytes vs 73; it sets the
  three padding bits, so every receiver report starts `e0`).
- IF 1: keyboard (report 1), consumer control (report 2, 24 one-bit usages),
  and vendor collections `0xFF00:0x01` with feature report 8 (519 bytes),
  input report 7 (7 bytes) and feature report 5 (7 bytes), plus `0xFF01:0x01`
  feature report 6 (7 bytes, never used by the app). The interface-1
  descriptor is byte-identical on every unit and both paths.

Chrome lists one HID device per path with these collections; the mouse and
keyboard collections are protected and hidden.

## Sources

- The official app, `Redragon_M690-PRO_Setup_v1.0_20221125` (Inno Setup;
  `OemDrv.exe` with `Cfg.ini` `VID=0x258A PID=0x002E PID2=0x002F
  Sensor=0x3104`, its `DPISET` list, button table and effect names in
  `Text/en/text.xml`), run on Windows and captured with USBPcap while
  changing one setting per Apply. Text exports: `captures/redragon-m690-pro/`.
- libratbag's `driver-sinowealth.c` (MIT), whose framing this matches with
  report 8 in place of its 4/6: command ids `0x01` (id), `0x11`/`0x12`
  (settings/buttons), the `size - 8` write marker, the polling map, and the
  button type codes. Where the two disagree, the captures win (see Dead
  ends).

## Framing

```
command  SET 5  05 cmd 00 00 00 00 00 00
answer   GET 5  05 cmd ..                 (short commands)
         GET 8  08 cmd 00 00 ..           (blocks; 520 bytes, meaningful prefix only)
write    SET 8  08 cmd 00 len-8 .. block .. [trailer] zero padding
```

| Command | Answer | Meaning |
| --- | --- | --- |
| `01` | `05 01 32 39 34 35` | ASCII `"2945"` on both firmware revisions; through the receiver all zeros until the mouse links (the app retries every ~7 s) |
| `11` / `12` | 154 / 88-byte block | cable bank: settings / buttons |
| `21` / `22` | 154 / 88-byte block | receiver bank: settings / buttons |
| `80` | `05 80 01 01` linked, `05 80 00 ..` mouse off or asleep | receiver only; sent before every write. The last byte read `01` and `02` while off or asleep; its meaning is unknown |
| `90` | `05 90 11 64` | receiver: `11`, battery level 0-100 (`0x64`, later `0x63`); the app showed "80 %" for `0x63`, so it displays coarser steps |
|  | `05 90 10 01` / `10 02` | cable: `01` charging, `02` charged (the app then shows "100 %" and the wheel LED turns green) |
| `30` / `31 n` | macro store / macro read | documented only, see Macros |

Writes, as the app sends them: re-read the settings block, write it whole
with byte `[3] = 0x92` (154 - 8), then rewrite the button block whole with
`[3] = 0x50` (88 - 8) and `a5` after its last byte, even when only one of
them changed. The settings block also ends in `a5 00` when read.

## Receiver

The cable and the receiver keep **separate settings banks**: after
cable-side writes the receiver bank still held its own polling rate, DPI
stages and lighting.

The receiver's bank is a copy of the mouse's settings, and the receiver
answers `01`, `21`, `22` and `90` from it even while the mouse is off. A
write made then does not stick (see Dead ends), so the app checks `05 80`
before writing; with the mouse off it shows "The mouse is now offline,
please move or power on the mouse." and writes nothing. The copy also
follows the mouse live: the active stage byte changes as the DPI buttons are
pressed.

A block write completes only once the mouse has taken it, so a write that
completes has reached the mouse. After the mouse has been idle, the first
write of a batch took 3.9-4.4 s for each of its two reports; later writes
took 170-210 ms, as over the cable.

## Battery and link status in a browser

In short: Chrome cannot ask this mouse for its battery level, charging status
or whether it is awake; OpenMouse Bridge can. Everything else works in Chrome.

The firmware answers `GET_REPORT(Feature 5)` only when it asks for exactly 8
bytes; the app's reads do (`a1 01 05 03 01 00 08 00`). Chrome sends every
feature read with the device's largest feature length, 520 bytes
(`a1 01 05 03 01 00 08 02`, captured over the cable on Windows), and the
mouse STALLs it (`USBD_STATUS_STALL_PID`), which WebHID reports as
"Failed to receive the feature report." Report-8 reads use 520 bytes in both
and work. The receiver and Chrome on macOS behave the same. On macOS,
opening the device needs **Input Monitoring** permission for Chrome (System
Settings -> Privacy & Security -> Input Monitoring, then restart Chrome),
because the vendor collections share interface 1 with the keyboard
collection; without it WebHID reports "Failed to open the device."

Web pages cannot choose the read length, so in a browser:

- the identify answer is unreadable; the driver identifies the mouse from its
  settings block instead (154 bytes, `a5` end marker, byte 9 = `0x13` in every
  block captured: every unit and firmware revision, both banks);
- battery (`0x90`) and the receiver's link check (`0x80`) are tried once per
  connection and otherwise reported as unknown (waiting or retrying does not
  help); without the link check, the status line warns that writes made while
  the mouse is off are undone.

**Through OpenMouse Bridge** (v1.0.0-beta.9, Windows), which reads each
feature report at its own length, every report-5 read succeeded with the
driver unchanged: through the receiver the link check read `00` while the
mouse slept (battery then gives the receiver's last value, which the driver
hides) and `01` once it woke, with battery 99 %, and writes waited for the
link.

## Settings block (`11` / `21`)

| Offset | Meaning | Evidence |
| --- | --- | --- |
| `0x0a` low nibble | polling: 1 = 125, 2 = 250, 3 = 500, 4 = 1000 Hz | 125/250/500 written by the app and confirmed by report interval (8 / 4 / 2 ms over the cable; ~8 / ~4.4 ms through the receiver); 1000 written by OpenMouse and confirmed through the receiver (1 ms) |
| `0x0b` | high nibble active stage (1-based), low nibble stage count (5) | `35` with the 2000 stage highlighted in the app; `15` with the first |
| `0x0c` | disabled-stage mask | always `00` (all five enabled) |
| `0x0d + 2n` | stage n DPI as a 1-based index into the app's list | 250 -> `01`, 500 -> `02`, 1000 -> `04`, 2000 -> `08`, 3000 -> `0c`, 8000 -> `18` |
| `0x0e + 2n` | always `00`; preserved | |
| `0x2d + 3n` | stage n indicator colour, RGB | app squares `00 00 40`; factory red, blue, green, magenta, yellow (`Cfg.ini DC`) after Restore; the app's write of five new colours re-encodes byte for byte |
| `0x45` | effect: 1 Colorful Streaming, 2 Steady, 3 Breathing | 1, 2, 3 written by the app |
| `0x46` | Streaming: brightness << 4 \| speed | `42`, `33`, `12` matching the sliders |
| `0x48` | Steady: brightness << 4 \| colour slot | `00`, `03`, `43`, `45`, `24` |
| `0x4c` | Breathing: brightness << 4 \| speed | `42` |
| `0x4d`, `0x4e` | Breathing colour count (7) and colours | not written by the driver |
| `0x66 + 3n` | Steady colour slots 0-6, the app's swatch row (Restore sets slot 0 to red) | the app recolours the selected slot (`4c 22 8a` into slot 4) |

DPI choices (the app's `DPISET`): 250, 500, 800, 1000, 1200, 1500, 1750,
2000, 2250, 2400, 2750, 3000, 3200, 3500, 3750, 4000, 4500, 5000, 5500,
6000, 6500, 7000, 7500, 8000. These are vendor labels; the driver snaps a
request to the nearest one and reports that value. Brightness and speed are
the app's five slider positions (`Cfg.ini LightUI`/`SpeedUI` 0-4);
OpenMouse shows brightness 1-4 as 25-100 % (0 is Off) and speed 0-4 as 1-5.

The Advanced tab's sensitivity, scrolling speed and double-click speed are
Windows settings: their Apply rewrote both blocks unchanged.

## Button block (`12` / `22`)

Twenty 4-byte slots from offset 8; the app's buttons 1-8 use slots
1, 2, 3, 5, 4, 6, 7, 8 (`Cfg.ini Kn_1`, last byte; a macro assigned to app
button 4 landed in slot 5). Slot 9 holds `50 04` and slots 10-20 `50 01`;
the driver never changes them.

| Bytes | Action | Evidence |
| --- | --- | --- |
| `11 01/02/04/08/10` | left / right / middle / back / forward | factory slots; `11 04` written back by the app |
| `41 01` / `41 02` | DPI up / down | factory slots |
| `31 01 32 03` | "Three click" (repeat button 1, delay `0x32`, count 3) | factory button 8, written back by the app |
| `50 02` | lighting on/off | written by the app |
| `50 01` | disabled | written by the app |
| `21 mods usage 00` | keyboard key: HID modifier bits (1 Ctrl, 2 Shift, 4 Alt, 8 Win) and usage ID | written by the app and sent by the mouse on press as keyboard report 1 (`01 mods usage ..`): Ctrl+Shift+R `03 15`, Alt+A `04 04`, Win+W `08 1a`, and A, `\` (`31`), Delete, Up arrow, F12, Numpad 5 (`5d`) and Backspace unmodified |
| `22 b0 b1 b2` | consumer key, one bit in report 2's order | Refresh -> `22 00 00 20` written by the app |
| `70 n mode count` | macro n | written by the app (`70 01 01 01`) |

## DPI button events (report 7)

The mouse's DPI buttons send `07 1x yy <stage 1-5> <DPI code>` on
interface 1, e.g. `07 10 01 03 08` for stage 3 at 2000 over the cable; the
second byte is `11` through the receiver, as in the `05 90` answer. The
third byte read `01` in most sessions and `04` in one; its meaning is
unknown. The driver reads the active stage from the settings block on each
status refresh instead.

## Macros

Assigning a macro writes `08 30 ..` (macro store) and a `70 n mode count`
slot; at startup the app then reads it back with `05 31 n`. An empty macro
assigned this way made the app report a settings error on its next start
until Restore. OpenMouse has no generic macro editor, so the driver shows
macro slots as `Macro n`, never writes macros, and never sends `30`/`31`.

## Dead ends

Tried and ruled out, so nobody repeats them:

- **Collecting short answers from report 8.** After `05 01` or `05 90`, a
  report-8 read STALLs as well; report 8 answers only after a block command
  (`11`/`12`/`21`/`22`).
- **DPI as `raw * 250`.** It fits 500-3000 but not 8000 (`0x18`, not `0x20`);
  the byte is a position in the vendor's DPI list.
- **`e0` as a receiver link marker.** Every mouse report through the receiver
  starts `e0` (the descriptor's padding bits are set); it carries no link
  state.
- **libratbag's command names.** Its "profile 2" (`21`/`22`) is this mouse's
  receiver bank and its "profile 3" (`31`) is the macro read; there are no
  onboard profiles to switch.
- **Writing through the receiver while the mouse is off.** The receiver
  accepts and reads back the write, but the mouse undoes it on reconnect
  (polling written `03` with the mouse off read back `01` once it was
  switched on, with no write in between).
- **Keeping a lighting value "unchanged when equal to what is shown"** (the
  M612 driver's rule). Here it broke effect switches: Wave at speed 4, then
  Breathing with the panel showing speed 4, kept Breathing's stored speed 1.
  The driver applies the requested values instead.
- **Running the vendor app alongside OpenMouse.** It shares the vendor
  channel even when minimised, and the receiver's copy changes between a
  write and its read-back, so writes fail. Close it first.

## Hardware verification status

Three units (mouse firmware 2.95 and 2.97, receiver 6.05). Protocol from the
vendor app's traffic; driver behaviour through OpenMouse with the local
package build in Chrome 154 on Windows, with USBPcap recording the wire, and
read-only on Chrome for macOS.

- [x] Detection and `readStatus` over the cable (`002e`) on both firmware
      revisions and through the receiver (`002f`), across reconnects.
- [x] Every write matched the requested change on the wire and read back
      identically, over both paths; changes made in OpenMouse appear in the
      vendor app afterwards.
- [x] DPI stage values set and felt; the active stage selected from
      OpenMouse and felt.
- [x] Polling 125 / 250 / 500 / 1000 Hz: the mouse's report interval followed
      each write (8 / 4 / 2 / 1 ms; through the receiver ~8 / ~4.4 / ~2.6 /
      ~1.4 ms), so code `04` = 1000 Hz is confirmed.
- [x] DPI indicator colours: shown on the LEDs as each stage was selected and
      in OpenMouse's stage editor; the driver's colour write re-encodes the
      vendor app's byte for byte.
- [x] Lighting by eye: Static colours and brightness, Wave and Breathing
      speeds (5 fastest), Off.
- [x] Button remaps felt (wheel click -> Right click, -> Volume up), then
      restored.
- [x] Keyboard keys assigned from OpenMouse and felt: single keys, Print
      Screen, and Copy (Ctrl+C).
- [x] Receiver with the mouse off: a write is accepted and later undone by
      the mouse on reconnect; the status line warns about this.
- [x] Battery and link reads (report 5) fail in Chrome on Windows (cable and
      receiver, USBPcap) and on macOS (receiver); settings reads and all
      writes work.
- [x] Through OpenMouse Bridge (receiver): OpenMouse labels the device
      "Bridge" and shows the battery (99 %); report-5 reads succeed (USBPcap:
      wLength 8), the link check gates writes, and writes read back.
- [x] OpenMouse's built-in hardware test passed on all four paths (cable
      and receiver, Chrome and Bridge): identity, DPI, polling, stages and
      link read back, and 800 DPI / 1000 Hz written, read back and restored;
      battery (receiver) and charging status (cable) through Bridge. Through
      Bridge the polling sampler saw dropouts (60 Hz against 500), so there
      the rate was read back but not measured; in Chrome it measured 452 Hz
      at 99 % stability over the cable (`captures/redragon-m690-pro/
      openmouse-hardware-test-*.json`).
- [x] `REDRAGON_M690_PRO_PRODUCTS` marks `002e` and `002f` as verified.

## Not decoded or not exposed

- Macros (see above), and keyboard keys with right-hand modifiers (bits
  `10`-`80`), which show as their raw bytes.
- Disabling DPI stages (`0x0c`), the stage count, and Breathing's colours.
- Feature report 6 (`0xFF01`), which the app never used.
- The ECO switch position; nothing in the captured traffic changes with it.
  In ECO the body's lighting effects stay off and only the scroll wheel
  lights; switch to ON to see them.
- Signal strength: the vendor app shows none, and no answer byte was found to
  carry it, so the driver reports none.
- Per-stage DPI indicator colours are read and written
  (`setDpiStageColor`), but OpenMouse currently only writes them when
  applying a saved game profile: the stage editor's per-stage colour picker
  was dropped in openmouse `0fc6ae1`. The driver needs no change if it
  returns. These colours also light the scroll wheel, which shows the
  active DPI stage's colour under every effect, Off included.
