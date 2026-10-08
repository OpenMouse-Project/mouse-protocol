# Diamondback Chroma individual LED lighting

Scope: `1532:004c`, wired USB. Existing DPI, polling, whole-mouse effects and
global brightness stay on their existing paths. No OpenMouse Bridge changes
are required: both writes use the driver's existing feature report 0 transport.
Button remapping and macros are outside this change.

## Protocol evidence

- [OpenRazer's mouse catalog](https://github.com/openrazer/openrazer/blob/master/daemon/openrazer_daemon/hardware/mouse.py)
  describes the Diamondback as a 1 x 21 matrix.
- [OpenRazer's mouse driver](https://github.com/openrazer/openrazer/blob/master/driver/razermouse_driver.c)
  dispatches this product's custom frame to
  `razer_chroma_misc_one_row_set_custom_frame`, on transaction id `0xff`.
- [OpenRazer's Chroma codecs](https://github.com/openrazer/openrazer/blob/master/driver/razerchromacommon.c)
  define the single-row write as class `0x03`, command `0x0c`, fixed data size
  `0x32`, inclusive start/end columns followed by RGB bytes. Custom activation
  is class `0x03`, command `0x0a`, data size `0x02`, arguments `[0x05, 0x00]`.

These facts are transcribed from the upstream sources, not inferred from other
Razer models. The new writes have automated coverage, but have not yet been
verified on a physical Diamondback by this project.

## Behavior

The status exposes the existing Mouse effects zone followed by LED 0 through
LED 20. LED numbers are protocol columns, not a claimed physical left-to-right
layout. The existing OpenMouse lighting strip renders them without a new UI.

Choosing Static or Off writes only the selected cell, then activates the
volatile custom frame if it is not already active. This preserves untouched
cells in the mouse's frame buffer; their initial colors cannot be read back.
Off writes black to that LED. Brightness is global and remains on the Mouse
zone. A built-in Mouse effect overrides the visible custom colors; the driver
then clears the LED modes it reports. The next LED write activates custom again.

Colors and effect state are write-only. On connection the LED modes are unknown.
The cache records a cell only after both upload and activation succeed. This
does not promise persistence after an unplug, or synchronize with other RGB
software editing the same mouse.

## Hardware validation for the ticket reporter

Use the current Bridge build already confirmed to connect this mouse, and quit
Synapse and OpenRGB so they do not replace the test colors.

1. Record the firmware, DPI, polling rate and brightness before testing.
2. In Lighting, choose LED 0, set Static red and apply. Record the physical LED
   that changes and any error. The rest of the frame should not be repainted.
3. Repeat with LED 1 in green and LED 20 in blue; confirm earlier cells keep
   their colors, and record the physical positions.
4. Set LED 1 to Off; verify only that cell goes dark.
5. On Mouse choose Spectrum; verify the whole-mouse effect returns. Pick LED 0
   and apply Static again; verify custom colors can be resumed.
6. On Mouse choose Static and change global brightness. Confirm its read-back.
7. Reload and unplug/replug separately. Unknown LED modes after a new client
   connection are expected; note what the actual hardware retains.
8. Confirm DPI and polling still work. Attach the hardware-test JSON and console
   errors, if any, and the observed LED index-to-position map.

The Mamba Elite is deliberately not enabled: its custom-frame protocol is a
different extended-matrix family, and this change supplies no evidence for it.
