# ATK / VXE hardware test checklist

Test in Chrome or Edge over HTTPS. Select the vendor configuration collection
(`usagePage 0xff02`, `usage 0x02`) when the browser lists multiple HID
interfaces; the plain pointer and keyboard collections cannot answer commands.

Supported identifiers:

- VID `373b` — ATK, shared with its VXE sibling brand
- The discovery filter matches vendor + `usagePage 0xff02`, not product ids: a
  2.4 GHz receiver's product id is reused across models. `0x373b:0x1085`
  ("Wireless mouse -1k dongle") is one such shared receiver.

## Identifying the mouse, not the receiver

Because the receiver's product id says nothing about the mouse behind it, the
driver reads a CID/MID identity pair from the mouse (`GetMouseCIDMID`,
command `0x10`) and looks it up in `src/drivers/atk/products.ts`. This matters
beyond the displayed name: the pair selects the sensor, and the sensor selects
the DPI encoding.

| sensor | DPI encoding | ceiling |
| --- | --- | --- |
| PAW3950Ultra | 10-DPI steps, 50-DPI steps above 10,050, doubled above 30,000 | 42,000 |
| PAW3950 / PAW3950DM | flat 50-DPI steps, doubled above 30,000 | 36,000 |
| PAW3395 / PAW3395Ultra | flat 50-DPI steps, doubled above 30,000 | 30,000 |
| CORE26K | flat 50-DPI steps | 26,000 |

Reading a PAW3395 stage with the PAW3950Ultra encoding yields a fifth of the
real value (a 1,600 DPI stage reads as 320). An unidentified mouse keeps the
PAW3950Ultra behaviour, matching the vendor HUB's own fallback.

The R1 alone ships with at least six different sensors across revisions
(PAW3311, PAW3395, PAW3395SE, PAW3395Ultra, PAW3950Ultra, CORE26K). The model
name on the box is therefore **not** enough to pick an encoding — only the
CID/MID pair is. Sensors whose DPI mapping is a lookup table rather than a
formula (PAW3395SE, PAW3315, PAW3311, PAW3320) are deliberately not implemented
here; their tables have not been captured, and a guessed step would silently
misreport DPI.

## Verified hardware

- **VXE R1** — CID/MID `2,12`, sensor PAW3395, firmware `Mouse 3.13`. Read-only
  verification on Linux (`/dev/hidraw*`, 2026-09-04):
  - DPI stages at EEPROM `0x000c`..`0x001b` read `0f 0f 00 37` / `17 17 00 27` /
    `1f 1f 00 17` / `3f 3f 00 d7` → 800 / 1200 / 1600 / 3200 DPI.
  - Polling code `0x01` → 1,000 Hz. The R1 ships with a 1K receiver, but an 8K
    receiver is sold separately and works with the same mouse, so the polling
    ceiling is a property of the receiver in use, not of the model. The driver
    therefore offers the full 125–8,000 Hz ladder rather than capping by product
    id, and reports whatever rate the mouse actually returns.
  - Firmware, lift-off, debounce, motion sync and sleep read correctly; battery
    percent, charge state and voltage are covered under "Battery" below.
  - Angle register `0x00bd` reads `ff ff ff ff` — unprogrammed. It fails the
    value/checksum pair, so angle tuning and angle snapping report as
    unsupported rather than decoding `0xff` as −1°.
  - Writes were **not** exercised. `verified: true` in the catalog records the
    identity and read path only.

  Both transports were verified on the same unit, reporting the same identity,
  DPI and firmware through each:
  - `0x373b:0x1085` — 2.4 GHz receiver, `connectionType: "Wireless"`.
  - `0x3554:0xf58f` — wired, `connectionType: "Wired"`. This id lives under
    COMPX's vendor id, shared with the VGN Dragonfly F2, so it is claimed by
    product id (`ATK_COMPX_PRODUCT_IDS`) and excluded from the Pulsar fallback's
    `CLAIMED_VGN_PRODUCT_IDS`. The vendor's table reuses `0xf58f` for the R1SE
    and R1SE+ too, which are PAW3395SE — another reason the sensor must come
    from CID/MID rather than the product id.

### Battery

`GetBatteryLevel` (`0x04`) answers `[percent, charging, voltage_hi, voltage_lo]`.
All three fields are decoded and were captured over a charge cycle:

| state | charging byte | voltage | percent |
| --- | --- | --- | --- |
| on battery | `0`, voltage steady | 3,786 mV | 40% |
| on the cable | `1`, voltage climbing 3,893 → 3,938 mV | 3,969 mV | 70% |
| unplugged again | `0` | 3,875 mV | 50% |

A non-zero charging byte means charging. ATK's own HUB tests `=== 2` on some
families, which this treats as charging too; only a non-zero code meaning "not
charging" would be misread, and none has been observed.

**Expect the percentage to drop when you unplug the cable.** The mouse derives
percent from cell voltage, and a charging cell sits above its resting voltage, so
a charging reading is optimistic (70% at 3,969 mV charging against 50% at
3,875 mV resting on the same cell, minutes apart). This is the mouse's own
reporting, not a decode error — do not "fix" it.

A mouse that answers nothing reports `"Unknown"`, which is not the same as
`"Discharging"`: a sleeping 2.4 GHz mouse answers nothing at all.

Note that the receiver's command channel goes idle while the mouse is on the
cable — the mouse serves one link at a time — so the two transports can never be
read at the same instant.

## Checklist

1. Connect the device and confirm the wired/wireless state, battery, firmware
   version, DPI and polling rate are correct. A mouse reached through a
   receiver must show its own model name, not the receiver's USB string.
2. Confirm the reported DPI matches what the vendor's own HUB shows for the same
   stage. A value five times too large or too small means the sensor mapping is
   wrong for that CID/MID, not that the stage is corrupt.
3. Change one setting at a time: DPI, polling rate, lift-off distance, debounce,
   motion sync, ripple control and sleep timeout. Each setter reads its value
   back and raises if the mouse kept the old one.
4. Reload after each write and confirm the value persisted.
5. Confirm a sleeping wireless mouse recovers: a sleeping mouse answers nothing,
   so it must read correctly after being woken rather than staying unidentified.
6. Record the CID/MID pair, firmware version, sensor and any failing setting in
   the issue or pull request. A new CID/MID entry may only be marked
   `verified: true` once that exact pair has been read from hardware.
