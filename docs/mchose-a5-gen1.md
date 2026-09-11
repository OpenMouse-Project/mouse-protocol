# MCHOSE A5 Pro Max first-generation protocol

This driver covers the original A5 Pro Max, not the current M HUB A7 V2
protocol. It uses XVI's 64-byte feature-report protocol.

## Evidence

The vendor's `xvi_models.xlsx` model table names VID `0x2023`, wired PID
`0xF019`, 1K receiver `0xF013`, and 4K receiver `0xF015`. The matching firmware
package contains updaters labelled with the same IDs. Its model row declares
three profiles, six DPI stages, 26,000 DPI, wired rates 125/500/1000 Hz and
receiver rates 125/250/500/1000 Hz. The wired `0xF019` path and 1K receiver
`0xF013` path were exercised on owned retail hardware. The 4K receiver identity
`0xF015` is recognized but is not marked hardware-verified.

Requests are 64-byte feature bodies. Bytes 2-5 are route, payload length,
page and command; command data begins at byte 6. Replies begin with `0xA1` and
echo page and command in bytes 4-5. The implementation was ported from the
standalone A5 Pro Max WebHID driver, where the device path was exercised on
retail hardware.

Do not add vendor binaries, extracted resources, or firmware to this repository.
