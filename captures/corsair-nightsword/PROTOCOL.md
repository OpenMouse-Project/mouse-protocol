# Corsair NIGHTSWORD RGB — protocol notes for OpenMouse

**VID/PID:** `0x1B1C` / `0x1B5C`
**Verified on:** firmware 3.41, bootloader 3.08, Windows 11, Chrome WebHID, 2026‑09‑05
**Protocol origin:** ckb-next NXP protocol (`src/daemon/nxp_proto.h`, `dpi.c`, `device_mouse.c`, `firmware.c`), with two corrections found on real hardware (byte order, no ack on SET).

## Interfaces (Windows enumeration)

| Interface | Collections | Role |
|---|---|---|
| `MI_00` | COL01 mouse, COL02 consumer control, COL03–05 vendor-defined | HID input / Corsair key events |
| `MI_01` | one collection, usage page `0xFFC2`, usage `0x04` | **Config channel** |

`MI_01` report descriptor: input 64 B (ID 0), output 64 B (ID 0), feature 64 B (ID 0).

**Picker gotcha:** `MI_00` also carries an `0xFFC2` collection (usage `3`, input report ID 14 only), plus `0xFFC1`/`0xFFC3` vendor collections. A WebHID filter on `usagePage: 0xffc2` alone matches both interfaces and the chooser shows two identical "CORSAIR NIGHTSWORD RGB Gaming Mouse" entries. Filter on `usagePage: 0xffc2, usage: 4`, and have `isSupported()` require a collection with usage 4 that declares a feature report on ID 0.

## Transport — CONFIRMED

