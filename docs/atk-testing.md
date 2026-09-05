# ATK / VXE hardware testing

Use the vendor configuration interface (`usagePage 0xff02`, `usage 0x02`). It
uses report ID `0x08` with a 16-byte payload. Do not record device serial
numbers in captures or test documentation.

## Identification

Shared USB product IDs do not reliably identify the mouse or sensor. The driver
sends CID/MID command `0x10` and looks up the returned pair in
`src/drivers/atk/products.ts`. A failed identification is retried up to three
times because a sleeping wireless mouse may not answer. Closing the client
resets that retry budget.

A successful but unknown ATK identity retains the historical A9 codec and
USB-name behavior. Generic ATK devices that do not answer CID/MID do the same.
A shared VXE R1 transport that does not answer instead fails before using that
fallback codec. Known VXE identities report the VXE brand.

## Verified VXE R1 SE+

The raw EEPROM and identity values below were captured directly from one VXE R1
SE+ over its wired connection. The receiver telemetry described below was
tested separately. The full sensor table and ranges, and the CID/MID mapping,
were independently transcribed from the public ATK HUB 3.2.21 bundle; the
low-range records below cross-check that transcription.

- USB: VID/PID `0x3554:0xf58f`, product `VXE R1SE+`, firmware/bcdDevice 3.15.
- Configuration channel: interface 1, usage page `0xff02`, usage `2`.
- CID/MID: `2,32`, identified by ATK HUB as VXE R1SE+ with PAW3395SE.
- Battery response: declared payload `5f 01` reports 95% and charging. Bytes
  after the declared payload are padding and are not interpreted as voltage.
- Vendor range: 200 through 18,000 DPI.
- EEPROM DPI stage `12 12 00 31` decoded as 800 DPI.
- EEPROM DPI stage `25 25 00 0b` decoded as 1,600 DPI.
- EEPROM DPI stage `4b 4b 00 bf` decoded as 3,200 DPI.
- Writes at 200, 10,000, 10,100, and 18,000 DPI were each confirmed through
  device readback, including the high-DPI mode transition, then restored to
  800 DPI.
- OpenMouse was also exercised in Chromium through WebHID: it identified the
  wired mouse, displayed 800 DPI and 1,000 Hz, applied 850 DPI through the
  staged-save UI, and restored 800 DPI.
- Motion Sync, ripple control, sleep timeout, 125 Hz polling, 2 mm lift-off,
  1 ms debounce, and straight-line correction changes were confirmed through
  wired EEPROM readback and restored.
- ATK HUB 3.2.21 exposes wired polling at 125, 250, 500, and 1,000 Hz; debounce
  at 0, 1, 2, 4, 8, 15, and 20 ms; 1 mm and 2 mm lift-off; and straight-line
  correction in the advanced EEPROM block. OpenMouse follows those exact wired
  EEPROM paths.
- The same HUB build exposes up to eight DPI stages for this identity. The
  active two stages were read as 800 and 1,600 DPI. Active-stage selection and
  arbitrary-stage values were changed, confirmed, and restored. The configured
  count remained at two because adding stages changes the user's profile shape.
- A DPI-stage color, Basic/Competitive performance mode, Ultra Long Range, and
  DPI lighting effect/brightness/speed were each changed, confirmed through
  device readback, and restored. The final complete run reported every setting
  at its captured baseline.

PAW3395SE maps targets 50 through 10,000 in 50-DPI increments to codes 1
through 235 while skipping these codes:

```text
7, 13, 20, 26, 33, 40, 46, 53, 60, 66, 73, 80, 86, 93, 100, 106, 113,
120, 126, 133, 140, 146, 153, 160, 166, 173, 180, 186, 193, 200, 206,
213, 220, 226, 233
```

The exposed writable options are 200 through 10,000 in 50-DPI increments,
then 10,100 through 18,000 in 100-DPI increments. Values above 10,000 encode
half the requested DPI and set bit 1 in that axis's mode nibble. This is mode
bit 1 for X and mode bit 5 for Y. Codes in the skipped set and invalid mode
combinations must be rejected rather than decoded approximately.

## R1 live settings

R1 family detection uses the identified product family, with the known receiver
PID and R1 USB product name retained as fallbacks. The stock receiver retains
the current live-settings behavior transcribed from OpenVXE:

- Polling: 250, 500, and 1,000 Hz through selector `0x0b`.
- Angle snapping: selector `0x01`.
- Debounce: selector `0x02`, 1 through 20 ms.
- Lift-off distance: selector `0x03`, Low or High.

The wired CID/MID `2,32` path instead follows ATK HUB's EEPROM configuration:
polling at `0x0000`, stage count and active stage in the same system block,
up to eight DPI records from `0x000c`, lift-off at `0x000a`, and debounce,
Motion Sync, sleep, straight-line correction, and ripple control at `0x00a9`.
DPI-stage colors start at `0x002c`, DPI lighting is at `0x004c`, and the
six-byte record at `0x00b5` stores sensor-sleep enabled, sensor-sleep time, and
the sensor model exposed by the HUB as Basic/Competitive mode. Each field has a
paired checksum byte, and the complete record must be written atomically. Ultra
Long Range uses write command `0x16` and read command `0x17` rather than EEPROM.

