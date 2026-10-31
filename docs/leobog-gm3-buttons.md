# LEOBOG GM3 button assignment

Reverse engineered from the vendor application
(`C:\Program Files (x86)\LEOBOG\Gm3\OemDrv.exe`, build `3.14 v2.0 20250313`)
on 2026-10-26. Everything below is static analysis of the shipped binary plus
one live Frida capture of its HID traffic.

## The write command is `01 00`

The button table is written with vendor command `01 00`, an 80-byte payload,
four bytes per slot. A capture of the vendor UI while bindings were changed
shows the whole table re-sent on every edit:

```text
09 <chk> 01 00 01 00 50 00 <80 payload bytes>
```

Slots are `left, middle, right, button4, button5, special` in the vendor's own
order — note that its HID numbering puts *middle* on 2 and *right* on 3, the
opposite of the usual convention.

The single `01 00` frame is enough: writing it alone (no follow-up block write,
unlike the vendor's save sequence) and then pressing the remapped button
confirmed the device applies it. Verified on 2026-10-26 by setting the forward
button to `00 00 00 00` — the side button stopped responding entirely — and
restoring the factory table afterwards.

## The device cannot read the table back

- A read-only sweep of commands `00`-`0E` finds no reply that returns the
  table; `01 00` used as a read answers with the previous reply buffer.
- Writing a distinctive table changes **zero** bytes of the readable `44 00`
  configuration block, so the table is not stored there.
- The vendor application itself never reads it: every `HidD_GetFeature` it
  issues is for `44 00`. Its UI is filled from its local cache
  (`%LOCALAPPDATA%\BYCOMBO4\LEOBOG Gm3\profile.dct`).

Consequence for OpenMouse: the write path can be implemented, but the current
binding has to be tracked locally, the same way the K-snake macro card does.

### Restoring the factory table

The vendor dialog's 恢复默认 rewrites every slot at once, which is the same
`01 00` frame with the factory bindings in it, so `resetButtonMappings()` sends
exactly that table. `Left`, `Middle` and `Right` are the plain click actions and
`DPI` is the `05 04 00 00` binding above. `Forward` and `Backward` follow from
the vendor's default profile (`01 04 01 00` and `01 05 01 00`) rather than from
a capture, so treat those two slots as inferred, not measured.

## Encoding

The vendor stores a binding as a two-byte `(category, code)` pair — this is the
pair seen in `Dev\ms\3311-1\MS.ini` `[KEY]` entries and in `profile.dct`. The
binary converts it to the four-byte wire value with a family of jump tables
around RVA `0x92xxx`; each case is a `mov eax, <4 bytes little endian>` followed
by `ret 8`.

### Mouse buttons and media (jump table RVA `0x92854`)

A category-1 code is `01 <button> <count> <interval>`: byte 2 is the fire count
(`0` fires continuously while the button is held) and byte 3 is the interval in
milliseconds. The plain single-click actions carry `01 00` in those two bytes
instead.

Measured on 2026-10-26 with the vendor application under Frida, changing one
field at a time in its 火力键 dialog: with 开火次数 `7` and 开火间隔 `50` the
forward slot read `01 01 07 32`; setting 开火间隔 to `80` then gave
`01 01 07 50`. The 400-byte settings block never moved, so both parameters live
in the button table itself.

That also explains the multi-click presets: 左键双击 and 三连发 are the same
mechanism with the count pinned at 2 and 3.

| wire | meaning | source |
| --- | --- | --- |
| `01 01 01 00` | left click | live |
| `01 02 01 00` | middle click (vendor numbers middle as 2) | live |
| `01 03 01 00` | right click (vendor numbers right as 3) | live |
| `01 04 01 00` | forward | live |
| `01 05 01 00` | back | live |
| `01 08 00 00` | wheel up | live |
| `01 09 00 00` | wheel down | live |
| `01 01 02 32` | left, 2 clicks / 50 ms ("左键双击") | live |
| `01 01 03 32` | left, 3 clicks / 50 ms ("三连发") | live |
| `01 01 00 32` | fire on left, continuous, 50 ms ("火力键") | live |
| `01 01 07 32` | fire on left, 7 clicks / 50 ms | live |
| `01 01 07 50` | fire on left, 7 clicks / 80 ms | live |
| `01 02 00 32` | fire on right, continuous, 50 ms | live |
| `01 07 ff 32` | tilt left | table |
| `01 06 ff 32` | tilt right | table |

Note the two different button numberings in the same category-1 space. The
"mouse button" actions use the vendor's own order — left 1, middle 2, right 3 —
while the fire-button sub-option uses the ordinary HID order, left 1, right 2,
middle 3. Verified with `right click` (`01 03 01 00`) versus `fire button +
right` (`01 02 00 32`).

### Multimedia (jump table RVA `0x92a14`)

Category `02` carries a standard HID Consumer usage in bytes 2-3, big endian.
Two entries are confirmed against a live capture (`Vol +`, `Email`).

| usage | wire | action |
| --- | --- | --- |
| `0x00CD` | `02 00 00 CD` | play / pause |
| `0x00B7` | `02 00 00 B7` | stop |
| `0x00B6` | `02 00 00 B6` | previous track |
| `0x00B5` | `02 00 00 B5` | next track |
| `0x00E9` | `02 00 00 E9` | volume up (confirmed) |
| `0x00EA` | `02 00 00 EA` | volume down |
| `0x00E2` | `02 00 00 E2` | mute |
| `0x006F` | `02 00 00 6F` | brightness up |
| `0x0070` | `02 00 00 70` | brightness down |
| `0x018A` | `02 00 01 8A` | email (confirmed) |
| `0x0192` | `02 00 01 92` | calculator |
| `0x0194` | `02 00 01 94` | my computer |
| `0x0221` | `02 00 02 21` | browser search |
| `0x0223` | `02 00 02 23` | browser home |
| `0x0224` | `02 00 02 24` | browser back |
| `0x0225` | `02 00 02 25` | browser forward |
| `0x0226` | `02 00 02 26` | browser stop |
| `0x0227` | `02 00 02 27` | browser refresh |
| `0x022A` | `02 00 02 2A` | bookmarks |
| `0x0183` | `02 00 01 83` | media player |

### Mouse functions (jump table RVA `0x929CC`, category 8, code `0xA2`-`0xAE`)

| wire | meaning | source |
| --- | --- | --- |
| `05 04 00 00` | DPI cycle — the factory binding of the 6th slot | live |
| `05 05 00 09` | DPI lock | live |
| `05 01 00 00` | (mouse function, seen while browsing the UI) | live |
| `05 02 00 00` | (mouse function, seen while browsing the UI) | live |
| `0E 00 00 00` | (from the jump table) | table |

`MS.ini` uses `08,AA` for slot 6 (which is `05 04 00 00`, i.e. DPI cycle) and
`08,A2` for slots 7-10.

The GM3 firmware does not expose every label `Text\sc\text.xml` defines: the
application has no "模式切换", "灯效切换", "回报率切换", "DPI级数", "右键双击"
or "常用命令" entries for this model.

### Keyboard (category 5)

Category 5 is built arithmetically rather than from a table (RVA `0x925B2`):
the wire value is `03 <modifier> <key> 00`, where the modifier byte is `01`,
`02` or `04` for the three modifier groups and `<key>` is the HID keyboard
usage. A plain key with no modifier takes the `01` path with `cl = 1`.

## Macros

Macros travel over command pair `03 00`, a different subsystem from the button
table. Captured 2026-10-27 by recording a macro in the vendor application with
it under Frida:

```text
04 00 | u16 size | u8 nameBytes | UTF-16LE name | 4-byte step records…
```

`size` counts every byte that follows it. One step record is

```text
u8 flags | u16 time_ms (big endian) | u8 hid_usage
```

where bit 7 of `flags` marks a release and bit 5 marks a mouse-button step (the
code byte is then a HID button number, not a keyboard usage). `time_ms` is how
long the device waits *after* that step, so on a press it is the hold time — a
long value keeps the key down and the host's key-repeat then fires for the whole
hold. Recording `C`, a pause, then `D` gave

```text
04 00 17 00 06 "OM2" | 00 00EA 06 | 80 01D5 06 | 00 007D 07 | 80 0000 07
```

that is: press C and hold it 234 ms, wait 469 ms then press D and hold it
125 ms, then release D.

A second capture recorded a left click, a pause, then `C`:

```text
04 00 17 00 06 "OMM" | 20 008C 01 | A0 02B0 01 | 00 007D 06 | 80 0000 06
```

so a left click is a step with `0x20` set and code `1`, held 140 ms, followed
by its release at `0x80 | 0x20`; `C` then follows with the plain keyboard
flags. Mouse codes follow the HID button order below the measured left button:
left 1, right 2, middle 3, back 4, forward 5. Only left has been measured.

Binding a macro to a button reuses the `01 00` table with category `03`:

```text
03 <mode> <count> <macro index>
```

Measured on hardware on 2026-10-27, on the forward slot:

| vendor setting | wire |
| --- | --- |
| 执行次数 1 | `03 01 01 00` |
| 执行次数 7 | `03 01 07 00` |
| 循环直到任意按键按下 | `03 02 01 00` |
| 循环直到按键松开 | `03 04 01 00` |

Mode `01` repeats the macro `<count>` times; modes `02` and `04` are the two
loop behaviours, where the count byte stays `1` and is ignored. Pressing the
bound button replayed `C` then `D` on the host.

The last byte indexes the uploaded macros, and read `00` in every sample: the
first macro created in the panel (`OMTEST`) had no steps and was never
uploaded, so `OM2` became index 0. Not yet confirmed with two macros that both
carry steps.

The vendor application also caches the macro in
`%LOCALAPPDATA%\BYCOMBO4\mac.dct` — written on exit, with 12-byte steps
(`u16 virtual-key code`, `u16 flag`, `u32 time`, `u32 reserved`) — and the
binding in its `profile.dct`.

### A save that looks idempotent may simply not have applied

The vendor's macro dialog offers 循环直到按键松开, 循环直到任意按键按下 and
执行次数 N. An early pass set 执行次数 to 2 and 5 but never committed the
dialog, and each save then re-sent a byte-identical `01 00` table, a
byte-identical `03 00` payload and a settings block with zero differing bytes —
which reads exactly like "the setting is not supported". It was: the count only
appears in the table once the dialog is confirmed before saving. Treat a
repeatable-looking capture as unapplied until the value shows up in a frame.

## Still to pin down

- Mouse-button macro steps: only the left button (`0x20`, code `1`) has been
  captured; right/middle/back/forward use their HID numbers by analogy.
- Fire button on middle and forward: expected `01 03 00 32` and `01 04 00 32`
  from the numbering rule above, not yet captured.
- Keyboard keys and combos: category 5 is built arithmetically, but no live
  sample has been taken, so the modifier mapping is inferred from the code, not
  measured.
- Multi-keyboard/macro actions: not present in this model's UI.

The driver exposes the actions in `src/leobog/buttons.ts`; the keyboard group
is deliberately left out until it has a live sample.

The vendor builds its action menus procedurally, so the label text
(`tc_ms%d`, `tc_cmd%d`, `tc_kb%d`) is not stored next to the codes; every row
marked "live" above came from selecting that exact label in the vendor UI while
`.tmp/re/capture_buttons.py` was watching the `01 00` frames.

## Reproducing

Scratch tooling lives in `.tmp/re/`: `disasm.py` (PE + Capstone helper),
`switch.py` (jump-table extractor), `trace.js`/`trace_host.py` (Frida capture of
the vendor's HID writes), plus `.tmp/gm3_verify.py` for reading and writing the
device directly.
