# Redragon M690 PRO (`258a:002e` / `258a:002f`) captures

Vendor-channel traffic between the official Redragon M690-PRO app (v1.0,
`Redragon_M690-PRO_Setup_v1.0_20221125`, OemDrv-based) and three units
(mouse firmware 2.95 and 2.97, receiver firmware 6.05), captured with
USBPcap on Windows and exported to text: HID feature reports 5 and 8,
report-7 events, keyboard reports from bound keys, and report descriptors only. The mouse reports no serial
number, so the files carry no unit identifier.

| File | What it is |
| --- | --- |
| `report-descriptors.hex` | Interface 0 (mouse) and interface 1 (keyboard, consumer, vendor) report descriptors. |
| `app-startup-cable-fw295.hex` | App startup over the cable, firmware 2.95. |
| `app-startup-cable-fw297.hex` | The same on firmware 2.97. |
| `app-startup-receiver.hex` | App startup through the receiver (bank `0x21`/`0x22`) and its battery polls. |
| `app-startup-receiver-factory.hex` | App startup through the receiver of a factory-fresh unit: factory settings, identify zeros until the mouse links. |
| `polling-125-to-500-cable.hex` | One polling write, the reference for the block-write format. |
| `dpi-stage-edits-cable.hex` | DPI 250 / 3000 / 8000 on each stage. |
| `dpi-colours-cable.hex` | DPI indicator colours for all five stages, then every stage selected. |
| `lighting-edits-cable.hex` | Steady, Breathing and Colorful Streaming edits. |
| `button-remaps-cable.hex` | Button 8 and wheel-click reassignments. |
| `keyboard-keys-receiver.hex` | Keyboard keys bound to a button through the receiver, each followed by the keyboard report the mouse sent on press. |
| `macro-assign-cable.hex` | Macro store and a macro slot (documented only; the driver does not write macros). |
| `receiver-polling-and-standby.hex` | Receiver writes 125 -> 250 -> 125 Hz, app opened with the mouse off. |
| `receiver-offline-apply.hex` | Link check `05 80` with the mouse off (`00`) and on (`01`). |
| `openmouse-receiver-session.hex` | This driver in OpenMouse through the receiver: a write made with the mouse off is undone when it reconnects; DPI events; 500 / 1000 Hz writes. |
| `cable-charge-state.hex` | `05 90` over the cable: `10 01` while charging, `10 02` once charged. |
| `bridge-receiver-session.hex` | This driver in OpenMouse through OpenMouse Bridge: link and battery status readable, writes held back while the mouse is asleep. |
| `openmouse-hardware-test-wired.json` | OpenMouse's built-in hardware test, cable, Chrome: pass. |
| `openmouse-hardware-test-wireless.json` | The same through the receiver, Chrome: pass. |
| `openmouse-hardware-test-bridge-wired.json` | Cable through OpenMouse Bridge: pass, with charging status. |
| `openmouse-hardware-test-bridge-wireless.json` | Receiver through OpenMouse Bridge: pass, with battery (99 %). |
| `chrome-report5-stall.hex` | Chrome's feature reads (wLength 520) STALLed by the mouse: why battery and link status cannot be read in a browser. |
| `dpi-button-events.hex` | Report 7 events from the mouse's own DPI buttons. |

In the `.hex` files each line is `SET` (host to mouse), `GET` (mouse to host)
or `EVT` (interrupt-IN), then the report bytes with the report id first and
trailing zeros dropped (`chrome-report5-stall.hex` lists setup packets and USB
status instead). Every read is selected by `SET 05 <command>` and answered
with that command in the reply's second byte, so the `SET` is shown only when
no answer arrives. Lines are in capture order, without timestamps; a `# --`
comment marks where timing matters. Each settings or button block is shown in
full once per file; later copies give the first four bytes, `..`, then only the
bytes that changed since the previous copy as `[offset] old -> new`
(`unchanged` or `identical to the write` when none did; the `a5` ending a
button-block write at `0x58` is not listed). Repeated reads, repeated answers
and key releases are omitted; battery polls appear only in the startup,
charge and Bridge files, and the identify answer only in the startup files.

Decoding and verification notes: `docs/redragon-m690-pro-testing.md`.
