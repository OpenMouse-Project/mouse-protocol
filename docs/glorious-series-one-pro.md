# Glorious Forge Series One Pro Wireless (`258a:2018` / `258a:2031`)

USB HID configuration and resident Compx nRF52840 bootloader protocol of the **Glorious Forge Series One Pro Wireless** (`FCC ID: 2AXP2-SP22`, PCB `CM2852-BAMF 20220516`).

**Evidence.** "Verified" means observed on one retail mouse and its receiver on firmware v1.0.0.0 (Linux hidraw, mouse wired except in §2.4, 2026-11-12 and 2026-11-13). Bootloader-entry and bootloader packet layouts come from the IL of the official updater `FirmwareUpdate.exe` 1.0.8229.18185 (`C52840Dongle`, SHA-256 `37ae7be701ba36ec987ec86d58b07819834aab0385ac4345138f49e9d9511ea5`); the battery read uses the classic layout already in this module. Code addresses are in the official v1.0.0.0 application images (`CM2856_Mouse_USB_v1.00.00_20220810`, `CM2856_Receiver_USB_v1.00.00_20220810`), read by disassembly. Anything else is marked as not exercised. Full notes and tools: [mouse-firmware-re](https://github.com/0zLloen/mouse-firmware-re/tree/main/devices/glorious-series-one-pro).

---

## 1. USB Identification & HID Interfaces

| Mode | VID:PID | `bcdDevice` | iProduct | Config channel | Evidence |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Wired mouse application** | `258a:2018` | `0x0101` | `Series One PRO Wireless` | Interface 2, usage page `0xFFFF`, usage `0x0000`, 64-byte Feature report, no report ID | Verified (descriptors 91 / 163 / 20 bytes) |
| **2.4 GHz receiver application** | `258a:2031` | `0x0100` | `Series One PRO Wireless` | Same, identical descriptors | Verified (enumeration; relay and local commands in §2.4) |
| **Wired mouse bootloader** | `258a:2103` | not recorded | `Glorious bootloader` | Same 64-byte Feature report channel | Verified |
| **Receiver bootloader** | `258a:2113` | unknown | unknown | presumably the same | PID constant in the updater only |

---

## 2. Application Feature Report Frame Layout (`258a:2018`)

All offsets below (`body[0..63]`) omit the leading report ID byte (`0x00`): `body[n] = bfr[n + 1]`.

### 2.1 Firmware Version Read (`0x00, 0x81`) — verified

- **Request**: `body[2] = 0x00` (target), `body[3] = 0x06` (length), `body[4] = 0x00`, `body[5] = 0x81`. The updater's own `GetFW` sends length `0x03`; that variant was not sent here.
- **Reply** (GET_REPORT after ~25 ms, stock firmware): `a1 00 00 03 00 81 01 00 00 00 20 18`, then zeros to byte 63.
  ```text
  body[0]      = 0xa1 (status OK)
  body[3]      = 0x03 (reply length)
  body[4..5]   = 00 81 (echo)
  body[6..9]   = major, minor, patch, build (01 00 00 00 -> v1.0.0.0)
  body[10..11] = big-endian USB product ID (20 18 -> 0x2018)
  ```
- Sent to the `258a:2031` receiver, `body[2] = 0x02` relays the query to the mouse and `body[2] = 0x00` is answered by the receiver itself (§2.4). Other `body[2]` targets are not exercised.

### 2.2 Battery Status Read (`0x00, 0x83`) — verified wired

- **Request**: `body[2] = target`, `body[3] = 0x02`, `body[4] = 0x00`, `body[5] = 0x83`.
- **Reply**: `a1 00 <target> 02 00 83 00 64`: `body[0]` status (`0xa1` normal, observed; `0xa4` asleep and `0xa0` waking up as for the other classic mice, not observed on this mouse), `body[6]` charging flag, `body[7]` percent. With the cable plugged in it answered `charging = 0`, `100 %` for target `0x00` and for `0x02` (echoed in `body[2]`). Read on a build of v1.0.0.0 carrying the open-directional-dpi patch, which passes these commands to the stock handler unchanged.

### 2.3 Enter Resident USB HID Bootloader — verified

- **Request** (`C52840Dongle::SetBLDeviceMode`, "set device mode" to `0xb0`):
  ```text
  body[2] = 0x00 (deviceID: 0 for the wired mouse, Config.ini [Debug] DeviceID)
  body[3] = 0x01 (length)
  body[4] = 0x00
  body[5] = 0x00 ("set device mode")
  body[6] = 0xb0 (mode: bootloader)
  every other byte 0x00
  ```
- **Behavior**: the mouse resets (the SET_REPORT itself fails with `EPROTO` on Linux) and enumerates as `258a:2103`. Traced in the stock image: `0x14824` compares the mode byte (`body[6]`) with `0xb0` and branches to `0x1484C`, which writes `0xA55AA55A` to `0x2003FFFC` (top word of the 256 KB SRAM) and calls `NVIC_SystemReset()` at `0x71B8`. The bootloader (24 KB at `0x00000000`–`0x00005FFF`, inferred from the image base `0x6000`) has never been read, so how it uses that word is inferred.

### 2.4 Through the 2.4 GHz Receiver (`258a:2031`)

Same Feature report channel. Relay and status behavior verified with the mouse on the receiver (2026-11-13) and matching the receiver's disassembly; rows marked "Disassembly" are read from the receiver image only.

- **Relay**: the receiver forwards a request to the mouse only when `body[2] = 0x02`. It sends `body[3] + 6` bytes over the radio in 8-byte chunks and copies back `body[3] + 6` bytes of the reply, the length the **request** asked for; the rest of the 64 bytes is stale.
- **Status**: `body[0]` reads `0xa0` while the request is pending and `0xa4` when the link is down. `0xa4` can be transient: while the mouse erased a flash page (a profile save on a patched build) the receiver showed `0xa4` at about 270 ms and the real reply arrived at about 770 ms. Poll until a deadline and treat only a final `0xa4` as an unreachable mouse.
- **Receiver-local handlers**: with `body[2] != 0x02`, the receiver runs its own handler only when `body[4] = 0x00`, with the command in `body[5]`. Any other `body[4]` answers `0xa3` with no handler.

| `body[5]` | Receiver-local effect | Evidence |
| :--- | :--- | :--- |
| `0x81` | Receiver firmware version | Verified |
| `0x89` | Link state | Verified |
| `0x8a` | Reads the receiver's RF ID | Disassembly |
| `0x00` | **Dangerous.** Sets the receiver's device mode; `body[6] = 0xb0` writes `0xA55AA55A` to `0x20007FFC` and reboots the receiver into its bootloader (`258a:2113`) | Disassembly |
| `0x0a` | **Dangerous.** Rewrites the stored RF ID, which unpairs the mouse | Disassembly |
| other | `0xa3` and an echo | Disassembly |

The bootloader-entry packet of §2.3 (`body[2] = 0x00`, `body[4] = 0x00`, `body[5] = 0x00`) is therefore not relayed: sent to `258a:2031` it acts on the receiver itself. Writes meant for the mouse must use `body[2] = 0x02`.

---

## 3. Resident Compx USB HID Bootloader Protocol (`258a:2103`)

Every command carries `body[2] = deviceID` (`0x00` for the wired mouse). All five were exercised on the wired mouse, ending in a verified flash of a patched build of the v1.0.0.0 application; the official image was then restored the same way, read back and booted.

| Command | `body[3]` (Len) | `body[4]` | `body[5]` (Cmd) | `body[6..10]` | `body[11..63]` | Behavior / Reply |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **`GetBLFW`** | `0x06` | `0xB0` | `0x80` | `00..` | `00..` | `body[0] = 0xA1`, version at `body[8..11]`: `b0 01 00 00`. |
| **`Erase`** | `0x08` | `0xB0` | `0x01` | `00..` | `00..` | Cleared `0x0001E000` up to at least `0x0004D7FF` but **kept `0x00006000`–`0x0001DFFF`** (the old image, vector table included). It does not reach `0x7E000`: data saved there survived two full flashes. Whether it reaches the `0x88000`+ pairing pages is unknown. Do not rely on it to blank the application. |
| **`Program`** | `len + 5` | `0xB0` | `0x02` | `body[6] = len` (`<= 32`)<br>`body[7..10] = addr` (BE `u32`) | `len` bytes of `data ^ 0x55` | XOR `0x55` on the wire only. **Read-modify-write**: the bytes land exactly as sent (bits can go 0 → 1) and the rest of the 4 KB page is kept, so no prior erase is needed. |
| **`VerifyByAddress`** | `0x20` | `0xB0` | `0x83` | `body[6] = len` (`<= 32`)<br>`body[7..10] = addr` (BE `u32`) | `00..` | `body[0] = 0xA1` and `len` bytes XOR `0x55` at `body[11..]`. Reads succeed for `0x00006000`–`0x0004D7FF`; from `0x0004D800` up the status is `0xA2`, so the pairing/profile pages cannot be read over USB. Addresses below `0x6000` were not tried. |
| **`Exit`** | `0x01` | `0xB0` | `0x04` | `body[6] = 0x01` | `00..` | Boots the application at `0x00006000` (the SET_REPORT fails with `ETIMEDOUT` as the device resets). Any validation it performs is unknown. |

Status byte `body[0]` (the updater's result codes): `0xA1`/`0x02` success, `0xA2` fail (also: address out of the readable range), `0xA3` unknown command, `0xA4` out of range.

The flash order used here: `Erase`, then `Program` `0xFF` over the vector table at `0x6000` and read it back, program and verify the rest of the image, write the vector table last, then `Exit`. The `0xFF` write protects against a half-written vector table only once it has landed. An interruption during or right after `Erase` leaves the old vector table with `0x6000`–`0x1DFFF` intact and the range `Erase` clears (from `0x1E000`) erased, or only partly erased if `Erase` itself was cut short: still a complete image for the stock application (it ends at `0x1CC8F`), a broken one for any old image that reached `0x1E000`. Whether the bootloader boots it, or stays resident when `0x6000` is `0xFF`, is unknown: its code has never been read and an interrupted flash has not been tried.
