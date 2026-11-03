# Corsair SCIMITAR RGB ELITE fixtures

Reference material for `src/corsair/bragi.ts` and `src/drivers/corsair/bragi-hid.ts`.
From a wired SCIMITAR RGB ELITE (USB `0x1b1c:0x1be3`, firmware 1.2.21 as iCUE
reports it), captured 2026-10-15: iCUE on Windows 11 in a virtual machine with the
mouse passed through to the guest, USB traffic recorded with usbmon on the Linux
host. The iCUE build is the one Corsair served on that date; its version was not
recorded. No serial numbers or personal data are included; the other devices on the
bus, the pointer and keyboard interfaces, and the lighting stream were left out.

| File | Trust | What it is |
|-|-|-|
| `properties.hex` | Vendor capture | 219 request/reply pairs on the vendor interface (interface 1, EP `0x04` OUT / `0x84` IN): the connect-time GETs iCUE sends (`01 02 03 07 11 12 13 14 4f 50 51`), DPI and polling-rate, brightness and angle-snapping SETs, with their replies. `src/corsair/bragi-scimitar.test.ts` re-encodes every request byte for byte. |
| `usb-descriptors.txt` | Vendor capture | The four HID interfaces, their endpoints, and the report descriptors in hex. Interface 1 is vendor page `0xFF42`, usage `0x01`, 128-byte input and output reports with no report id. Interface 2 is `0xFF42`, usage `0x02`, input only. |

## What differs from the IRONCLAW

- Reports are **128 bytes**, not 64 (the descriptor says so). The codec takes a per-mouse
  `packetSize`; the IRONCLAW entry keeps 64.
- Replies are the same shape: `[slot] [command] [status] [value, LE]`, here slot 0 on
  the cable. Status `05` means unsupported (e.g. battery on this wired mouse).
- Extra properties that answered a GET: `02` brightness, `07` angle snapping, `4f`
  active DPI stage.

## Checked on the real mouse

With iCUE closed, the mouse in hardware mode (`GET 03` = 1) and direct HID access on
Linux, one unit:

- Every GET in `properties.hex` answers with status `00`; `GET 21`/`22` return the live
  DPI, which iCUE itself never reads.
- A live DPI SET (`21`/`22`) is acked and reads back, **and is lost on an unplug and
  replug**. The mouse falls back to the stored value of the active stage.
- DPI range, probed with SET on X: 100 and 18,000 are acked ok; 50, 99, 18,001, 20,000,
  26,000 and 65,535 are acked with status `01` (invalid value) and change nothing.
- Polling rate SET `1`/`2`/`3`/`4` = 125/250/500/1000 Hz. The mouse **re-enumerates on
  USB** right after the ack, so a read-back needs the new device. The value is stored:
  it survived that reset and an unplug.
- Brightness (`0`–`1000`, tenths of a percent; iCUE's steps are 0/33/66/100 %) and angle
  snapping (`0`/`1`) are stored across an unplug too.
- `GET 4f` follows the mouse's own DPI button (stage 1 → 2 read 0 → 1 with DPI 800 → 1500)
  and kept its value through a replug and through the polling-rate reset.

## What the driver does with it

It adds the mouse to the Bragi table and reads name, firmware, mode, DPI X/Y, polling
rate, angle snapping, brightness and the active stage. It stays **read-only**: the
SET encoders for DPI, polling rate, brightness and angle snapping are tested against
the capture but the driver never sends them, and it never changes the mode.

## Not captured, or not understood

- **Property `03`** (mode) is read as `1` = hardware, `2` = software like the IRONCLAW
  table says. iCUE writes `2`, `1`, `2` at connect; why is unknown.
- **`14`** replies `00 01 04` and **`50`/`51`** reply `0`; their meaning is unknown and the
  codec does not name them.
- **Device Memory Mode / onboard profiles.** iCUE's profile slots are a separate
  mechanism and are not in these fixtures. `08 01 6e` is what iCUE sends when a slot is
  selected, but the mouse acks it with status `05` and `GET 6e` is also `05`, so it is not
  shown to switch slots.
- **Lighting.** Frames are `08 06 00 0f` followed by five red values, five green and five
  blue; they are not in the fixtures and the codec does not implement them.
- **Other variants.** Only the wired `0x1be3` was exercised. The wireless SCIMITAR models
  and receivers are not covered.
- Whether the same properties behave identically at other firmware versions.
