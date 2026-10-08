# Glorious Model O 2 PRO 4K/8K

Requested in the OpenMouse Discord (ticket 0160). The driver was written from a
USBPcap capture of Glorious CORE on a wired unit
(`captures/glorious-o2-pro-4k8k-wired/`) and from the code of CORE 2.1.21,
which names every register. It has not run on hardware.

## Which mouse

| Path | VID:PID | Collection |
|-|-|-|
| USB cable | `258a:201b` | usage page `0xffff`, usage 0, unnumbered 64-byte feature report |
| 2.4 GHz receiver | `258a:2035` | same |

CORE's device table calls it "MODEL O 2 PRO 4k/8kHz Edition" and gives both ids.
Interface 1 has another `0xffff` collection (usage 1, no feature report). The
picker may list it as a second entry; the driver claims only the one with the
feature report.

Wired it polls up to 8000 Hz, through the receiver up to 4000 Hz. The product
page gives DPI 100 to 26000, debounce 4 to 16 ms (10 ms default), lift-off
1 to 2 mm (1 mm default).

The classic Glorious driver used to claim both ids with a reduced feature set:
battery, plus RGB and debounce methods the app never surfaced. The ids moved
out of `GLORIOUS_CLASSIC_PRODUCTS` so that exactly one driver claims them. Its
debounce frame is shorter than the one CORE sends (length 1 against 7), which
was never tried on this mouse. CORE builds this mouse's RGB frames with the
classic layout, so RGB can be added to the new client later; it is not
captured here.

## Frame

Unnumbered 64-byte feature reports. A request is `SET_REPORT`; a reply is the
`GET_REPORT` about 60 ms later. No checksum.

```
00 00 02 len bank register data...      profile id first in every per-profile register
```

`len` is the data length, `bank` is 0 system, 1 per-profile settings, 2
per-profile lighting. A reply echoes the request with status `0xa1` in byte 0.
The full register table is in `captures/glorious-o2-pro-4k8k-wired/README.md`.

## Profiles

The mouse keeps three profiles and every setting is written with a profile
number: the position of the profile selected in CORE. The mouse cannot report
which one is active and no read of any setting is known. The driver assumes
profile 1 until the user picks one in the Profile card; picking sends CORE's own
select frame (`00 00 02 01 00 05 <n>`), after which writes land in that profile.
The values the panel shows are the driver's last writes, kept per profile in
localStorage (one set per model, shared by the cable and the receiver), so a fresh
browser shows the factory values (400, 800, 1600, 3200
DPI, 1000 Hz, 10 ms, motion sync on).

## What the driver does

Identity and firmware, battery, DPI stages (value, count up to 6, LED color,
active stage), polling rate (125 to 8000 Hz; the receiver stops at 4000 Hz),
debounce (simple mode, 4 to 16 ms), motion sync, and profile select.

A single DPI edit rewrites the whole stage table, as CORE does, from the values
shown. Frames are sent 30 ms apart and 120 ms after the active stage, CORE's own
pauses. The driver does not read the acknowledgement of a write.

Not done, with the reason:

- Lift-off. CORE writes the same value for its 1.0 mm and 2.0 mm options, so
  the value to distance map is unknown.
- Auto sleep (bank 0 register `0x07`, seconds as u16 BE, `0xffff` for never),
  lighting, buttons, macros, advanced debounce. Not captured; the codec has the
  advanced debounce encoder because the capture contains it.
- Reading the receiver's own firmware: the frame (target byte 0) is CORE's, not
  captured.

## To test

1. Connect in Chrome through control.openmouse.app, on the cable. The status
   should show the model, battery, firmware `1.0.15.0` on the unit that was
   captured, and "Profile 1".
2. Polling: set 1000 Hz, then 8000 Hz, and measure with a polling rate checker.
   Turn Motion Sync off at 8000 Hz, as Glorious advises.
3. DPI: edit a stage, press the DPI button and check the LED color and the
   measured DPI; recolor a stage.
4. Debounce and Motion Sync: set each and check the mouse still clicks.
5. If nothing changes, the mouse is on another profile: pick the profile you
   use in CORE in the Profile card and repeat.
6. Repeat 2 to 4 on the receiver; 8000 Hz must not be offered there.
7. Report the console log and which profile CORE shows as active.

## Sources

- The capture above; no serial numbers or personal data in it.
- Glorious CORE 2.1.21 (Windows installer from gloriousgaming.com), read for
  its device table and `MouseV2ProDeviceHandler` frame builders. Nothing from it
  is committed.
- https://github.com/korkje/mxw (profile select, firmware and battery reads)
  and https://github.com/AMarcinkiewicz/GloriousAutoPollingRate (polling codes,
  measured on a Model D2 Pro 4K, whose receiver `258a:2036` takes the same
  frame).
- https://www.gloriousgaming.com/pages/pro-mice-4k8k for the limits.

## Open

- What the mouse does with 8000 Hz in the wireless byte. CORE wrote it once and
  corrected itself.
- Whether the same frames work unchanged on the Model D2 Pro 4K/8K
  (`258a:201c`, `258a:2036`). CORE gives it the same handler, but no capture of
  it exists here, so it stays on the reduced classic driver.
