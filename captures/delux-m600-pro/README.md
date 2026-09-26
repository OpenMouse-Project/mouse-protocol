# Delux M600 Pro fixtures

Hardware reference material for the M600 Pro entry in `src/delux/` and
`src/drivers/delux/`. Everything here was captured from one Delux M600 Pro
on Linux (hidraw) on 2026-09-24: wired `0x1d57:0xfa71` (bcdDevice 1.02) and
its 2.4 GHz receiver `0x1d57:0xfa60` (bcdDevice 1.08). Neither exposes a
serial string. No personal data is included.

| File | What it is |
|---|---|
| `descriptors.hex` | HID report descriptors of all four interfaces, wired and receiver. Interface 2 carries the config channel (collection `0x0B/0x00`, feature reports `0x04`–`0x2E`, `0xA0`). |
| `get-feature.txt` | `GET_FEATURE` for every declared feature report: all time out except `0xA0`, which answers zeros. Also the receiver's battery input stream (`03 20 40 01 64`), and the R1-style `0xA0` read request that returned no polling code and then stalled. |
| `receiver-timing.txt` | The receiver's answer to each write (`03 20 50 00 06` and undocumented variants), the documented `0xA0` read unlock (polling read back once; `0x04` stalled), and write pairs at 3, 2 and 1 s gaps, none of which froze. |
| `openmouse-hardware-test-wireless.json`, `openmouse-hardware-test-wired.json` | The OpenMouse hardware test report (Chrome, Linux, local build of this change) for each path. Both pass. |
| `writes.json` | Every `SET_FEATURE` sent (`0x06` polling, `0x04` DPI from `buildX11DpiReport`), with the effect measured on the boot-mouse interface. It also covers the wireless write that froze the link. |

The tests in `src/drivers/delux/hid.test.ts` carry the verified polling
and DPI packets inline. See `docs/delux-m600-pro-testing.md` for the
write-up.