The middle pair at `0x00b5` read `0c 49` while the one-minute user sleep timer
at `0x00a9` read `06 4f`. Attempts to treat the `0x00b5` pair as a second copy
of the configurable timer did not retain non-default values, so OpenMouse does
not write it when changing sleep timeout.

Angle values from EEPROM are accepted only when each value/checksum pair sums
to `0x55`. An unprogrammed `ff ff ff ff` row reports both angle fields as
unsupported.

Battery command `0x04` is decoded according to its declared payload length:
percent requires one byte, the charging flag requires two, and big-endian cell
voltage requires four. A missing or short reply leaves unavailable fields
unknown rather than interpreting padding as data.

## Profile selection and read-only button inspection

ATK HUB exposes four firmware-managed configuration banks through
`GetCurrentConfig` (`0x0e`) and `SetCurrentConfig` (`0x0f`). OpenMouse currently
reads the active bank and can switch banks over the verified wired transport.
The selector request declares one data byte at frame offset 4 and stores the
zero-based bank at offset 5. Hardware testing cycled all four banks, captured
5,376 bytes from each, restored bank 0, and reproduced its original SHA-256
exactly. The captures differed across settings, buttons, and shortcut storage,
confirming that EEPROM reads are redirected through the active bank.

A recovery test isolated a two-event macro in bank 3, slot 0, without assigning
it to a button. After a factory-reset experiment, banks 0 through 2 reproduced
their original complete-image SHA-256 hashes. Bank 3 reproduced its original
image outside slot 0; replaying ATK HUB's four-chunk macro reset sequence set the
slot count to zero. Previously programmed event bytes cannot be changed back to
their erased `0xff` representation through the observed EEPROM command, but a
zero count makes them unreachable and matches the vendor's empty-macro
semantics. The active bank was restored to bank 0. This also confirmed that
checksum-protected settings and macro headers must retain the vendor's record
and transaction boundaries during writes.

The wired R1 button matrix contains six four-byte records at `0x0060`,
`0x0064`, `0x0068`, `0x006c`, `0x0070`, and `0x0074`. Each record is
`[class, value1, value2, checksum]` and all four bytes must sum to `0x55`
modulo 256. OpenMouse reads them in the same three eight-byte groups as ATK
HUB, preserves unknown values, and reports checksum failures. It does not write
button records. Shortcut slots begin at `0x0100` in 32-byte increments. The
vendor address table defines 12 macro slots beginning at `0x0300` in 384-byte
increments and ending at `0x1500`. Neither region is read during ordinary
status polling.

Receiver command `0x03` reports online state and the three-byte RF identifier.
Command `0x06` reports pairing status and seconds remaining. Both are safe
telemetry reads. On the verified `0x3554:0xf58e` receiver, OpenMouse can start
pairing command `0x05` for the R1 SE+ identity `[CID 0x02, MID 0x20]` after an
explicit preparation step. Cancellation command `0x13` remains unavailable.

The Nordic receiver was identified over USB as `0x3554:0xf58e`, product `VXE
Mouse 1K Dongle`, firmware/bcdDevice 1.10. Its configuration channel is
interface 1 with usage page `0xff02`, usage `2`, and report `0x08`. Read-only
hardware probes produced checksum-valid replies for online status (`0x03`),
pairing status (`0x06`), and dongle version (`0x1d`). The online reply declared
one payload byte for status while retaining the three-byte RF identifier in its
fixed frame positions, so the driver requires the declared status byte and
decodes the identifier from the complete validated frame.

Pairing was validated with the mouse cable unplugged and the mouse switched to
2.4 GHz mode. After command `0x05`, holding left click, wheel click, and right
click until the indicator flashed completed the exchange. Command `0x06`
reached status 2 with zero seconds remaining, command `0x03` reported the mouse
online, and the RF identifier remained stable across repeated reads. A prior
attempt without the physical button gesture also reached status 2 but remained
offline, so status 2 alone is not success. OpenMouse requires both terminal
status 2 and online telemetry. Profiles 0 through 2 retained their exact
pre-pairing hashes, profile 3 retained its zero-count cleared macro state, and
the active bank was restored to bank 0 after verification.

## Firmware package inspection

The official R1 SE+ 3.15 COMPX package is 261,382 bytes. Its 720-byte logical
header sits in an 8,192-byte header area followed by a 253,190-byte payload.
The header identifies normal endpoint `0x3554:0xf58f`, boot endpoint
`0x3554:0xf406`, IC `CX52850P`, sensor `3395se`, and version `0x315`.

The prepare-command descriptor stores the raw CRC-32 register state (initial
value `0xffffffff`, polynomial `0xedb88320`, no final XOR) in big-endian order.
For version 3.15 it is `0x4026708e`; for version 3.14 it is `0xab88f525`.
OpenMouse's package parser checks this payload CRC and package bounds. The
vendor upgrader reads the header's `headCRC` field but does not appear to
validate it, so OpenMouse does not claim that field as an integrity check.

Firmware parsing is read-only. Entering boot mode, erase preparation, chunk
transfers, factory reset, and macro clearing remain intentionally unavailable.
