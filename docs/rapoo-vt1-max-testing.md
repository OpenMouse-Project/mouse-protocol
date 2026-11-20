# Rapoo VT1 MAX: identification only

Rapoo's [Web Hub](https://hub.rapoo.com/) international
[driver bundle](https://hwsoft.rapoo.com/webdriver/AHUB_WEB/dist/assets/js/index-Bc6MfG2Y.js)
lists `VT1 MAX`, vendor `0x24ae`, product IDs `0x4644` and `0x1444`,
and configuration collection `0xff00:0x0002`. It names the driver
`VT_nrf54L` and the controller `N54L15`. The
[product page](https://www.rapoo.com/en/product/VT1-Max-Dual-8K) likewise
identifies an N54L15 and wired and wireless operation. The manifest itself
does not identify which PID belongs to which connection.

The existing VT9 Pro driver uses a different collection and report scheme.
Do not route these IDs to that driver. A community
[Nordic protocol investigation](https://github.com/pedro3z0/rapoo-software-linux/blob/main/docs/PROTOCOL.md)
describes reports 6, 7 and 8 for other hardware, but that is not a capture of
this VT1 MAX. The registry therefore identifies the manifest's collection
only; it does not send reports, read battery or offer settings.

## What is needed

Confirm the exact model and USB IDs on the user's actual mouse, separately for
the receiver and cable. On Windows, disconnect the cable and inspect the
receiver's **Hardware Ids** in Device Manager under device Properties >
Details; then unplug the receiver, connect the mouse by cable, and repeat.
Share the `VID_....&PID_....` values only, not serial numbers.

For functional support, capture and sanitize the HID descriptors and
configuration traffic for each connection, together with the corresponding
values shown in Rapoo's official tool. Start with read-only operations; verify
each write and read-back on hardware before enabling settings. Avoid firmware
and pairing operations. Do not commit proprietary binaries, serial numbers,
or personal data from captures.

The identification path has not been tested with a VT1 MAX, either on Windows
or macOS. A protocol package change alone does not update the deployed
OpenMouse website; integration, upstream acceptance and deployment are needed.
