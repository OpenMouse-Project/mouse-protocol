# Finalmouse UltralightX hardware testing

This driver targets the Finalmouse UltralightX control dongle (`361D:0100`) and
ports the report framing used by xpanel and verified in
[FinalmousePollingRateSwitcher](https://github.com/xBambooz/FinalmousePollingRateSwitcher).

1. Connect the ULX through its wireless dongle and turn the mouse on.
2. Close xpanel and stop any Finalmouse polling service before connecting so
   another process does not hold the HID interface.
3. Confirm DPI, polling rate, battery, LOD, Motion Sync, firmware, and RSSI are
   read correctly.
4. Stage and flash one setting at a time, reconnect, and confirm it persisted.
5. Test dongle LED and tournament-scroll modes last.

Do not test firmware flashing. OpenMouse intentionally does not expose it.

## Starlight X (SLX) support — needs hardware verification

xpanel 2.6.2 speaks a superset of the same 63-byte framing to Starlight X
dongles (`361D:0300`/`0301`, output report `0x01`, input report `0x02`;
ULX stays on `0x04`/`0x05`). The SLX command set was reverse-engineered from
xpanel's static JS (`_app/immutable/chunks/idjvmUDg.js`) — no SLX hardware
was available, so every SLX path below is **unverified on hardware**:

- TMR-DS actuation: click mode cmd 31 (`[modeR, modeL]` + optional
  `[relR, relL]`; 0 mechanical / 1 analog; release 0 normal / 1 early /
  2 late), actuation cmd 53 (`[thrR, thrL]` u16le in 0.01 mm steps plus
  `[hystR, hystL]` rapid-trigger sensitivity in µm, 150-250, 220
  recommended), MSP reference cmd 55. The "Smart Rapid Trigger enabled"
  badge is derived from analog mode, not a separate command. Calibration
  capture/live-stream cmds 27-30 are intentionally not wired to any UI.
- PerfectPolling: display-only in xpanel (fixed 250 µs end-to-end claim);
  there is no writable command, so OpenMouse shows an info card.
- LOD custom: PAW cmd 25. Presets send raw 2 (= 1 mm) / raw 3 (= 2 mm);
  the custom slider sends raw 7-17 (= 0.7-1.7 mm). Surfaced through the
  shared `liftOffScale` slider plus the `setLiftOffScale` driver hook.
- Profiles: roster cmd 57 (`[active, count]`, max 5), per-profile content
  cmd 58, LED cmd 61, name cmd 62 (31 chars), enable cmd 63. The app wires
  switch/rename/enable; per-profile content writes exist in the driver
  but have no UI yet.
- Signal: RSSI cmd 13 maps to the 1-4 `signalStrength` scale with xpanel's
  thresholds (|rssi| < 40 → 4, < 50 → 3, < 65 → 2, else 1); link-state 0
  clears it. Enabled for ULX too.

When SLX hardware is available: connect through the SLX dongle, confirm
`readStatus` returns click mode / actuation / MSP / profiles / PAW LOD,
then stage each write and confirm persistence. If SLX writes land on the
wrong report ID, `FINALMOUSE_REPORT.slx` in `src/finalmouse/index.ts` is
the one-line fix. Do not test FOTA (cmds 48/49), pairing (40-42), or OTP
(50) — all deliberately unwired.
