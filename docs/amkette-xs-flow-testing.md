# Amkette XS Flow series and Ryunix Kyu Pro MX1 integration note

This note records the evidence and the remaining checks for Amkette's XS
series on the `0x04F3` OEM firmware. The Amkette XS mice and the Ryunix Kyu Pro
MX1 enumerate with the same vendor and product IDs and, as far as the vendor
configurators show, speak the same protocol. The wire codec is shared and lives
in `src/ryunix/`; what identifies the Amkette models (IDs, usage, product strings,
Bluetooth names) is in `src/amkette/`, which imports the shared codec. The two
brands have separate drivers:

- `src/drivers/amkette/xs-hid.ts` (`AmketteXsHidClient`) drives a mouse whose
  configuration collection is on usage `0x00`, which is what an XS Flow 2 Speed
  publishes on all three paths. It reads telemetry and writes settings.
- `src/drivers/ryunix/kyu-pro-mx1-hid.ts` (`KyuProMx1Client`) keeps the Kyu Pro
  MX1's collection on usage `0xC7` and is unchanged: read-only telemetry. None
  of the writes below have been checked on a Kyu Pro MX1, so they are not
  enabled for it, the same way the Noir Gear M2-NEX was added without changing
  the K-snake X11's behaviour.

The usage is the only thing seen to differ, from one unit of each. If a Kyu Pro
MX1 turns out to publish usage `0x00`, it would get the Amkette driver and be
shown as Amkette; if an XS mouse publishes `0xC7`, it would get the read-only
one. A mouse publishing both usages has not been seen. Within one `HIDDevice`
the Amkette driver refuses it, but where WebHID exposes each top-level
collection as its own device (Windows), the two collections would appear as two
devices, one for each driver.

## Identity and connection paths

| Path | VID | PID | Usage page | Usage |
| --- | ---: | ---: | ---: | ---: |
| Bluetooth LE | `0x04F3` | `0x026D` | `0x0A` | `0x00` |
| USB | `0x04F3` | `0x026E` | `0x0A` | `0x00` |
| 2.4 GHz receiver | `0x04F3` | `0x026F` | `0x0A` | `0x00` |

Amkette's configurator treats any product ID other than `0x026E` and `0x026F`
as Bluetooth; `0x026D` is the one seen on hardware.

## Naming

The firmware reports a USB product string (descriptor index 2). An owned XS Flow
2 Speed returns `XS Speed` in UTF-16 on a standard string-descriptor request.
That equals the label Amkette's configurator shows for the model; the XS Flow
Plus and XS Natural Plus configurators use `XS Flow+` and `XS Natural+`.

The driver maps those labels and the Bluetooth names below to the Amkette model
(`amketteXsModel`), shows "Amkette" and the retail name, and drops the
lighting card for the XS Natural Plus (no lighting scheme). Retail names are not
matched, because the firmware has not been seen to report them. Only `XS Speed`
has been seen on hardware; the other two labels come from their configurators.

macOS does not surface the string over USB for this mouse: `ioreg` and system
profiler list no product, manufacturer or serial, and the browser's
`productName` is empty, even though the descriptor read succeeds and survives a
replug. Over the 2.4 GHz receiver (`0x026F`) macOS does show a name, but it is
the generic `2.4G Wireless Receiver`, which names the dongle and not the mouse.

Over Bluetooth LE (`0x026D`) the mouse is listed by macOS as `XS speed 2`
(manufacturer `RivieraWaves SAS`, the Bluetooth stack vendor, not Amkette). The
mouse holds three Bluetooth slots and the number in the name is the active slot:
this unit was on slot 2. The driver accepts `XS speed 1`, `2` and `3` as the XS
Flow 2 Speed and reports the slot in the connection detail, so a Bluetooth
connection is identified where the cable is not. Only slot 2 has been seen; slots
1 and 3 follow the owner's description, and whether they keep PID `0x026D` is
unchecked.

The brand follows the same evidence that chooses the driver. A device on the
usage-`0x00` collection is driven by the Amkette driver, so it is shown as
Amkette; the product name only refines the model. With no model name it is
shown as "Amkette XS series". This differs from the Noir Gear M2-NEX on the
K-snake protocol, where the name is the only thing that tells the brands apart
and an unnamed device stays K-snake X11; here the collection's usage already
separates them. Receiver-style strings are not shown as the mouse name; any
other reported name is kept.

