# ASUS ROG Gladius II P502 Hardware Testing

## Device

- Model: ASUS ROG Gladius II P502
- Vendor ID: `0x0B05`
- Product ID: `0x1845`
- Usage Page: `0xFF01`
- Usage: `0x0001`
- Connection: Wired USB

## Verified HID interface

The configuration interface was verified through WebHID.

Observed collections included:

- Consumer Control
- Keyboard
- Vendor-defined configuration interface

The configuration interface used by OpenMouse is:

- Usage Page: `0xFF01`
- Usage: `0x0001`
- Input Report ID: `0`
- Output Report ID: `0`
- Report payload size: `64` bytes

## Verified read commands

### Settings

Request:

```text
12 04 00