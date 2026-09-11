# Dareu A950 PRO Mg Jm protocol

This driver covers the Dareu A950 PRO Mg (`TM271F`) and its `TM265Dongle`
2.4 GHz receiver. It does not claim other Jm-family mice.

## Evidence and hardware verification

Dareu's All in One WebHID panel identifies mouse PID `0x1117` and receiver
PID `0x1114`. The connected retail receiver reported VID `0x260D`, a service
collection `0xFF05:0`, and a `0xFF02:2` command collection with 16-byte
input/output report ID `8`.

The receiver path (`260D:1114`) was exercised on hardware for status reads and
read-back-verified DPI, polling, DPI-indicator, and sleep writes. The wired
PID is recognized only when it exposes that same measured command shape; it
has not yet been hardware-verified.

## Packet and memory format

Jm commands are 16-byte bodies sent with report ID `8`. The final byte is the
vendor checksum over the body plus report ID. Command `8` reads at most ten
memory bytes; command `7` writes at most ten bytes and is acknowledged before
the next write. Read replies must echo the requested address and length.

The vendor panel's documented configuration records are used for polling,
legacy DPI stages, button assignments, DPI-indicator state, and mouse/DPI LED
sleep values. Every supported write reads the record first, writes only its
owned bytes, then reads the value back. Unknown or macro button records remain
read-only.

Firmware, reset, calibration, pairing, and macro-write commands are not sent.
Do not add vendor binaries, extracted resources, or firmware to this repository.
