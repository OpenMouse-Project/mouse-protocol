# ROCCAT Kone Pro Air testing

How the `src/roccat/` protocol and the `src/drivers/roccat/` driver were put
together, what was proven on hardware, and what stays open. The captures live
in `captures/roccat-kone-pro-air/`.

## Device

One ROCCAT Kone Pro Air, firmware as shipped, wireless mode on its Stellar
Wireless dongle (`1e7d:2c8e`). ROCCAT Swarm was never installed on the host,
so every byte on the control channel in the captures is a probe or a
vendor-replayed frame, not Swarm traffic. Wired mode (`1e7d:2c92`) is
mapped from the same protocol family but was not exercised on this unit.

## Transport

The config channel is the composite's vendor interface — interface 2 of the
dongle (interface 1 wired), usage page `0xFF00` usage `0x0001` — and it
speaks plain **unnumbered 64-byte output reports**. Windows GET sweeps for
every report id answer nothing on any interface
(`captures/roccat-kone-pro-air/feature-sweep.txt`), so everything below is
`sendReport(0, …)`-shaped, and the mouse answers on the same interface's
interrupt-IN stream. On Windows node-hid the echo arrived on the same handle.
A WebHID `inputreport` listener on the same device object matches it the
same way.

Frame vocabulary, all in device coordinates (the vendor's 64-byte frames,
report id excluded):

```text
10 50 14 00 01 <polling> <angle> 00 <stage table 8..17> <lod> 00 80 <ledTimeout> 00 <debounce>   settings write
10 50 14                                                                                            settings query (no args)
10 50 18 04                                                                                         commit tail
10 10 0b 00 09 64 64 64 06 <r g b> <r g b>                                                          lighting write (two zones)
90 0a                                                                                               status probe
```

Echoes repeat frame byte 1 (the class byte) verbatim, which is how the driver
matches replies. Byte 2 of performance echoes was `0x03` every time; the
echo's later bytes are not established.

Polling codes are the **opposite** of the Burst Core dict
(`Roccat_Burst_Core_Mouse.js`) used on ROCCAT's older OEM mice: here
125 Hz → `0x03`, 1000 Hz → `0x00`, per the public plugin that drives this
generation. DPI is stored per-50 in the byte slots 8..17, five stages of two
axes interleaved.

## What is verified on hardware

- **The vendor-replayed settings write and its commit tail are accepted** and
  echo the expected class frame (`10 50 03 …`).
- **A settings echo carried a full stage table once the mouse was awake**:
  both slot lists identical, five entries `800 / 1200 / 1600 / 3200 / 5000`,
  matching the unit's then-current Swarm configuration. On the same unit,
  idle, the same query echoed an **empty body** (all twenty slots zero). The
  decoder therefore treats an all-zero table as "no data".
- **The status probe answers every poll**: `90 0a 04 00 00 <b5> <b6> 00
  <u16> <b10>`, where byte 5 moved `0x1e → 0x14` between sessions and bytes
  8–9 *increased* (2720 → 2884) — falsifying the "estimated minutes
  remaining" reading of that word. Byte 5 is the number the decode surfaces,
  with an explicit unconfirmed-mapping caveat in the code.
- **The lighting write is idempotent** on repeat (three identical writes
  returned identical answers), and leaves the mouse's LEDs stable. There is
  no known read-back, so the codec ships lighting write-only.

## Deliberately not shown on the UI

Polling rate read-back, lift-off, angle snapping and debounce have no
established echo positions, so those UI values surface from the driver's own
last write and the shared cards stay consistent with other
write-only-cached drivers (this mirrors the Razer driver's approach).

## Open questions (any owner can settle these with a replug)

- Which slot list is sensor X and which is Y (both printed identical here).
- The status echo's battery-percent mapping (watch it drain while polling).
- The wired generation's parity: interface index shifts by one per the
  community plugin; nothing was captured on the cable.
- The idle state's empty settings echo — does it also occur right after
  replug while awake?
