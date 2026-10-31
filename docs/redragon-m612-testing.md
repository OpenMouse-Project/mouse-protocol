# Redragon Predator M612 testing notes

Wired only (`04d9:fc61`, Holtek, bcdDevice 1.10). RDCfg calls this model
"2850". Not to be confused with the M612 PRO (`3554:f55e`, Compx), which
uses an unrelated protocol.

## USB shape (sysfs report descriptors, Linux)

Same three interfaces as the M724 K1NG 1K; the config channel is interface 2:

- IF 0: boot mouse, 8-byte input `[buttons16, x16, y16, wheel, pan]`
- IF 1: boot keyboard (macros)
- IF 2: consumer control (report 1) plus vendor collection `0xFFA0:0x01`
  with feature reports 2-6 and input reports 7-8. Report 2 declares 15
  bytes; a plain `GET_FEATURE` answers 8 (`02 08 .. .. 00 00 FA FA`).

`RedragonHidClient.isSupported` therefore matches unchanged once the PID is
in `REDRAGON_PRODUCTS`.

## Sources

- RDCfg 1.0.58 (the Windows download on Redragon's M612 page) run under
  Wine on an Xvfb display, captured with `dumpcap -i usbmon3`. Its runtime
  `Config.ini` lists `PID 64609` (`0xfc61`) as `PRODUCT_NAME=2850`.
- Startup push: RDCfg writes the whole saved profile when it starts.
- GUI edits driven with `xdotool`, one Apply per change, each diffed
  against the previous capture.
- hidraw probes (`HIDIOCSFEATURE`/`HIDIOCGFEATURE`) for the read command,
  which RDCfg never uses. The command byte comes from dokutan/mouse_m908's
  M908 reader.

## Frame format

The M724 notes describe writes as `[02 F3 sub profile section ...]`. On the
M612 the same bytes are an address, a length, and data:

```
write  02 F3 addrLo addrHi len 00 00 00 data[len]...     (len <= 8)
read   02 F2 addrLo addrHi len 00 ...                    then GET_FEATURE
answer 02 08 addrLo 32+addrHi len 00 FA FA data[len]
```

- Reads work with or without the `F5 00` / `F5 01` bracket. The driver
  reads without it, so status polling never opens a vendor session.
- After an answer is consumed, the next plain GET is the 8-byte header
  again, so the `FA FA` probe keeps working between reads.
- Writes use the M724 envelope: `F5 00`, the write, the `F1 02`
  `04 01 02 08 10` commit block, `F5 01`.

## Settings map

| Address | Length | Meaning |
| --- | --- | --- |
| `0x002c` | 1 | active profile, 0-4 |
| `0x0032` | 6 | `[1000/Hz, 00, ...]` per profile: profile p's code is at `0x32 + 2p` (RDCfg's `SendPollRate` writes all five; see `redragon-m724-testing.md`). The captures changed profile 1's rate only |
| `0x0038` | 4 | polling codes of profiles 4-5 (`02 00 02 00` = 500 Hz) |
| `0x003c` | 1 | enabled-stage mask (`0x1f`) |
| base `+0` | 1 | active DPI stage, 0-4 (the DPI button moves it) |
| base `+2+6n` | 5 | stage `n`: `[enabled, x, xRange, y, yRange]` |

Profile bases: `0x42, 0x102, 0x1b2, 0x262, 0x312`. Profile 1's slots are the
M724's `0x44 0x4A 0x50 0x56 0x5C` subcommands.

Report 3 (64 bytes) `03 F3 20 00 0A ...` carries scroll speed in its first
data byte (1 -> 3 when the RDCfg spinner moved 1 -> 3). The driver does not
write it. Pointer speed and double-click speed are Windows-only settings
and send nothing.

## DPI

RDCfg's slider has 146 positions, 500-8000:

- positions 0-92: `value = 14 + p`, range 0 (500-4000)
- positions 93-145: `value = p - 39`, range 1 (4100-8000; range 1 doubles)

Apply captures: positions 0-6 -> `0e..14`, 93 -> `36/1`, 94 -> `37/1`,
120 -> `51/1`, 144 -> `69/1`, 145 (8000) -> `6a/1`. Factory push: 500, 1000,
2000, 3000, 4000 -> `0e 1b 35 4f 6a`.

The labels are rounded vendor values, not a formula (code 14 is labelled
500, although 4000/106 per count would give 528). The driver therefore
carries the full label table (`REDRAGON_M612_DPI_LABELS`). The table was
read from screenshots of every slider position, then checked by matching
each label's bitmap-font glyphs: one template per digit, 146/146 labels
decoded identically. Requests snap to the nearest label, and the driver
returns and reports that label.

## Polling rate

RDCfg's four choices each changed only byte 0 of `0x0032`: 125 -> `08`,
250 -> `04`, 500 -> `02`, 1000 -> `01`. The driver reads the 6-byte block
and rewrites byte 0 only.

## Profiles

Five onboard profiles; `0x2c` holds the active one (0-4). RDCfg's MODE menu
writes it immediately, **outside** any `F5` bracket:

```
02 F3 2C 00 02 00 00 00 [profile, 00]
02 F1 02 01
02 F1 02 04 / 01 / 02 / 08 / 10
```