In practice, on macOS the model name appears only over Bluetooth ("XS Flow 2
Speed"). On the cable and the receiver the mouse is shown as "Amkette XS
series", with the XS Flow 2 Speed's settings. A model name is expected to arrive
over USB on platforms whose HID layer reads the string. On Windows it does: over
USB the browser reports `XS Speed` and OpenMouse shows "Amkette XS Flow 2
Speed".

## Evidence

The protocol is reverse-engineered from Amkette's public WebHID configurators
(`support.amkette.com/webapp/xs_flow_2_speed/`, `xs_flow_plus/` and
`xs_natural_plus/`). The three are one build with different model settings.
No vendor binary or proprietary source is included. Amkette's other web
configurators use different IDs (Phantom Air Wireless, `0xB6A4`) or publish no
HID filters, and are not covered.

Read-only probing of an owned, wired XS Flow 2 Speed produced:

- input report `0x04` body `01 02 01 64 02 00 00 01 20`: link up, DPI stage 3,
  1000 Hz, battery 100, battery status 2, lighting off, top rate class 1,
  sensor `0x20` (PixArt 3220);
- feature report `0x05`: `31 30 31 30 01 01` (looks like ASCII "1010"; meaning
  unconfirmed, so not surfaced);
- feature report `0x06`: `01` in byte 1, the acknowledgement of success.

Amkette's page showed "Full 100%" at the same time, which fixes battery status
`2` as full.

The same mouse over its 2.4 GHz receiver (`0x026F`, bcdDevice 0x0301 against
0x0109 on the cable) sent body `01 02 01 64 00 02 00 01 20`: battery 100,
battery status 0 (discharging), 1000 Hz, DPI stage 3, lighting mode 2
(Breathe, set earlier through OpenMouse) and the same sensor `0x20`. Feature
report `0x05` returned the same `31 30 31 30 01 01` as over USB, so it does not
identify a model. The HID layout matches the USB one.

Over Bluetooth LE (`0x026D`, bcdDevice 0x0109) the control collection, with the
same reports `0x04`, `0x05`, `0x06` and `0xBC`-`0xBF`, sits on one composite HID
interface (only report `0xBF` is shorter, 39 bytes against 135). Feature report
`0x05` again returned `31 30 31 30 01 01`, and the telemetry body was
`01 02 04 64 00 02 00 31 20`: battery 100, 250 Hz, DPI stage 3, Breathe, top
rate class `0x31` and sensor `0x20`. Class `0x31` is the vendor app's "125 and
250 Hz only" class, which matches Bluetooth's lower polling ceiling.

## Wire format

Commands are 31-byte feature reports on report `0x06`:
`[command, sequence, sub, checksum, ...payload]`, where the checksum is
`(6 + sum of the other 30 bytes) & 0xFF`. Reading report `0x06` back returns
the acknowledgement (byte 1 equal to 1). Reading report `0x05` makes the mouse
emit telemetry on input report `0x04`; the mouse sends telemetry on request, not
on change. The codec's golden vectors re-implement the vendor app's own framing
independently.

## Verified on hardware (XS Flow 2 Speed)

- the control collection is offered by the picker and opens over USB, on macOS
  and on Windows;
- on Windows over USB the browser reports the product name `XS Speed`, and the
  mouse is shown as Amkette XS Flow 2 Speed;
- telemetry decodes on USB, the 2.4 GHz receiver and Bluetooth LE: battery,
  battery status, DPI stage, polling rate, lighting mode, top polling class and
  sensor type;
- over USB, a polling-rate write through OpenMouse is acknowledged and confirmed
  by a fresh status report, and a Breathe lighting write is applied (the mouse
  reports lighting mode 2 afterwards);
- lift-off writes are acknowledged over Bluetooth and the receiver, and lighting
  effect writes over the receiver (probe tool, see the sections below).

## Not yet verified

These are encoded from the vendor app and covered by codec tests, but have not
been checked against the mouse: the DPI table and stage colours, active stage
switching, auto sleep, angle snapping, motion sync, ripple control and button
remapping. Whether lift-off, brightness and effect speed change anything
physically has not been recorded. Writes through OpenMouse over the receiver and
Bluetooth, polling rates above 1000 Hz, and the XS Flow Plus and XS Natural Plus
models are untested. Bluetooth is claimed on the strength of read-only probes
plus acknowledged lift-off writes from one unit on slot 2; slots 1 and 3, and
whether they keep PID `0x026D`, are unchecked.

## Lift-off is not readable (tested)

A differential test over Bluetooth wrote only the lift-off command (1 mm, then
2 mm, ending on 2 mm) and dumped every readable feature report before and after.
Reports `0x05` and `0x06` did not change apart from the acknowledgement
(`06 00` became `06 01`). Reports `0xBC`, `0xBD` and `0xBF` changed, but they
mirror the last command frame the mouse received, report id included: before the
test they held `06 08 07 01 ff` (an earlier sensor-options command from the
vendor page), after the 1 mm write `06 05 71 01 64 01`, and after the 2 mm write
`06 05 72 01 66 02`. They echo the most recent command, not a setting, so they
confirm receipt but cannot tell the current lift-off. Report `0xBE` refuses
reads. The status report carries no lift-off field. Lift-off is therefore
write-only on this firmware, like DPI values, sleep and the sensor toggles.

The same test over the 2.4 GHz receiver (`0x026F`) found no readback at all:
`0xBC`-`0xBF` return no data there, the status report and report `0x05` did not
change between 1 mm and 2 mm, and the acknowledgement lags. After a write the
acknowledgement read `06 00` at 60 ms and `06 01` from 150 ms, and one write in
the first run never showed `01`; a re-send was acknowledged. The driver therefore
polls the acknowledgement for up to 600 ms before re-sending. Bluetooth
acknowledged immediately. Lift-off ended on 2 mm on both paths.

The macOS `IOHIDDeviceSetReport` call used for the Bluetooth test returned a generic
error code (`0xe00002bc`) for both writes even though the mouse acknowledged
them and echoed the frames; that code was not investigated.

## Brightness and effect speed are not readable (tested)

A differential test over the 2.4 GHz receiver wrote only lighting commands and
read the status report after each: Steady at 100% (byte `0x40`) and 25%
(`0x10`), then Breathe at speed 1 (`0x01`) and speed 3 (`0x03`). Every command
was acknowledged on the first attempt. The lighting-mode byte of the status
report followed the effect (3, 3, 3, 2, 2), but no other byte of the status
report, report `0x05`, or the acknowledgement differed between 100% and 25% or
between speed 1 and speed 3. Brightness and speed are therefore write-only: the
mouse accepts the commands, but nothing readable shows whether it applies them.
Whether the light changes has to be judged by eye; that has not been recorded.
The mouse was found on Steady before the test and left on Breathe at speed 3.

## Write-only settings

The mouse reports only battery, active DPI stage, polling rate, lighting mode,
top polling class and sensor type. DPI values, stage colours, lift-off, sleep,
the three sensor toggles and button assignments cannot be read back. The driver
shows what it last wrote this session and, before any write, the vendor app's
defaults (seven DPI stages from the sensor table, 2 mm lift-off, one minute
sleep, motion sync on). The status note says so.

Consequences worth knowing:

- the DPI table is written whole: the first DPI edit replaces all stages with
  the defaults plus the edit;
- the active stage can only be chosen by writing the whole table, so choosing a
  stage in OpenMouse writes the table it shows (the vendor's defaults until
  something else is written) with that stage active, as Amkette's configurator
  does on every stage click. Stages stored on the mouse by another tool are
  replaced. An earlier version refused stage selection until a table had been
  written, but clicking a stage number is OpenMouse's main way to pick a DPI, so
  on Windows that showed an error on the first DPI change. OpenMouse reads which
  methods a client has once, when the device connects, so the driver cannot
  hide stage selection for part of a session; a UI hint for that would be an
  OpenMouse change;
- DPI is not written until the mouse has reported its sensor type, since the
  wire value counts in steps of 50 or 100 depending on the sensor;
- the three sensor toggles are written together, so changing one writes the
  others' last known (or default) values;
- a button write carries all ten positions. Positions not changed this session,
  including the bottom mode switch, are written as the vendor app's default
  layout, as the vendor app does, so a layout stored by another tool is reset.
  0xFF ("not configured" in the vendor app) is not used, because what the
  firmware does with it is unknown;
- what was written is remembered per product ID for the session only, so the
  same mouse on the cable, the receiver and Bluetooth starts fresh on each path,
  and two mice on the same path share it;
- the acknowledgement on report `0x06` carries no sequence number. The driver
  assumes it reflects the newest command; the receiver test supports this (it
  reads `06 00` right after a new command, before turning `06 01`), but nothing
  checks it. Over Bluetooth the `0xBC`-`0xBF` echo could, and is not used yet.

## Behaviour observed on hardware

- The Breathe light takes the colour of the active DPI stage. No lighting
  effect has a colour of its own, so the driver offers no lighting colour
  picker. Changing a stage colour is supported by the driver
  (`setDpiStageColor`) but OpenMouse has no control for it yet.

## Scope choices

- Lighting offers Off, Breathing and Static, the XS Flow 2 Speed scheme. A mouse
  named as the XS Natural Plus gets no lighting. The XS Flow Plus's seven
  effects (scheme 3) are in the codec but not offered even when the model is
  named, because they have not been mapped to OpenMouse's effects or checked;
  it gets the three-effect set.
- Lift-off is offered as Low (1 mm) and High (2 mm), the vendor app's two
  choices.
- The bottom mode-switch button is not remappable.
- Macros and factory reset are not wired in. The reset frame exists in the codec
  for completeness; do not use factory reset during initial testing.

## OpenMouse changes needed

Auto sleep appears only when OpenMouse's `src/device/traits.ts` lists the
`amkette-xs` family with `sleep: true` and the driver supplies
`getSleepOptions()` (one to fifteen minutes, in seconds). That entry lives in the
`openmouse` repository and should land in the same release as the package bump.

Nothing else in OpenMouse depends on the family name. The app looks the family
up only in that traits table and for a few other brands' own cards; lift-off,
buttons, the DPI stage editor, lighting and the processing card are shown from
the status fields. Without the entry, only the sleep card is missing. The Ryunix
driver keeps its `ryunix` family and needs no OpenMouse change.
