# Endgame Gear OT platform (XM1r / OP1 / OP1 RGB)

Recognition-grade protocol support. No OT mouse has been exercised on
hardware yet: every entry below is decoded from vendor software, not from a
live device.

## Evidence

- `OP1_and_OP1_RGB_Config_Software_1.6.400.exe` (Inno Setup): inner Electron
  app v1.6.400, Angular + node-hid, `main-es5.js` webpack bundle. Device
  filter accepts VID `0x3367` with PIDs `0x1903/0x1905/0x1906/0x1910`; nav
  artwork maps pages 1–3 to XM1r / OP1 / OP1 RGB and page 4 to a wireless
  section using `xm2w_*` artwork. Per-device CPI ceilings in code: 19000
  (0x1903), 26000 (others).
- `XM1r Configuration Software 1.2.2 (beta).exe` (Inno Setup): inner
  Electron app v1.2.2, same codebase, PID `0x1903` only.
- The vendor TypeScript sources above are the authority for: the 64-byte
  report-0 framing (`OS_DATA_SIZE = 64`, comtype at 1, packet id at 2,
  payload at 3), the 54-opcode COMTYPE table, the 118-byte effect struct
  field order and sizes (`fillArrayBufferWithEffectItem`), the six profile
  blocks (`Custom_HID_Save_Profiles` / `Custom_HID_Load_Profiles`), the
  profile-flags bits (`MakeProfileFromEffect`), the firmware flash flow
  (`Custom_HID_Update_Firmware`: DlSetup, 2 s settle, indexed data packets,
  then `Custom_HID_RESET_FIRMWARE` with the `0x0BADF00D` magic as a separate
  step), and the retry budget (10 writes, 10 reads).
- `XM1 Configuration Software V1.09` and `XM1_RGB V1.01` are InstallShield
  `ISSetupStream` bootstraps that 7z, unar, and innoextract cannot unpack on
  macOS, so XM1/XM1 RGB PIDs are unknown and those mice are not mapped.

## Deliberate gaps and unknowns

- PID `0x1910` is accepted by the vendor HID filter and opens the wireless
  page, but no mouse name is attached to it in the shipped app, so
  `OT_DEVICE_PROFILES` leaves it out (`OT_UNMAPPED_WIRELESS_PID`).
- The `u8PollRate` array carries 3 bytes and `u8PollrateIndex` selects the
  active one; the index→Hz map (0=1000, 1=500, 2=250, 3=125) comes from the
  vendor struct comment, not from a wire observation.
- The wireless telemetry block (battery, link levels) is parsed from the
  block-4 query reply shape; the battery charging bit (bit 7) is inferred
  from app timer logic, not confirmed on the wire.
- `kComQueryFirmwareVersion` reply layout is unknown: the driver returns raw
  payload bytes.
- `kComActivateProfile`, macro up/download, and LED-effect commands are in
  the opcode table but have no driver methods until their payloads are
  confirmed against hardware.
- Flash/reset methods implement the vendor flow byte-for-byte but must not
  run without a hardware owner confirming each step; they are split into
  `flashFirmware()` and `resetFirmware()` so a reset can never ride along
  silently.
