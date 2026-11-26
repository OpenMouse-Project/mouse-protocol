# ROCCAT Kone Pro Air fixtures

Hardware reference material for `src/roccat/` and `src/drivers/roccat/`.
Captured from this reporter's own unit — one ROCCAT Kone Pro Air on its
Stellar Wireless dongle (USB `1e7d:2c8e`), Windows. The first session
(2026-10-14) was a driverless node-hid session with ROCCAT Swarm
uninstalled; a later session (2026-10-16, the last file in the table) ran
with Swarm installed and operating the mouse. The mouse's product string
carries no serial number, the vendor frames carry no account data, and no
capture here includes personal data.

| File | What it is |
|-|-|
| `device-enumeration.txt` | The four HID interfaces and their usage pages/uses as Windows presents them (node-hid + PnP). The config channel is interface 2, `0xFF00:0x0001`. |
| `feature-sweep.txt` | The negative result: GET for every report id 0x00–0xFF on every interface times out or answers zero. The whole protocol lives on output reports, which is why the frames are `sendReport`-shaped. |
| `session-2026-10-14.txt` | A byte-precise transcript: status probe, settings query, the vendor-replayed settings write + commit tail, a second query, the lighting write, and the echoes to each. One session earlier the query echo carried a full stage table (the mouse awake); in this session the mouse was idle and the same frame echoed an empty body — both are in the file. |
| `transcript-earlier-session.txt` | The earlier, still byte-precise outline of the same frames from the discovery session, included because it is the capture where the stage table WAS returned (`10 50 03 … 10 10 18 18 20 20 40 40 64 64 01 02 00 00` — both slot lists identical, five entries 800/1200/1600/3200/5000, which matches this unit's then-current Swarm settings rather than factory defaults). |
| `profiles-and-write-path-2026-10-16.txt` | A second session, this one with Swarm installed and driving the mouse. Identifies the five `90 00 26` reply pages as the five onboard profiles (polling at `b11`, stage table at `b14-23`, lift-off at `b24`), shows a UI polling change moving exactly that byte, aligns the read page to the plugin's write frame at +5, and records that hand-sent settings writes on interface 2 are echoed but never change the stored tables. |

## What settles

- **Transport.** Unnumbered 64-byte output reports on interface 2
  (`0xFF00:0x0001`; interface 1 on the wired generation). No feature report
  exists on this interface — `feature-sweep.txt` proves the negative.
- **Frame shape.** `10 <class> <sub> …` where class `0x50` is the
  performance/settings group, `0x10` the lighting group, and the status
  probe is the two-byte `90 0a`. Echoes come back on the same interface's
  input stream and repeat byte 1 verbatim.
- **Settings write (captured, not implemented).** `10 50 14 00 01 <polling>
  <angle> 00 <five stage pairs, offsets 8..17> <lod 18> 00 80 <led timeout 21>
  00 <debounce 23>` followed by the commit tail `10 50 18 04` — byte-for-byte
  the sequence the vendor software replays (SignalRGB's WhirlwindFX plugin is
  public evidence of that replay). The frames are echoed and accepted, but no
  hand-sent write ever changed a stored table read back afterwards, so the
  driver ships no setter and `src/roccat/` has no encoder for them.
- **Status probe.** `90 0a` answers `90 0a 04 00 00 <b5> <b6> <b7> <w8> <b10>`:
  byte 5 was 0x1e across one session and 0x14 across another. Bytes 8–9
  (0x0aa0 = 2720, later 0x0b44 = 2884) go up as well as down, so the
  "estimated minutes remaining" reading stands falsified. Whether byte 5 is
  the battery percent has to be settled by watching it drain.
- **Lighting write (captured, not implemented).** `10 10 0b 00 09 64 64 64 06
  <r g b> <r g b>` for the two inner zones, echoed `10 10 03 …`. No read-back
  is known, so nothing about lighting ships.

## What does not settle

- **The percent meaning of status byte 5** (see above).
- **Read-back of the settings block in the idle state.** With the mouse
  idle/sleeping, the `10 50 14` query echoes with an empty body; with the
  mouse awake, an earlier session returned the twenty-slot table. The decoder
  treats all-zero tables as no-data instead of five zero-DPI stages.
- **Which slot list is X and which is Y.** The echo carried both lists with
  identical values on the captured unit, so the assignment (even slots =
  the vendor UI's stage list) is Replay-proven but sensor-axis-unproven.
- **Wired generation `2c92` parity.** The wired mode enumerates the same
  interfaces one index earlier (interface 1) per the community plugin's
  `Validate` guard; nothing here was captured on the cable.
