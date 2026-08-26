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
