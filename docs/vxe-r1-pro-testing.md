# VXE R1 Pro hardware notes

This document records what was verified on a real VXE R1 Pro for the ATK
driver. Only the 1K receiver was tested; the wired transport is untested and
stays read-only.

## Identity and transport

- Receiver: VID/PID `0x3554:0xf58a`, product string "VXE NordicMouse 1K
  Dongle". This is the same USB id as the R1 Pro Max receiver.
- Mouse identity (`GetMouseCIDMID`, command `0x10`): CID `0x02`, MID `0x08`,
  firmware 1.20.
- Sensor: PAW3395 (50-DPI step codec).
- Configuration collection: usage page `0xff02`, usage `0x02`.

ATK HUB lists the wired R1 Pro as CID/MID `2,7` on `0x3554:0xf58c`; the
hardware reports `2,8` through the receiver.

### CID/MID is scoped by USB vendor

Under ATK's `0x373b` vendor id, CID/MID `2,8` is the VXE R1 NK, a PAW3395SE
mouse. The receiver is not in the vendor catalog, so the driver used to fall
back to the only catalog entry with that pair and decode the R1 Pro with the
PAW3395SE codec. That codec has no code `0x07`, so a 400-DPI stage
(`07 07 00 47`) aborted the status read with a checksum error even though the
row's checksum was valid.

Ten of the twelve Compx (`0x3554`) CID/MID pairs in the catalog name a
different mouse under `0x373b`. A CID/MID-only catalog match is therefore
accepted only when the entry belongs to the connected USB vendor, and the R1
Pro is registered as a Compx-only identity.

## Verified receiver behavior

`captures/vxe-r1-pro/receiver-atk-hub.txt` and
`captures/vxe-r1-pro/receiver-atk-hub-profiles.txt` are logs of ATK HUB
(`v3-hub.atk.store`) changing each setting below. The frames match the R1 Pro
Max receiver protocol, so the R1 Pro reuses those write/echo helpers. Each
setting was then written by the driver on the same mouse, confirmed by
readback, and restored.

| Setting | Row | Notes |
| --- | --- | --- |
| Polling rate (125–1,000 Hz) | 10-byte system row at `0x0000` | |
| DPI stage count, active stage | 10-byte system row at `0x0000` | Stage count was written by the driver only; HUB's stage-count change was not captured. |
| DPI stage value | 8-byte two-stage group from `0x000c` | 1,500 DPI is `1d 1d 00 1b`. HUB rewrites all four groups; the driver writes the one that changed. |
| Lift-off distance | pair at `0x000a` | 1 = 1 mm, 2 = 2 mm. |
| Debounce, Motion Sync, sleep, straight-line correction, ripple control | 10-byte advanced row at `0x00a9` | Offsets 0, 2, 4, 6, 8. |
| DPI stage colours | 8-byte two-colour group from `0x002c` | |
| DPI lighting | 8-byte row at `0x004c` | See below. |
| Ultra Long Range | command `0x16`, readback `0x17` | |
| Configuration bank (profile) 1–4 | command `0x0f`, readback `0x0e` | Zero-based bank at data offset 0; the receiver echoes the request about 100 ms later. |

### Profiles and buttons

The mouse holds four configuration banks. Switching to bank 2 through the
driver changed the reported DPI stages from 400/800/3,200/1,200 to
400/800/1,600/3,200, and switching back restored them, so EEPROM reads follow
the active bank as they do on the other R1s.

The six button records at `0x0060`–`0x0074` use the R1 layout and are read
only. The stock assignments read as left, right, middle, back, forward and DPI
cycle.

ATK HUB's "computer config" entries are stored on the PC: applying one selects
bank 4 and rewrites its rows from the host. The driver does not model them.

### DPI lighting

The row is `effect | brightness | speed | enabled`, each a value/checksum pair.
Always On and Breathing match the R1 Pro Max. Off differs:

- ATK HUB sends `00 00 | brightness unchanged | speed | 00 55`.
- The mouse stores `02 53` in the effect pair regardless, so Off is carried by
  the enabled flag alone. A row reading `02 53 80 d5 05 50 00 55` is Off.

The driver sends HUB's Off row, does not require the effect pair to read back,
and decodes enabled = 0 as Off for this identity.

### Sleep timer

When the sleep timer changes, ATK HUB also writes the 6-byte row at `0x00b5`
(`01 54 | timer | 01 54`). The driver writes only `0x00a9`, as it does for the
R1 Pro Max; the readback confirms the value, but that the mouse then sleeps on
the new schedule was not timed.

## Not enabled

- Button-assignment writes and macros: not captured, and not implemented by
  the driver for any R1.
- Performance Mode (`0x00b5` bytes 4–5): ATK HUB showed no such switch for
  this mouse, so the driver neither reports nor writes it.
- Separate X/Y DPI: not tested.
- Wired transport: not tested. It is not on the verified-wired list, so
  persistent writes stay blocked there.
