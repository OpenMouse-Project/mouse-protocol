# VXE R1 Pro Max hardware notes

This document records the R1 Pro Max values used by the ATK driver. Keep the
receiver and wired transports separate: they share the R1 EEPROM command
family, but the receiver write path has not been validated.

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

The wired `0xf58c` transport uses the same checksum-protected R1 EEPROM command
framing already implemented by `AtkHidClient`. The driver enables persistent
writes only after CID/MID resolves to `2,27` on this exact transport.

Captured behavior used by the implementation:

- Polling rates: 125, 250, 500, and 1,000 Hz through the system EEPROM block.
- PAW3395 DPI range used by the driver: up to 30,000 DPI.
- DPI records preserve separate X and Y axis values.
- R1 extended EEPROM areas are used for DPI stage colours, DPI lighting,
  performance mode, and stored button/profile inspection.
- Ultra Long Range uses the existing R1 command path rather than a guessed
  receiver-only command.

Every persistent write path performs device readback where the existing R1
protocol supports it. Unknown identities are rejected before R1 fallback
encoding is used.

## Receiver safety boundary

The `0xf58a` receiver is recognized so status reads and device selection can use
the correct R1 Pro Max identity. Persistent EEPROM writes are deliberately
blocked on this transport until a reversible hardware test confirms the
receiver write path.

In particular, do not route this receiver through the SE/SE+ `0x0070`
live-settings selectors merely because both devices belong to the R1 family.
That assumption would send the wrong protocol for polling, lift-off distance,
debounce, and angle snapping.

## Regression checklist

Before enabling additional receiver writes, verify all of the following on real
hardware and restore the original value after each test:

1. Read CID/MID and require `02 1b`.
2. Read the complete system block and record its baseline.
3. Change one polling rate, read it back, and restore the baseline.
4. Change one active DPI stage, including unequal X/Y values, read it back, and
   restore both axes.
5. Verify lift-off distance, debounce, Motion Sync, ripple control, and angle
   snapping one field at a time.
6. Confirm that a receiver-side write does not alter unrelated EEPROM bytes or
   another onboard profile.
7. Re-read the original block(s) and compare them byte-for-byte with the
   baseline before considering the transport writable.

Until that checklist is completed, `0xf58a` remains read-only for persistent
configuration by design.
