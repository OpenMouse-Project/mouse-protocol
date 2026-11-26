# Incott G23 Pro fixtures

Hardware reference material for the original G23 Pro (not the G23V2), the
first unit other than a G23V2 to run against `src/incott/`. Both files are the
OpenMouse hardware test report, exported unmodified from
control.openmouse.app (BETA v2.0.59d, Chrome 156, Windows 11) on 2026-10-29.
The mouse is white; no serial string is exposed and no personal data is
included. Every report the driver sent in both sessions is a query
(`0x81`-`0x8F`); nothing was written to the mouse.

| File | What it is |
|---|---|
| `openmouse-hardware-test-wired.json` | Cable only, wireless switch off, no dongle plugged in: `093A:622C`, product string `incott Esports G23 Pro mouse`. Identity `09 8f 01 02 00 f1 00 00 00` (byte 8 from the report's `firmware` field, the log line stops at byte 7). |
| `openmouse-hardware-test-wireless.json` | 8K dongle only, cable unplugged, dongle freshly inserted: `093A:522C`, product string `incott 8K wireless mouse`, 8000 Hz. Identity `09 8f 01 02 02 f0 f1 00 02`. |

The tests in `src/incott/index.test.ts` carry both identity frames inline.
See "A second model on hardware: the original G23 Pro" in
`docs/incott-testing.md` for the write-up.