DPI stages, the active stage, button maps, and polling are per profile;
lighting is global. `setProfile` replays that sequence byte for byte.

## Lighting

Global (not per profile). `0x446` selects the effect with one bit
(`[bit, 00]`), and each effect keeps its own 8-byte block
`[flag, R, G, B, kind, speed, ?, brightness]`:

| RDCfg effect | bit | block | colour | speed | OpenMouse mode |
| --- | --- | --- | --- | --- | --- |
| WAVE | `01` | `0x448` | - | yes | Wave |
| 7 COLOR BREATHING | `02` | `0x450` | - | yes | Breathing random |
| BREATHING | `04` | `0x458` | yes | yes | Breathing single |
| FLASH | `08` | `0x460` | yes | yes | (none: reported as no mode) |
| FULL LIGHTED | `10` | `0x468` | yes | - | Static |
| OFF | `20` | - | - | - | Off |

Speed byte: 8 (RDCfg's slowest slider position) to 1 (fastest); OpenMouse
shows it as 1-8 with 8 fastest. Brightness byte: RDCfg's three slider
positions, 1-3, shown as 33/67/100%. Each was mapped by changing one
control per Apply and diffing the blocks. The commit codes
`04 01 02 08 10` equal the effect bits.

## Buttons

Eleven 4-byte slots per profile at bases `0x82, 0x142, 0x1f2, 0x2a2,
0x352`, offsets `+0x00`...`+0x20` for RDCfg buttons 1-9 and `+0x28`/`+0x2c`
for wheel up/down (no slot at `+0x24`). Factory values, same in every
profile: left `81`, right `82`, middle `83`, fire `99 81 03`, forward `85`,
back `84`, DPI up `8a`, DPI down `89`, lighting cycle `9b 08`, scroll up
`8b`, scroll down `8c`.

Captured from RDCfg (button 9 of profile 2, then batches on buttons 4-9):
DPI cycle `88`, profile cycle/up/down `8d`/`94`/`95`, polling up/down
`97`/`98`, disabled `00 00 00 00`. Keyboard assignments are
`[8F, modifiers, usage]` with HID modifier bits (1 Ctrl, 2 Shift, 4 Alt,
8 Win): Ctrl+V `8f 01 19`, Ctrl+A `8f 01 04`, Ctrl+F `8f 01 09`, Ctrl+N
`8f 01 11`, Alt+Tab `8f 04 2b`, Alt+F4 `8f 04 3d`, Win+E `8f 08 08`,
Win+R `8f 08 15`, Win+D `8f 08 07`, Win+L `8f 08 0f`.

The driver offers the captured actions, RDCfg's named shortcuts (plus
Undo/Redo), and single keys (`8f 00 usage`). Any other value decodes to
its keys, or to its raw bytes, and stays shown. It refuses to remove a
profile's last left click.

## Hardware verification status

All on one unit, Linux, Chrome 154 (Flatpak) WebHID, OpenMouse BETA v2.0.1
with the local package. "Pressed" results come from the mouse's own
interrupt-IN reports in usbmon captures.

- [x] `isSupported` shape matches the sysfs descriptor.
- [x] Every `readStatus` field matches RDCfg's state: profile, active stage,
      five stages, polling, lighting, and the 11 button slots.
- [x] OpenMouse's built-in hardware test passed: identity, DPI, stage and
      polling read-back, flash write round-trips, and polling sampling at
      500 Hz (`captures/redragon-m612/openmouse-hardware-test.json`).
- [x] Polling applies live: interrupt-IN timing went 500 -> 250 -> 1000 Hz
      right after the app's writes.
- [x] Active-stage switching from the app UI was stored, read back, and
      felt.
- [x] Editing the active stage's value applies live: stage 3 went
      2000 -> 500 -> 1100 from the app. The user felt each change, and
      usbmon motion shrank then grew (p99 counts per report
      9.2 -> 3.2 -> 7.1 at a steady 1000 Hz).
- [x] Profiles: 1 -> 2 -> 1 from the app, read back, and felt as the DPI
      changed with the profile.
- [x] Lighting from the app, confirmed by eye: Static in three colours, Off,
      Breathing single with colour and speed changes, Breathing random with
      speed and brightness changes, and Wave.
- [x] Buttons from the app, each confirmed from what the button then sent:
      right -> Left click (left-click reports), wheel click -> Right click
      (right-click report), Key A (keyboard usage `04`), Copy (Ctrl + `06`),
      Scroll down (wheel -1 per press), DPI cycle (the mouse's own report 8
      stepping through stages 4, 5, 1, 2, 3), and Disabled (no report).
      All were then restored to factory.
- [x] `REDRAGON_PRODUCTS` marks `0xfc61` as verified.

## Not decoded or not exposed

- Macros: OpenMouse has no generic macro editor, so they stay in RDCfg.
  Slots holding a macro show as a vendor action.
- RDCfg's FLASH lighting effect: no matching OpenMouse lighting mode.
- RDCfg's media and browser keys, and its Advance dialogs (fire speed and
  count, sniper DPI, key combos beyond the named shortcuts): not captured.
  Button 4's factory rapid fire is offered exactly as shipped.
- The enabled-stage mask at `0x3c`: the stage count stays fixed at 5.
- Report 3 beyond scroll speed.
