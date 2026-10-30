# Incott lift-off fixtures

Hardware evidence for the per-sensor lift-off tables in `src/incott/`. One
white, first-generation G23 Pro (PAW3950, identity `09 8f 01 02 02 f0 f1 00 02`)
on the 8K dongle (`093A:522C`, 8000 Hz), 2026-10-30.

Each lift-off step was set with the INCOTT Driver desktop app v1.0.5
([oexi/incott-driver-desktop](https://github.com/oexi/incott-driver-desktop),
a port of the vendor's WebHID configurator), the app was closed, and the
OpenMouse hardware test (control.openmouse.app BETA v2.0.828, Chrome 156,
Windows 11) then read the mouse. Every report OpenMouse sent is a query;
the files are its exports, unmodified. No serial string is exposed.

| File | Set in the vendor port | `0x84`/`0x01` reply | Wire |
| --- | --- | --- | --- |
| `lift-off-0.7mm-wireless.json` | 0.7 mm | `09 84 01 02 ...` | `2` |
| `lift-off-1mm-wireless.json` | 1 mm | `09 84 01 00 ...` | `0` |
| `lift-off-2mm-wireless.json` | 2 mm | `09 84 01 01 ...` | `1` |

This reads all three PAW3950 points individually; the 2026-09-08 session had
read only 0.7 mm. No PAW3395 unit has been read.
