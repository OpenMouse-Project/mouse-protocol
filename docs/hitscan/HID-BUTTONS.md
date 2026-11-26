# Button actions and shortcut event interpretation

Evidence: REA/Ghidra pseudocode `native/0x1400324f0.c` (main app's action-to-label formatter), matching LLVM instructions, Qt QAction connections in main constructor `0x140024BF0`, and shipped `usersetting/Config.ini`. These are static findings, not hardware observations.

## Three-byte actions

The normalized action is `[category, subcode, parameter]`. Main function `0x140038CC0` reads normalized button0 offsets `0x4A..0x4C` at `0x14003917E..0x14003919C`, populates three integer lists, and passes them as parameters 3, 4, 5 respectively to formatter `0x1400324F0` (call `0x1400393FF`). DLL record checksums and flash offsets are in HID-CONFIG.md.

| Category | Subcode | Formatter meaning | QAction member |
|---|---:|---|---:|
| 0 | ignored by formatter | Disabled | 0x160 |
| 1 | 1 | Left click | 0x128 |
| 1 | 2 | Right click | 0x130 |
| 1 | 4 | Middle/wheel click | 0x138 |
| 1 | 8 | Back | 0x148 |
| 1 | 16 | Forward | 0x140 |
| 2 | 1 | DPI loop | 0x1E0 |
| 2 | 2 | DPI up | 0x1D0 |
| 2 | 3 | DPI down | 0x1D8 |
| 5 | opaque | Shortcut/key combination | data depends on physical button |
| 6 | opaque | Macro | data depends on physical button |
| 7 | ignored by formatter | Polling rate switch | 0x150 |
| 10 | DPI encoding value | DPI-valued action, likely CPI lock | formatter converts second parameter through selected sensor table |

The action-member meanings are established from actual Qt signal connection strings: e.g. `0x140027AF0` connects `slotLeftKey()` to member0x128, `27B2C` right/130, `27B68` wheel/138, `27BA4` forward/140, `27BE0` back/148. DPI connects at `27F0A` up/1D0, `27F46` down/1D8, `27F82` loop/1E0.

`src/hitscan/buttons.ts` encodes canonical triples with unused bytes zero for known simple actions. Decoding preserves all unexplained triples and nonzero extra bytes, since the formatter ignoring a byte does not prove firmware ignores it. Categories 5/6 preserve the two raw parameters rather than inventing a slot identifier or repeat-mode enum.

**Shortcut and macro storage association is by physical button in the formatter.** Button0 reads shortcut structure at normalized0x7C and macro name0x3BD; button1 reads shortcut0xB0, etc. A mapping byte must not be assumed to select an arbitrary storage slot. For macros the third mapping byte is formatted as a number, but its exact repeat semantics need setter/caller confirmation.

The shipped KeyParam1..6 literals are `[1,1,0]`, `[1,2,0]`, `[1,0,0x83]`, `[1,8,0]`, `[1,0,0]`, `[1,1,0]`. In particular do not silently reinterpret KeyParam3 as a conventional middle click or KeyParam5 as disabled. Those unusual values remain raw.

## Multimedia shortcut recognition

When category5 applies and the first shortcut event's normalized byte1 equals2, formatter324F0 recognizes the event's normalized byte2 (the low usage byte) using this table. The normalized event byte3 is not tested by this formatter; retain it instead of inventing its value.

| Low usage byte | UI action |
|---:|---|
| 83 | Media player |
| CD | Play/pause |
| B5 | Next track |
| B6 | Previous track |
| B7 | Stop playback |
| E2 | Mute |
| E9 | Volume up |
| EA | Volume down |
| 8A | Email |
| 92 | Calculator |
| 94 | My computer/file explorer |
| 23 | Home page |
| 21 | Search |
| 26 | Stop web |
| 27 | Refresh |
| 2A | Favorites |

The table is paired to named slots in constructor24BF0 (members1E8..260). These are raw hexadecimal low bytes; a full 16-bit consumer usage requires retaining byte3. Do not construct e.g. Media Player as usage0x0083 solely from this table.

## Event kinds

The DLL packs normalized event direction0 into0x80, direction1 into0x40, and other into0x00 in the first packed event byte (see HID-CONFIG.md). Main helper `0x140035F30` builds a two-event pair with normalized direction0 then1, category2 in each event byte1, identical usage bytes, and delay10 in each event dword. This corroborates paired down/up interpretation but the helper alone does not provide named press/release callbacks. No unverified event kind labels were added to the public codec.

Remaining work: exact macro repeat modes, lighting actions, profile switch and fire-key parameterization, full keyboard modifier/usage mapping, and hardware validation. The existing raw codecs preserve these bytes for future expansion.
