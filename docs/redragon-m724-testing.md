# Redragon M724 K1NG 1K testing notes

Wired only (`04d9:fc7a`, Holtek). No receiver exists for this model.

## USB shape (usbhid-dump, Linux)

Three interfaces; the config channel is interface 2:

- IF 0: boot mouse (8-byte input)
- IF 1: boot keyboard (macros)
- IF 2: vendor collection `0xFFA0:0x01`, feature reports 2-6, input reports
  7-8. Report 2 declares 15 bytes but answers 8; reports 5-6 declare
  1024/2048 bytes but answer 8.

## Transport (usbmon + RDCfg.exe under Wine, `tshark -i usbmon3`)

- Writes are `SET_FEATURE` ( allure `SET_REPORT Feature`) to interface 2,
  16-byte numbered report 2: `[02 F3 sub profile section ...]`.
- Reads do not exist. RDCfg pushes its whole profile table at startup and
  issues no `GET_REPORT` at all. The driver is therefore write-only; the
  only probe is the `FA FA` marker every `GET_FEATURE` echo carries
  (`[02 08 off 00 00 00 FA FA]`, offset auto-increments per read).
- Malformed writes (e.g. echoing `0x08` as the command byte) STALL
  (`EPIPE`). The command byte must be `0xF3` (write) or `0xF5` (hello).
- RDCfg sends `[02 F5 00 ...]` once per session before any write, and
  closes with `[02 F5 01 ...]` as the last command. A session left open
  hangs the mouse interface until replug (verified by symptom: lone slot
  write without the close froze the mouse; the driver brackets every
  write open/close).

## DPI table (section `0x05`, profile 1)

Subcommands per level 1-5: `0x44 0x4A 0x50 0x56 0x5C` (+6 per level).
Other profiles use other bases and are not decoded yet.
Frame: `[02 F3 sub 00 05 00 00 00 01 x range y range 00 00 00]`
(X == Y; the vendor app keeps the axes linked.)

Wire code vs DPI label (capture + user-confirmed labels):

| level | code | DPI  |
| ----- | ---- | ---- |
| 1     | 0x12 | 800  |
| 1     | 0x1b | 1200 |
| 2     | 0x36 | 2400 |
| 3     | 0x4f | 3500 |
| 4     | 0x7c | 5500 |
| 5     | 0x8c + range 1 | 12400 |

Formula: `code = round(dpi * 9 / 400)`; when `code > 255`, set the range
flag and halve (`12400 -> 279 -> 140`). Decode nominal DPI as
`value * (range ? 2 : 1) * 400 / 9` (sub-1% quantization error).

## Polling rate (section `0x06`, sub `0x32`)

`[02 F3 32 00 06 00 00 00 RR 00 01 00 01 00 00 00]` with `RR = 1000 / Hz`,
mapped by cycling every rate in RDC with Apply (4 sessions, everything
else byte-identical, clicks ascending): 1000->`0x01`, 500->`0x02`,
250->`0x04`, 125->`0x08`. Written in the same bracket + commit envelope
as DPI.

## Live activation (commit block)

Bisected live on hardware with hidraw replays:

- Lone slot write: stored, takes effect at boot only.
- Full 25-slot DPI table, no commit: same, boot only.
- Slots + `02 F3 2C 00 02`: same, boot only.
- Slots + trailing `02 F1 02 04/01/02/08/10` (in order): **applies instantly**.
- Full 86-command vendor replay: applies instantly.

Every vendor session ends with the `F1` block, so the driver sends
`F5 00`, the 5 profile-1 slots, the 5 commit codes, `F5 01` per Apply.
Per-code semantics unknown; the block is sent whole, vendor order.

## Still not decoded

- Buttons (`02 F3 8x/ax/bx/cx 00 04 ...`), LED (`... 04 07 ...`), profile
  select, the 64-byte report-3 command.
- Active DPI stage cannot be read or (yet) written; stage cycling stays on
  the mouse button until the select command is captured.

## Hardware verification status

- [x] `isSupported` shape (`04d9:fc7a` + `0xFFA0:0x01` + feature 2) matches
      the connected mouse (usbhid-dump descriptor).
- [x] `FA FA` echo answers on `/dev/hidraw2` (MI_02).
- [ ] WebHID `readStatus` against the real device (needs a Chrome picker
      click; blocked on manual step).
- [ ] `setDpiStageValue` round-trip felt on hardware (same manual step).
- [ ] Flip `REDRAGON_PRODUCTS` `verified` to `true` after the above pass.
