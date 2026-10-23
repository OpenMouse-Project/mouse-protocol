# Cosmic Byte Kilonova 3335IC (`258a:002f`) captures

A read-only probing session against the Kilonova 3335IC's 2.4 GHz dongle
(SINOWEALTH `258a:002f`, the M690 PRO receiver's product id) with node-hid
under Windows 11. Short commands went to interface 1's feature report 5,
banks to feature report 8 (`Col03` of the vendor collections,
`0xff00:0x01`). No vendor application was involved: nothing here shows a
write, and OpenMouse does not write to this device. The mouse was awake and
linked during the session and its battery read 0x46 (70 %). The dongle
reports no serial number, so the files carry no unit identifier.

| File | What it is |
| --- | --- |
| `probes-receiver.hex` | The whole session: identify (ASCII `"2315"`), link (linked), status (wireless, battery 70 %), the 154-byte settings bank and the 88-byte button bank (payload all zeros). |

Each line is one feature report exactly as node-hid returned it, report id
first: `GET`, then the bytes. Unlike the USBPcap capture folders, nothing is
truncated; the banks end where their content ends (the settings bank ends in
the family's `a5 00` marker), and repeated polls are omitted.

Decoding notes and open questions: `docs/kilonova-3335ic.md`. The driver's
read-only treatment of this device is `src/drivers/redragon/m690-pro-hid.ts`.
