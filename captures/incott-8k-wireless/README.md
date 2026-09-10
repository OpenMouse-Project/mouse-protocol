# Incott 8K wireless mouse fixtures

Hardware-verified reference material for `src/incott/` and
`src/drivers/incott/`. Everything here was captured from an "incott 8K
wireless mouse" (VID `0x093A`, PID `0x522C`, manufacturer string "Pixart
Imaging, Inc.") over its `0xFF05` vendor collection, using node-hid.

Three capture sessions now exist, at increasing trust:
1. **2026-09-07, read-only node-hid probes** (`targeted-reads.hex`,
   `query-sweep-0x80-0x8f.hex`, `repeatability.hex`, `device-enumeration.txt`)
   — no write was ever sent.
2. **2026-09-07, vendor-tool session** (`vendor-tool-session.hex`) — the
   vendor's own WebHID configurator talking to a second unit (a G23V2Pro).
3. **2026-09-08, write round-trip session** (`write-roundtrip.hex`) — node-hid
   directly against hardware again, but this time performing real writes,
   reading each one back, and restoring the original value afterwards. This
   is the only session that confirms a write took effect rather than only
   confirming that a query answers.

| File | What it is |
|---|---|
| `write-roundtrip.hex` | **Highest-trust file here: real writes, read back, then restored.** Fixes the DPI stage-index write bug (byte 1 of the `0x02` write is a stage index 0-5, not a hardcoded constant), confirms `0x82` is the per-stage DPI value read, confirms the `0x81` polling-rate byte by watching it follow a write, cross-checks lift-off and motion sync's packed-byte-7 reads against their symmetric single-purpose reads, and adds a button-binding round-trip (new capability). |
| `vendor-tool-session.hex` | **Ground truth for DPI and battery on a G23V2Pro.** Captured by instrumenting Incott's own WebHID configurator at incott.net/mouse/ (not a raw node-hid probe like the files below). Disproves the DPI-preset-index and 0x89-battery-byte assumptions this driver inherited from IncottHIDApp; also confirms lift-off, receiver LED, sleep and identity writes/reads, and records the unverified performance-mode writes. |
| `targeted-reads.hex` | Replies to the specific queries the driver issues: `09 89` (status — NOT battery, see above), `09 84 00/02/03` (sensor: lift-off+motion sync, ripple, angle snap), `09 85 01/03` (timing: debounce, sleep), `09 88` (receiver LED). |
| `query-sweep-0x80-0x8f.hex` | Replies to every opcode `0x80`-`0x8F` sent with no sub-command, to map out which commands answer at all. `0x80`, `0x87`, and `0x8a`-`0x8e` never answered THIS WAY — `0x8e` in particular only answers sub-command `0x01`, not `0x00`; see `vendor-tool-session.hex`. This is also why `0x82`'s DPI stage table and `0x86`'s buttons were missed here: they only ever answer on a non-zero sub-command, and this sweep only ever tried `0x00`. |
| `device-enumeration.txt` | The device's 8 HID collections (wireless, 0x522C) and which interface carries the vendor protocol. |
| `wired-device-enumeration.txt` | **2026-09-08, wired (0x622C).** Interface 2 exposes TWO `0xFF05` collections, indistinguishable by vendor/product id or usage page — only one answers feature reports, the other fails `HidD_SetFeature` outright. Also captures the wired product string, "incott Esports G23V2Pro mouse" — the real model name, absent from the wireless dongle's generic string. This is the capture behind the wired-mode fix in `incottProbeCollection`/`incottSelectCollection` (`src/drivers/incott/hid.ts`). |
| `repeatability.hex` | The same query returned three different payloads across three separate runs — the finding that shaped the driver's entire transaction discipline. |

## The single most important protocol fact

Repeating the *same* query (`09 84 00`) returned *different* payloads across
runs, with nothing else changed:

```
run A:   09 84 00 04 00 0f 0f 01
run B:   09 84 00 0e 00 f1 00 00
sweep:   09 84 00 01 00 00 00 00
```

The device latches a single shared response buffer. A read issued too early,
or issued right after a *different* query, can hand back a frame that
belongs to that earlier query rather than the one just sent. This is why
`IncottTransactionQueue` (`src/drivers/incott/hid.ts`) serializes every
request, discards whatever is already latched before sending, and only
accepts a reply whose report ID, command byte, and — for `0x83`/`0x84`/`0x85`
only — sub-command byte all echo the request. See `repeatability.hex` for the
full detail and `src/incott/index.ts`'s `incottFrameMatches()` for the check
itself.

The sub-command echo is matched **only** for `0x83`/`0x84`/`0x85`. For
`0x81`/`0x88`/`0x89`/`0x8f`, byte 2 of the reply is *data*, not an echoed
sub-command — matching it there would reject every polling rate but 1000 Hz
and every LED mode but 0.

## What is confirmed vs. unconfirmed

Confirmed by these captures:
- `0x81` answers the polling-rate query; `0x83`/`0x06` answers the DPI query.
- `0x84` (sensor) sub `0x00` carries lift-off + motion sync, `0x02` ripple
  control, `0x03` angle snap.
- `0x85` (timing) sub `0x01` carries debounce, `0x03` carries sleep.
- `0x88` and `0x89` answer (receiver LED, status/battery).
- `0x8f` answers with an identity payload whose byte layout is not decoded.
- `0x80`, `0x87`, and `0x8a`-`0x8e` never answer on this hardware.

Not confirmed — see `docs/incott-testing.md` for the full list of open
questions this capture session did not resolve, including which byte of the
`0x81` reply actually carries the polling rate, whether `0x89` byte 8 is
really a battery percentage, and what `0x82`/`0x86` mean.

## Attribution

The command and opcode set these captures exercise was derived from the
MIT-licensed [IncottHIDApp](https://github.com/romkazor/IncottHIDApp)
(`device.go`). These captures are original data taken directly from hardware,
not reproduced from that project.
