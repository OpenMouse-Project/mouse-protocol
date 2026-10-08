# Corsair IRONCLAW RGB WIRELESS fixtures

Reference material for `src/corsair/bragi.ts` and
`src/drivers/corsair/bragi-hid.ts`. From a community USBPcap capture
(ticket-0159, Windows, 2026-10-02): the mouse paired to a SLIPSTREAM WIRELESS
USB Receiver (VID `0x1b1c`, PID `0x1bdc`) while the owner dragged iCUE's DPI
slider. No serial numbers or personal data are included; the pointer traffic
and the other USB devices in the capture were left out.

| File | Trust | What it is |
|-|-|-|
| `dpi-slider.hex` | Vendor capture | Every frame on the receiver's interface 1: 101 pairs of `SET 0x21` (DPI X) and `SET 0x22` (DPI Y) addressed to slot 1 (`09 01 …`), 1391 to 11,288 DPI, each answered `01 01 00` (slot 1, SET, ok). `src/corsair/bragi.test.ts` re-encodes all 202 requests byte for byte. |
| `usb-descriptors.txt` | Vendor capture | The receiver's device and configuration descriptors: six HID interfaces, Bragi on interface 1 (EP `0x04` OUT, `0x84` IN), notifications on interface 2. |

Why this is the IRONCLAW and not the M75 Wireless (OpenRGB names `0x1bdc`
after the M75 receiver; OpenLinkHub lists it as a generic SLIPSTREAM
receiver): the slider values only fit iCUE's 100 to 18,000 scale in 208 steps
of 86.06 DPI, and the M75 Wireless goes to 26,000.

## Not captured yet

- **Any GET reply.** iCUE had already set the mouse up before the capture
  started, so there is no handshake and no status read. The driver's GET
  layout (value little-endian from byte 3) and every property id other than
  `0x21`/`0x22` come from ckb-next, OpenRGB and OpenLinkHub, not from this mouse.
- **Hardware mode.** iCUE was running, so the mouse was presumably in software
  mode. Whether `0x21`/`0x22` read back and stick with iCUE closed is unknown,
  which is why the driver is read-only.
- **The HID report descriptors**, which name each 0xFF42 collection's usage.
  Capturing a replug of the receiver would include them.
- **Wired mode** (PID `0x1b4c`, slot 0) and the IRONCLAW's own receiver
  (`0x1b66`, from ckb-next): no traffic seen.
- **Other settings**: DPI stages, polling rate, lift-off, angle snapping,
  sleep, lighting.
