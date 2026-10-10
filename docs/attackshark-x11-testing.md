# Attack Shark X11 testing notes

Genuine X11 (receiver model id `0x55`), 2.4 GHz receiver `1d57:fa60` on
Windows 11 (Firefox 157) through OpenMouse Bridge. Reported in issue #161 by
sLimbutin; raw material is in `captures/attackshark-x11/`.

This is **not** a full hardware verification: no motion-ratio write
round-trip was measured on a genuine X11, and the wired path (`1d57:fa55`)
was not exercised. What the evidence establishes is the identity path and
that the controls the driver exposes match the hardware-verified Delux M600
Pro sibling on the same receiver and protocol
(`docs/delux-m600-pro-testing.md`).

## Identity

| Path | VID:PID | Product string | Receiver model id |
|---|---|---|---|
| Receiver | `1d57:fa60` | `2.4G Wireless Device` | `0x55` (X11) |

No string names Attack Shark, and there is no serial string. The receiver
names the paired mouse through byte 1 of its messages
(`03 <model> 40 01 <pct>`); this unit's messages carry `0x55`, the X11 id in
the `DeviceId` table (HarukaYamamoto0/attack-shark-x11-driver
`src/core/devices.ts`). Once such a message arrives, the client reports
`Attack Shark X11` with brand Attack Shark.

## USB shape (through Bridge on Windows)

Bridge lists seven collections merged into one device, every one with no
feature reports — the same rebuilt shape as
`captures/delux-m600-pro/windows-bridge.txt`:

```
usage 0x1:6  feat[none]     usage 0x1:80 feat[none]
usage 0xc:1  feat[none]     usage 0xa:0  feat[none]
usage 0x1:2  feat[none]     usage 0xb:0  feat[none]
usage 0x1:6  feat[none]
```

The `0x0b` config collection therefore declares nothing
(`x11RebuiltConfigCollection`). Before #174, `X11_REBUILT_CONFIG_MODELS`
listed only the Delux M600 Pro (`0x20`), so a genuine X11 stayed
`settingsReady: false` ("needs a native driver") even over Bridge — the
failure in #161. #174 adds `0x55`: same receiver, protocol and rebuilt
transport as the verified M600 Pro, resolving to the receiver's documented
56-byte DPI frame (`x11UsesShortDpiReport` returns the long form for
`0xfa60`). Models whose frame shape is not established (R1 `0x10`, X3
`0x4d`/`0x4e`, X6 `0x85`) stay read-only.

## Observed facts

Pre-fix Bridge diagnostic (`openmouse-1d57-fa60-2026-10-04-08-48-28.json`,
webapp `BETA · v2.0.c81`):

- `settingsReady: false`, `supportedPollingRates: []`, DPI 0, no battery.

Post-merge hardware test (`AttackSharkX11hardwaretest.json`, webapp
`BETA · v2.0.f3d`, 2026-10-06):

- `supportedPollingRates: [125, 250, 500, 1000]`, battery 100 % pass.
- DPI and polling-rate read-back fail: by firmware design, not a
  regression — the X11 exposes no current-DPI or polling read-back, so the
  driver reports its cached/default stages and last-applied rate.
- Polling sampling skipped (`avg 64 Hz vs reported 1000 Hz`): dropout/rate
  mismatch during the sample, not counted as a failure.
- Flash read-back fails (no decoded flash fields on this firmware).

Reporter confirmations on the merged fix:

- Changing the polling rate works.
- Final report: "I'm seeing DPI and polling rate controls now and both seem
  to be working."

The Bridge service log from the same session shows the pre-existing
`native-hid` limitation, fixed separately in the Bridge repo: its
`apply.mjs` X11 shortcut accepted polling-only requests
(`Attack Shark X11 native DPI control is not implemented yet`). DPI through
Bridge's own profile-apply path goes through the generic
`AttackSharkHidClient` 0x04 path there now.

## Unknowns

- No measured motion-ratio DPI round-trip on genuine X11 hardware (the M600
  Pro sibling measured 3.5–3.8x on a 4x swipe; nothing equivalent exists for
  `0x55`).
- Wired path (`1d57:fa55`, 52-byte DPI form) untested on a genuine X11.
- Whether settings persist across power cycles was not tested.
- The receiver write-spacing freeze (writes <1 s apart freeze the link until
  replug) was measured on the M600 Pro sibling and is enforced for all X11
  receiver writes; not re-measured on the X11.
- Lift-off distance, debounce, sleep, lighting: no packets captured.
