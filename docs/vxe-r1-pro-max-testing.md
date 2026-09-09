# VXE R1 Pro Max hardware notes

This document records the R1 Pro Max values and transport behavior verified on
real hardware for the ATK driver. The wired mouse and 1K receiver share the R1
command family, but receiver writes remain restricted to individually captured
and verified paths.

## Identity and transports

- Mouse identity (`GetMouseCIDMID`, command `0x10`): CID `0x02`, MID `0x1b`.
- Sensor: PAW3395.
- Wired configuration endpoint: VID/PID `0x3554:0xf58c`.
- 1K receiver configuration endpoint: VID/PID `0x3554:0xf58a`.
- Configuration collection: usage page `0xff02`, usage `0x02`.

The R1 Pro Max must not use the R1 SE/SE+ selector-based live-settings row at
`0x0070`. Captured Pro Max polling changes use the normal system EEPROM block
at `0x0000`.

## Verified wired behavior

The wired `0xf58c` transport uses the checksum-protected R1 EEPROM command
framing already implemented by `AtkHidClient`. Persistent writes are enabled
only after CID/MID resolves to `2,27` on this exact transport.

Verified behavior includes:

- Polling rates: 125, 250, 500, and 1,000 Hz through the system EEPROM block.
- PAW3395 DPI range used by the driver: up to 30,000 DPI.
- DPI records preserve separate X and Y axis values.
- DPI stage count and active-stage selection with readback and persistence.
- Lift-off distance, debounce, Motion Sync, sleep timeout, ripple control, and
  angle snapping.
- Performance Mode, DPI stage colours, and DPI lighting including Off,
  Always On/Steady, Breathing, brightness, and speed.
- Ultra Long Range through commands `0x16`/`0x17`.
- Profile switching through commands `0x0f`/`0x0e`.
- Stored button assignments are inspected read-only; button-remap writes are
  not implemented by this PR.

## Verified receiver behavior

The `0xf58a` receiver was captured and hardware-tested independently. The
receiver uses the same logical settings, but writes are sent through dedicated
receiver helpers rather than by relaxing the generic EEPROM-write guard.

Verified receiver writes include:

- Polling through a complete 10-byte system row at `0x0000`.
- DPI writes through the containing two-stage 8-byte DPI group.
- DPI stage count and active-stage selection through the complete 10-byte
  system row, preserving unrelated bytes.
- Lift-off distance at `0x000a`.
- Debounce, Motion Sync, sleep timeout, angle snapping, and ripple control by
  read-modify-writing the complete 10-byte advanced row at `0x00a9`.
- Performance Mode through the captured 6-byte row at `0x00b5`.
- DPI stage colours through the containing 8-byte colour group at `0x002c`
  and subsequent groups as required by stage index.
- DPI lighting mode, brightness, and speed through the captured 8-byte row at
  `0x004c`.
- Ultra Long Range through command `0x16` with `0x17` readback.
- Profile switching through command `0x0f` with `0x0e` readback.

Where the receiver echoes a write, the driver requires the captured echo before
continuing. EEPROM-backed settings are read back after the write where the
protocol provides a stable readback path. DPI stage management and profile
selection were also verified to persist across reconnects.

## Receiver safety boundary

The generic R1 EEPROM `write()` path remains blocked for `0xf58a`. Receiver
support is intentionally allow-listed per verified operation so a future R1
setting cannot accidentally become writable merely because it shares an EEPROM
address family with the wired device.

In particular, do not route this receiver through the SE/SE+ `0x0070`
live-settings selectors merely because both devices belong to the R1 family.
That would send the wrong protocol for polling, lift-off distance, debounce,
and angle snapping.

Unknown identities are rejected before R1 fallback encoding is used.

## Validation

Final local validation for this hardware pass:

- Targeted ATK tests: 52/52 passing.
- `npm run build`: passing.
- `git diff --check`: passing.