- 64-byte packets, report ID 0, zero-padded.
- **Feature reports.** `sendFeatureReport(0, pkt)` to send, then `receiveFeatureReport(0)` to read the reply. Interrupt `sendReport` is accepted but the device does not answer on `inputreport` for this firmware.
- Chrome on Windows returns the feature buffer **without** a report-ID prefix — byte 0 is the command echo.
- ~20 ms between send and receive was sufficient; ckb-next uses 6–10 ms between packets. Serialise all traffic.
- GET replies echo request bytes 0–3; use that as the match check.
- **SET commands produce no reply.** `receiveFeatureReport` after a SET returns the stale buffer from the previous GET. Confirm writes by issuing the corresponding GET.
- iCUE's background service holds `MI_01` open. `open()` still succeeds (shared mode) but every transfer throws `NotAllowedError: Failed to write the feature report`. Stop `Corsair Service` and kill `iCUE*`; the service auto-restarts on device arrival, so `Set-Service "Corsair Service" -StartupType Manual` during development. The driver should surface this error as "close iCUE".
  - **Corrected 2026‑09‑06 (Chrome 152, iCUE app + service running and actively applying its profile).** Probed both granted interfaces from the same page: `sendFeatureReport(0, 0e 13 02 00)` on MI_00 (`0xffc2` usage 3, no feature report) throws exactly `NotAllowedError: Failed to write the feature report.`; the same call on MI_01 (`0xffc2` usage 4, feature 0) returns `0e 13 02 00 02 09 60 09 60` (stage 2, 2400 = iCUE's profile). The OpenMouse driver also completed a 130 s session of successful reads with iCUE up. So the error was the wrong picker entry, not iCUE holding the interface; iCUE and a WebHID reader coexist in shared mode. The `usagePage: 0xffc2, usage: 4` filter prevents the wrong interface from being selected. The driver keeps the "close iCUE" mapping only as a fallback for a real `NotAllowedError`.

## Packet layout

```
byte 0  command   0x0e = GET, 0x07 = SET
byte 1  field
byte 2  subcommand (for FIELD_MOUSE 0x13)
byte 3  profile flag — see below
byte 4+ payload
```

### Profile flag (byte 3) — CONFIRMED

| Value | Meaning | Result on Nightsword fw 3.41 |
|---|---|---|
| `0` | live / software settings | **populated** — use this |
| `1` | stored hardware profile | returns zeros for DPI fields; ckb-next disables hwload for this device (file-based profile format, field `0x17` + bulk `0xff`, not implemented here) |

**Persistence — CONFIRMED:** writes with byte 3 = 0 are volatile. After unplug/replug the mouse boots from its onboard profile and live changes are gone (stage 1 set to 1000 → read back 1500 after replug). iCUE re-applies its software profile on every connect, which is why settings appear to persist with iCUE running. Persisting to onboard memory requires the file-based profile format (out of scope for phase 1/2).

Fields used:

| Field | Value | R/W |
|---|---|---|
| `FIELD_IDENT` | `0x01` | R |
| `FIELD_POLLRATE` | `0x0a` | W |
| `FIELD_MOUSE` | `0x13` | R/W (subcommand) |
| `FIELD_M_PROFID` | `0x15` | R/W |
| `FIELD_M_PROFNM` | `0x16` | R/W, UTF‑16LE |

`FIELD_MOUSE` subcommands:

| Sub | Value | Meaning |
|---|---|---|
| `MOUSE_DPI` | `0x02` | current DPI stage index (+ current X/Y in reply) |
| `MOUSE_LIFT` | `0x03` | lift-off height |
| `MOUSE_SNAP` | `0x04` | angle snap (0/1) |
| `MOUSE_DPIMASK` | `0x05` | enabled-stage bitmask |
| `MOUSE_DPIPROF` | `0xd0 \| stage` | per-stage DPI X/Y + RGB |

**Stage count:** 6 slots (`d0`–`d5`). Observed mask `0x0f` = 4 enabled.

**Slot meaning — CONFIRMED against the iCUE DPI panel (2026‑09‑06):** `d0` is the **Sniper** stage (held-button DPI; iCUE indicator colour yellow `ff ff 00`), and iCUE's numbered *Stage 1/2/3* are `d1`/`d2`/`d3` (indicator cyan `00 bf ff`). `MOUSE_DPI` byte 4 is the slot index, so "current stage 2" = iCUE Stage 2. Factory profile colours for `d1`/`d2` are `00 bf ff` (read live via the OpenMouse diagnostics log).

## Byte order — CONFIRMED (asymmetric)

- **GET replies present DPI X/Y big-endian**: `03 20` = 800, `09 60` = 2400, `16 44` = 5700.
- **SET takes DPI X/Y little-endian**: writing `20 03` stores 800 (reads back `03 20`); writing `06 40` stores 0x4006 = 16390 (reads back `40 06`).
- ckb-next encodes SET LE (correct) and decodes GET LE (wrong for this firmware). Parse reads BE, write LE.
- **A `MOUSE_DPIPROF` write without bytes 9–11 zeroes the stage colour.** Always read the stage first and write RGB back, or require RGB in the API.

Identity fields (`FIELD_IDENT`) are little-endian (`41 03` = 0x0341, `1c 1b` = 0x1B1C) — confirmed.

## Read-only commands — CONFIRMED

### Identify / firmware / poll rate
```
TX: 0e 01 00
RX: 0e 01 00 00 01 01 00 01 | @8 fw u16 LE | @10 bl u16 LE | @12 VID u16 LE | @14 PID u16 LE | @16 poll ms
Observed: fw 0x0341, bl 0x0308, VID 0x1b1c, PID 0x1b5c, poll 1 (=1000 Hz)
Bytes 39 and 46 changed between sessions (02/55 → 01/aa) — likely profile/stage status; not decoded.
```

### DPI / sensor state (byte 3 = 0)
```
TX: 0e 13 05 00        RX byte 4 = enabled bitmask            (obs: 0f)
TX: 0e 13 02 00        RX byte 4 = current stage, @5 X u16 BE, @7 Y u16 BE   (obs: 02, 2400, 2400)
TX: 0e 13 03 00        RX byte 4 = lift height                (obs: 05)
TX: 0e 13 04 00        RX byte 4 = angle snap                 (obs: 00)
TX: 0e 13 (d0|n) 00    RX @5 X u16 BE, @7 Y u16 BE, @9 R, @10 G, @11 B
Observed (iCUE-loaded live profile): 0=400 (ff ff 00), 1=800 (00 bf ff), 2=2400 (00 bf ff), 3=5700 (00 bf ff), 4–5 zero, stage 2 active
Observed (factory onboard profile, after replug with iCUE stopped): 0=800 (ff ff 00), 1=1500, 2=3000, 3=6000 (00 bf ff), 4–5 zero, mask 0f, lift 5, snap 0, stage 1 active
```

### Profile ID
```
TX: 0e 15 01
RX: 0e 15 00 00 5c 1b 00 00 02 00 … @20 01   (contents not yet interpreted)
```

## Write commands (phase 2)

```
Select stage:      07 13 02 00 <stage>                  CONFIRMED live (cursor speed changes)
Enabled mask:      07 13 05 00 <mask>
Stage values:      07 13 (d0|n) 00 <xyIndependent 0/1> <xLo> <xHi> <yLo> <yHi> <r> <g> <b>   (LE; RGB required)
Lift height:       07 13 03 00 <height>                 CONFIRMED, 1–5 all accepted
Angle snap:        07 13 04 00 <0/1> [05]               CONFIRMED with and without the trailing 0x05
Poll rate:         07 0a 00 00 <interval ms: 1|2|4|8>
```

No reply on SET; read back with GET to confirm. Byte 3 = 0 writes are live/non-persistent (survive until power cycle at most). Persisting to the hardware profile uses the file-based format and is out of scope.

### Write probe — 2026‑09‑06, iCUE app + service running

Run from the OpenMouse origin in Chrome 152 against the usage‑4 interface (`write-probe.txt` has the raw log):

- `07 13 02 00 01` → `0e 13 02 00 01 03 20 03 20`: slot 1 (800) selected, cursor noticeably slower for the 10 s hold; iCUE did not override it in that window. `07 13 02 00 02` restored slot 2 (2400).
- `07 13 04 00 01 05` → snap reads `01`; `07 13 04 00 00` (no trailing byte) → reads `00`. The ckb-next trailing `0x05` is harmless and not required.
- `07 13 03 00 h` for h = 1…5 → each reads back as written. Mapping of raw height to iCUE's Surface Calibration lift-off labels still to be recorded.

**Poll-rate caveat:** ckb-next notes the device re-enumerates after `FIELD_POLLRATE`; the driver must handle the WebHID device closing and reconnect.

## Still to confirm

1. ~~Whether `07 13 02 00 <n>` switches stage live~~ — confirmed 2026‑09‑06.
2. Raw lift height (1–5) → iCUE Surface Calibration lift-off label mapping.
3. ~~`MOUSE_SNAP` trailing `0x05` byte~~ — confirmed optional 2026‑09‑06.
4. Poll-rate write and reconnect behaviour.
5. Profile-ID reply layout (optional).
6. `MOUSE_DPIMASK` and `MOUSE_DPIPROF` writes (encoded and unit-tested, not yet sent to hardware).

A USBPcap capture of iCUE is now only needed if any of the above misbehave, or for phase 3 (hardware-profile persistence via `0x17` / `0xff`).

## WebHID probe (working)

```js
const [d] = await navigator.hid.requestDevice({ filters: [{ vendorId: 0x1b1c, productId: 0x1b5c, usagePage: 0xffc2, usage: 4 }] });
// or from getDevices(): pick the one whose collection is usagePage 0xffc2, usage 4, with a feature report
await d.open();
const hex = b => Array.from(b).map(x => x.toString(16).padStart(2,'0')).join(' ');
async function q(...bytes) {
  const p = new Uint8Array(64); p.set(bytes);
  await d.sendFeatureReport(0, p);
  await new Promise(r => setTimeout(r, 20));
  return new Uint8Array((await d.receiveFeatureReport(0)).buffer);
}
console.log(hex(await q(0x0e,0x01)));           // ident
console.log(hex(await q(0x0e,0x13,0x02,0)));    // current stage + dpi
```

## mouse-protocol codec sketch (feature-report transport, BE DPI)

```ts
const MSG = 64;
const CMD_GET = 0x0e, CMD_SET = 0x07;
const F_IDENT = 0x01, F_POLL = 0x0a, F_MOUSE = 0x13;
const M_DPI = 0x02, M_LIFT = 0x03, M_SNAP = 0x04, M_MASK = 0x05, M_PROF = 0xd0;
const LIVE = 0; // byte 3: live/software settings

const pkt = (...b: number[]) => { const p = new Uint8Array(MSG); p.set(b); return p; };
const u16le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const u16be = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];

export const encode = {
  ident:       ()          => pkt(CMD_GET, F_IDENT, 0),
  dpiMask:     ()          => pkt(CMD_GET, F_MOUSE, M_MASK, LIVE),
  dpiStage:    ()          => pkt(CMD_GET, F_MOUSE, M_DPI, LIVE),
  lift:        ()          => pkt(CMD_GET, F_MOUSE, M_LIFT, LIVE),
  snap:        ()          => pkt(CMD_GET, F_MOUSE, M_SNAP, LIVE),
  stage:       (n: number) => pkt(CMD_GET, F_MOUSE, M_PROF | n, LIVE),
  setStage:    (n: number) => pkt(CMD_SET, F_MOUSE, M_DPI, LIVE, n),
  // SET is little-endian; RGB must be supplied or the stage colour is cleared.
  setStageDpi: (n: number, x: number, y: number, rgb: readonly [number, number, number]) =>
    pkt(CMD_SET, F_MOUSE, M_PROF | n, LIVE, x !== y ? 1 : 0, x & 0xff, x >> 8, y & 0xff, y >> 8, ...rgb),
  setPollMs:   (ms: 1|2|4|8) => pkt(CMD_SET, F_POLL, 0, 0, ms),
};

export const decode = {
  isEcho: (req: Uint8Array, r: Uint8Array) =>
    r[0] === req[0] && r[1] === req[1] && r[2] === req[2] && r[3] === req[3],
  ident: (r: Uint8Array) => ({
    fw: u16le(r, 8), bootloader: u16le(r, 10),
    vid: u16le(r, 12), pid: u16le(r, 14), pollMs: r[16],
  }),
  byte4: (r: Uint8Array) => r[4],
  dpiStage: (r: Uint8Array) => ({ stage: r[4], x: u16be(r, 5), y: u16be(r, 7) }),
  stage: (r: Uint8Array) => ({
    x: u16be(r, 5), y: u16be(r, 7), rgb: [r[9], r[10], r[11]] as const,
  }),
};

// Transport contract for the client: GET = sendFeatureReport → delay → receiveFeatureReport,
// verify decode.isEcho; SET = sendFeatureReport only (no reply), then GET to confirm.
```
