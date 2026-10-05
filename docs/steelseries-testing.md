# SteelSeries hardware test checklist

Test in Chrome or Edge over HTTPS. **Fully quit SteelSeries GG and the
SteelSeriesEngine background service first** — they hold the configuration
interface open and the firmware probe will time out.

Supported identifiers (none hardware-verified yet):

- `1038:1824` — Rival 3, pre-0.37 firmware enumeration
- `1038:184c` — Rival 3, post-v0.37.0.0 firmware enumeration

The protocol is transcribed from the public rivalcfg project and corroborated
against libratbag's SteelSeries driver and OpenRGB's Rival 3 controller. The
config channel is hidapi interface 3; its WebHID collection shape has not been
captured, so the picker offers every interface and the driver's firmware probe
(`10 00`) is what proves the right one was chosen. A wrong interface fails
loudly — add the device again and choose another entry.

**This device is write-only.** Nothing except the firmware version can be read
back, so every verification below is physical (pointer speed, an external rate
meter), never a read. The driver reports last-written values flagged as
unverified; that is by design.

The Rival 3 Wireless (`1038:1830`, `1038:1872`) and Rival 3 Gen 2
(`1038:1870`) use different, incompatible command sets and are deliberately
not claimed by this driver.

1. Record the OS, browser, exact VID:PID, and which picker entry connected.
   The first time a unit connects, paste the `device.collections` dump into
   the issue or pull request — it is the missing evidence that lets the broad
   per-PID filter be narrowed to a usage-page filter.
2. Confirm the firmware version the driver reads matches what SteelSeries GG
   displays (briefly reopen GG to compare, then quit it again). On a
   `1038:184c` unit the version is known to be in the 0.37 family, which also
   settles the two-byte order that public implementations disagree on.
3. Because nothing is readable, **record the starting configuration from GG
   before changing anything**: every DPI preset, the active preset, the
   polling rate, and lighting. This replaces the usual "verify every readable
   value" step and is what step 8 restores.
4. Change exactly one setting at a time.
5. Write a DPI value and confirm the pointer speed physically changes. Note
   that the write replaces the on-device preset table with that single preset
   — the DPI button will no longer cycle the old presets. That is expected.
6. Write each polling rate (125 / 250 / 500 / 1000 Hz) and verify with an
   external rate meter (for example a `pointerrawupdate` tester), not by any
   read.
7. Reload OpenMouse, reconnect, and confirm the firmware still reads. Then
   power-cycle/replug the mouse and confirm the written DPI and polling rate
   persisted physically — that is the save command (`09 00`) doing its job.
8. Restore the original presets and settings through SteelSeries GG, and
   confirm GG still controls the mouse normally after OpenMouse ran.
9. Record failures, timeouts, and any unknown behavior verbatim in the issue
   or pull request. Do not attach captures containing serial numbers.
10. Only after all of the above on a given product id: set that entry's
    `verified` flag to `true` in `src/steelseries/devices.ts`, add the id to
    the verified list at the top of this file, and record the firmware
    version in the pull request. The other product id stays unverified until
    it is exercised too.

Do not test firmware flashing, factory reset, lighting, or button remapping.
The driver implements none of them, and the lighting/button commands are
documented in `src/steelseries/rival3.ts` as known-but-withheld until there is
hardware evidence and a reason to ship them.

## Aerox 3 Wireless

Supported identifiers:

- `1038:183a`: Aerox 3 Wireless over the USB cable, hardware-verified
- `1038:1838`: Aerox 3 Wireless over the 2.4 GHz dongle, hardware-verified
- `1038:187a`: CS2 Dragon Lore Edition over the USB cable, unverified
- `1038:1878`: CS2 Dragon Lore Edition over the 2.4 GHz dongle, unverified

The codec is transcribed from rivalcfg's `aerox3_wireless_wired.py` and
`aerox3_wireless_wireless.py`. Over the dongle every command byte has `0x40`
ORed in. Bluetooth mode is not configurable through this protocol.

### Observed on hardware

On macOS, with the bytes produced by `src/steelseries/aerox3-wireless.ts`:

- The config channel is the usage page `0xFFC0` usage `0x01` collection, which
  is interface 3 over the cable. The dongle exposes the same collection.
- Every write is acked by a 64-byte input report that echoes the command byte
  followed by `00`, for example `2b 00` then `11 00`. Over the dongle the third
  byte is `01`, for example `69 00 01`.
- The battery query answers `92 95` over the cable (charging, 100%) and
  `d2 15` over the dongle (discharging, 100%).
- Polling rate: 125 Hz and 1000 Hz both measured on the mouse input collection,
  over the cable and over the dongle, with median report gaps of 8.00 ms and
  1.00 ms.
- DPI presets: a 400/1600 table cycled exactly those two stages with the DPI
  button and survived a replug. The 5-stage default table written over the
  dongle cycled 5 stages.
- Zone colors land on the top, middle and bottom LEDs in that order, but are
  not kept across a power cycle. The mouse boots into its default lighting.
- Default lighting `rainbow` (`27 01 00`) makes the mouse boot into a rainbow
  cycle.
- rivalcfg's runtime rainbow `22 FF` is acked but leaves the strip dark, and
  `22 07` does too. The driver does not offer a runtime rainbow.
- Reactive color flashes the strip on click. While it is on, the strip stays
  dark between clicks.
- Dim timer: 0 keeps the LEDs on, 5 seconds dims them after 5 idle seconds.
- Sleep timer: with 1 minute set over the dongle, the mouse stopped answering
  between 60 and 70 idle seconds. While it sleeps the dongle answers every
  query with an unsolicited `40 ff 01` report. The same report also arrives
  once right after a polling rate change over the dongle.
- Button mapping: the DPI button remapped to the `A` key typed `a`, and every
  other button kept its default action.

### Checklist for the remaining product ids

1. Confirm the battery level and charging state match SteelSeries GG.
2. Edit each DPI stage, change the active stage, and change the stage count.
   Confirm with the DPI button that the mouse cycles exactly the written table.
3. Write each polling rate and verify it with an external rate meter.
4. Set each strip zone color, Off, a reactive click color, and the default
   lighting, then power-cycle to check the default lighting.
5. Set the sleep and dim timers and confirm the mouse sleeps and dims.
6. Remap the DPI button to a key and back, and confirm scroll still works.
7. Power-cycle the mouse and confirm DPI, polling, timers and buttons persisted.
8. Only then set `verified: true` on the exercised product id in
   `src/steelseries/devices.ts`.
