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
SE+ over its wired connection. Receiver behavior for this model has not been
tested or claimed. The full sensor table and ranges, and the CID/MID mapping,
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
- Motion Sync, ripple control, and sleep timeout changes were confirmed through
  device readback and restored. Polling changes were acknowledged and restored.
- Lift-off distance and angle snapping use the firmware's fire-and-forget live
  row; both commands and their restores completed, but the device does not
  expose a reliable independent readback for these writes.
- Debounce writing was not exercised because the captured value was 0 while the
  vendor-supported writable range begins at 1 ms, preventing an exact restore.

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
PID and R1 USB product name retained as fallbacks. This makes wired CID/MID
`2,32` use the same current-main live-settings behavior as other R1 variants:

- Polling: 250, 500, and 1,000 Hz through selector `0x0b`.
- Angle snapping: selector `0x01`.
- Debounce: selector `0x02`, 1 through 20 ms.
- Lift-off distance: selector `0x03`, Low or High.

Angle values from EEPROM are accepted only when each value/checksum pair sums
to `0x55`. An unprogrammed `ff ff ff ff` row reports both angle fields as
unsupported.

Battery command `0x04` is decoded according to its declared payload length:
percent requires one byte, the charging flag requires two, and big-endian cell
voltage requires four. A missing or short reply leaves unavailable fields
unknown rather than interpreting padding as data.
