/**
 * Incott HID protocol — transport-independent codec.
 *
 * Derived from IncottHIDApp (`romkazor/IncottHIDApp`, MIT licensed; this
 * module reuses its protocol knowledge, not its code) and verified against
 * an "incott 8K wireless mouse" (093A:522C) on real hardware. Ported from
 * IncottHub (https://github.com/vladidraganov/IncottHub), which documents the
 * verification in `docs/superpowers/specs/2026-09-07-incotthub-design.md`
 * sections 4, 5, 8 and 13.
 *
 * DPI and battery were corrected on 2026-09-07 against a second, higher-trust
 * source: the owner instrumented Incott's own WebHID configurator
 * (incott.net/mouse/, hooking HIDDevice.prototype.sendFeatureReport /
 * receiveFeatureReport) and captured real traffic to a G23V2Pro. That capture
 * is ground truth and disproved two assumptions this driver inherited from
 * IncottHIDApp — see `captures/incott-8k-wireless/vendor-tool-session.hex`
 * and `docs/incott-testing.md`.
 *
 * A THIRD round of verification on 2026-09-08 used node-hid directly against
 * an "incott 8K wireless mouse" and, uniquely among the capture sessions
 * above, performed real WRITES and read every one back before restoring the
 * original value. It fixed the DPI stage-index write bug (see
 * `INCOTT_DPI_STAGE_COUNT`), confirmed `0x82` is the per-stage DPI value read
 * and that it echoes its sub-command, confirmed the polling-rate byte at
 * `0x81`, confirmed the packed byte-7 nibble reads for lift-off and motion
 * sync agree with their symmetric `0x84` single-purpose reads, and added a
 * button-binding codec. See
 * `captures/incott-8k-wireless/write-roundtrip.hex` and
 * `docs/incott-testing.md`.
 *
 * A FIFTH round, 2026-09-08, RELOCATED battery entirely. Charging a unit
 * through a full cycle (roughly 60% to roughly 97%) while polling the
 * `0x8e`/sub `0x01` feature-report reply showed byte 6 never move at all —
 * the exact frame `09 8e 01 5a 04 84 38 01` the entire time. A constant is
 * not a battery reading; see `INCOTT_CMD_QUERY_BATTERY` and
 * `incottDecodeBattery` for what this disproves and why the codec is kept
 * anyway (regression coverage), and `docs/incott-testing.md` for the write-up.
 * The real level lives in an UNSOLICITED INPUT report the mouse emits on
 * report id 0x09 while it is actively being used — not a feature-report
 * reply to any request this driver sends. See `incottDecodeInputStatus` for
 * the codec and `src/drivers/incott/hid.ts`'s `onInputReport` for how the
 * WebHID client listens for it and caches the result.
 *
 * A FOURTH fix, same day, closed a second DPI bug found by an owner report:
 * `IncottHidClient.setDpi` was reading the active stage and then writing the
 * requested DPI *into* that stage, silently overwriting whatever value the
 * stage held — repeated use progressively destroyed the mouse's factory
 * table (one owner's stage 2 was found changed from 1600 to 800 this way).
 * DPI is genuinely four independent operations, not one: select the active
 * stage (`INCOTT_CMD_SET_DPI_STAGE`/`incottEncodeSetActiveDpiStage`, `09 03
 * 06 <idx>`), edit a stage's value (`INCOTT_CMD_SET_DPI`/`incottEncodeSetDpi`,
 * `09 02 <idx> <lo> <hi>`), read which stage is active
 * (`INCOTT_CMD_QUERY_DPI_STAGE`, `09 83 06`), and read a stage's value
 * (`INCOTT_CMD_QUERY_DPI_STAGE_VALUE`, `09 82 <idx>`). Select and edit were
 * verified as genuinely distinct operations: selecting stages 0, 3, 5, then 1
 * in turn each read back correctly via `0x83`/`0x06`, and reading all six
 * stages via `0x82` before and after showed the table's contents completely
 * unchanged by those selects. See `INCOTT_CMD_SET_DPI_STAGE` for the full
 * writeup, `src/drivers/incott/hid.ts` for how the driver now exposes
 * `setActiveDpiStage`/`setDpiStageValue` as OpenMouse's existing generic
 * multi-stage DPI editor contract, and
 * `captures/incott-8k-wireless/write-roundtrip.hex` /
 * `docs/incott-testing.md` for the capture.
 *
 * All traffic is HID feature reports on report ID 0x09. Requests are 9 bytes
 * `[0x09, cmd, sub, ...args]`; WebHID's `sendFeatureReport` takes the report
 * ID as a separate argument, so the payloads this module builds are 8 bytes
 * and omit it. Responses are read with `receiveFeatureReport(0x09)`, which
 * returns the report ID at byte 0, so decoders index frames that include it.
 *
 * Opcodes are paired: `0x0N` sets a value, `0x8N` queries it. The device
 * latches a single shared response buffer — see `incottFrameMatches` and
 * `src/drivers/incott/hid.ts` for how the driver layer avoids decoding a
 * frame left over from a previous query.
 *
 * A SIXTH round, 2026-09-10, instrumented Incott's own web configurator again,
 * this time with every click LABELLED, settling the performance-mode
 * value-to-label mapping left open by the 2026-09-07 capture: HP=2, Corded=1,
 * LP=0 — the REVERSE of the vendor UI's own left-to-right display order. See
 * `INCOTT_SUB_PERFORMANCE` for the labelled capture,
 * `INCOTT_PERFORMANCE_MODE_TO_WIRE`/`incottPerformanceModeToWire` for the
 * table it lives in, and `src/drivers/incott/hid.ts`'s `setPowerMode`/
 * `getPowerModes` for where it is now wired into OpenMouse's shared
 * `powerMode`/`powerModes` contract. The same session also verified the
 * receiver LED labels (previously prior art, now confirmed — see
 * `INCOTT_RECEIVER_LED_MODES`), found a DPI-write axis byte at payload index
 * 7 (see `incottEncodeSetDpi`), and established that onboard profiles are a
 * vendor-software construct with no on-device select command. See
 * `docs/incott-testing.md` and
 * `captures/incott-8k-wireless/vendor-tool-session-2026-09-10.hex`.
 *
 * This module must not import WebHID types or talk to a device; see
 * `src/drivers/incott/hid.ts` for the WebHID client.
 */

export const INCOTT_VENDOR_ID = 0x093a;
/** The 2.4 GHz dongle's product id — "incott 8K wireless mouse" in its product string. */
export const INCOTT_PRODUCT_ID = 0x522c;
/**
 * The WIRED product id — hardware-verified 2026-09-08 by plugging the mouse
 * in over USB and reading `device.productId` directly: it enumerates as
 * `0x622C`, not `0x522C`. This used to be named `INCOTT_PRODUCT_ID_CHARGING`
 * and `incottIsChargingProduct` treated it as a charging FLAG — that was the
 * wrong axis. `0x622C` means the CONNECTION is wired; charging is a
 * consequence of being plugged in, not the thing this id actually encodes.
 * See `incottIsWiredProduct` (the renamed helper) and
 * `IncottHidClient.readStatus`, which now derives both `connectionType` and
 * `batteryState: "Charging"` from wired-ness rather than from a constant
 * that claimed to mean "charging."
 */
export const INCOTT_PRODUCT_ID_WIRED = 0x622c;
export const INCOTT_PRODUCT_IDS: readonly number[] = [
  INCOTT_PRODUCT_ID,
  INCOTT_PRODUCT_ID_WIRED,
];

/** The vendor collection that answers protocol requests. */
export const INCOTT_USAGE_PAGE = 0xff05;
/** Any vendor-defined page, used as a fallback when 0xFF05 is absent. */
export const INCOTT_VENDOR_USAGE_PAGE_MIN = 0xff00;

export const INCOTT_REPORT_ID = 0x09;
/** Payload length excluding the report ID (WebHID sends it separately). */
export const INCOTT_PAYLOAD_LENGTH = 8;
/** Length requested from receiveFeatureReport, including the report ID. */
export const INCOTT_RESPONSE_LENGTH = 64;

/** Set opcodes. Query opcodes are the same value with bit 7 set. */
export const INCOTT_CMD_SET_POLLING = 0x01;
/**
 * Writes the actual DPI value (see `incottEncodeSetDpi`), NOT a preset index.
 * Proven on hardware 2026-09-07 against a real G23V2Pro; this used to be
 * `0x03`, which was never verified and is not what the vendor tool sends.
 */
export const INCOTT_CMD_SET_DPI = 0x02;
export const INCOTT_CMD_SET_SENSOR = 0x04;
export const INCOTT_CMD_SET_TIMING = 0x05;
/**
 * Button binding write, `09 06 <button 0..5> <...payload>` — round-trip
 * confirmed on hardware 2026-09-08: the vendor tool wrote
 * `09 06 00 01 00 f0` to button 0, and reading it back via `0x86`/sub `00`
 * afterwards returned the identical three payload bytes. See
 * `incottEncodeSetButtonBinding` — this only encodes the raw binding; the
 * meaning of its bytes (key code vs. macro vs. remap) is NOT established, so
 * nothing here interprets them.
 */
export const INCOTT_CMD_SET_BUTTON = 0x06;
export const INCOTT_CMD_SET_RECEIVER_LED = 0x08;

/**
 * Selects which of the six DPI stages is ACTIVE: `09 03 06 <idx>` (command
 * `0x03`, sub-command `INCOTT_SUB_DPI_STAGE`, then the stage index). Pairs
 * with `INCOTT_CMD_QUERY_DPI_STAGE` (`0x83`), which reads the active index
 * back at the same sub-command — see `incottEncodeSetActiveDpiStage`.
 *
 * This is a SELECT, not an EDIT: it never touches the six-stage table's
 * stored values. Verified on hardware 2026-09-08 — selecting stage 0, 3, 5,
 * then 1 in turn each read back identically via `0x83`/`0x06`, and reading
 * all six stages via `0x82` before and after showed the table completely
 * unchanged by those selects.
 *
 * IMPORTANT MISLABEL TO NOT REPEAT: IncottHIDApp calls this command "set
 * DPI" and treats its six "DPI presets" as if picking one changes the DPI
 * value. It does not — it only changes which already-stored stage answers
 * as active. The bug this driver used to have (`setDpi` writing the
 * requested value into whichever stage happened to be active, silently
 * overwriting the factory table one stage at a time) came directly from
 * conflating this select with `INCOTT_CMD_SET_DPI` (`0x02`), the command
 * that actually edits a stage's stored value. See `incottEncodeSetDpi` and
 * `docs/incott-testing.md`.
 */
export const INCOTT_CMD_SET_DPI_STAGE = 0x03;

/**
 * Returns the active DPI *stage index* (0-5), not a DPI value — see
 * `incottDecodeDpiStageIndex`. Still `0x83`; only the interpretation of its
 * payload changed.
 */
export const INCOTT_CMD_QUERY_DPI_STAGE = 0x83;
/**
 * Reads the numeric DPI value stored in one of the six stages,
 * `09 82 <stage 0..5>` -> little-endian uint16 at RESPONSE bytes 3-4 (same
 * `wire = dpi/50 - 1` encoding as the write). Verified on hardware
 * 2026-09-08 by reading all six stages back as 400/800/1600/2400/3200/6400
 * (wire 0x07/0x0f/0x1f/0x2f/0x3f/0x7f), then writing 25000 to stage 2 and
 * reading it back as exactly 25000, then restoring 1600 and reading that
 * back too — six independent points on `dpi = (wire + 1) * 50`, plus a
 * write/restore round-trip. This was previously `INCOTT_CMD_UNKNOWN_82`: an
 * earlier opcode sweep only ever tried sub `0x00` and got back an
 * uninterpreted payload (`09 82 00 07 00 …`) — the same "sub-commands are
 * not optional" lesson `0x8e` (battery) taught. See `incottDecodeDpiStage`.
 */
export const INCOTT_CMD_QUERY_DPI_STAGE_VALUE = 0x82;
export const INCOTT_CMD_QUERY_POLLING = 0x81;
export const INCOTT_CMD_QUERY_SENSOR = 0x84;
export const INCOTT_CMD_QUERY_TIMING = 0x85;
export const INCOTT_CMD_QUERY_RECEIVER_LED = 0x88;
/**
 * Answers, but byte 8 of the reply returned the same constant `0x5a` (90) on
 * every capture ever taken, across every device state and both capture
 * sessions (2026-09-07 read-only sweep and the later vendor-tool traffic).
 * That is disproof, not confirmation, that byte 8 is a battery percentage —
 * see `docs/incott-testing.md`. Nothing in this driver decodes this response
 * any more. DISPROVEN A SECOND TIME on 2026-09-08: `0x8e`/sub `0x01` byte 6
 * (see below), the value this comment used to point to as "the real battery
 * percentage," is ALSO a constant — see `INCOTT_CMD_QUERY_BATTERY`. The real
 * battery level lives in an unsolicited input report; see
 * `incottDecodeInputStatus`. Kept only because the opcode itself still
 * answers and its real meaning is an open question worth recording.
 */
export const INCOTT_CMD_QUERY_STATUS = 0x89;
export const INCOTT_CMD_QUERY_IDENTITY = 0x8f;
/**
 * Battery percentage, but ONLY on sub-command `0x01` — the original opcode
 * sweep swept every command with sub `0x00` and concluded `0x8e` was
 * unimplemented because it never answered. Sub-commands are not optional on
 * this opcode (or on `0x86`, which the vendor tool queries as `09 86 09`).
 *
 * DISPROVEN 2026-09-08, the same way `0x89` byte 8 was disproven before it
 * (see `INCOTT_CMD_QUERY_STATUS`): charging a unit through a full cycle from
 * roughly 60% to roughly 97% while polling this response showed byte 6 NEVER
 * CHANGE — the identical frame `09 8e 01 5a 04 84 38 01` the entire time,
 * `0x38` = 56 throughout. A value that does not move while the real battery
 * level visibly does cannot be a battery reading; it is a constant of unknown
 * meaning, exactly like `0x89` byte 8 before it. `incottDecodeBattery` is
 * kept only as a codec (its mechanical byte-6 decode is unchanged and still
 * tested) and for the driver-level regression test that battery is no longer
 * sourced from here — see `IncottHidClient.readStatus` and
 * `docs/incott-testing.md`. The real battery percentage is a field of the
 * unsolicited input report the mouse emits while in use — see
 * `incottDecodeInputStatus`.
 */
export const INCOTT_CMD_QUERY_BATTERY = 0x8e;
export const INCOTT_SUB_BATTERY = 0x01;

/**
 * The report id the mouse's UNSOLICITED input reports arrive on — the same
 * value as `INCOTT_REPORT_ID` (`0x09`), which this module otherwise uses only
 * for feature-report request/response pairs. These input reports are NOT a
 * reply to anything this driver sends: the device emits them on its own,
 * only while it is actively being used (moved or clicked), carrying battery
 * and a packed DPI-stage/polling-rate snapshot. See `incottDecodeInputStatus`
 * and `src/drivers/incott/hid.ts`'s `onInputReport`.
 */
export const INCOTT_INPUT_REPORT_ID = INCOTT_REPORT_ID;

/**
 * Button binding read, `09 86 <button 0..5>` -> response bytes 3-5 = the raw
 * three-byte binding written by `INCOTT_CMD_SET_BUTTON` at the same index.
 * Round-trip confirmed on hardware 2026-09-08 (see `INCOTT_CMD_SET_BUTTON`).
 * The device has six buttons; reading indices 0-5 on the unit under test
 * returned:
 *   0 -> 01 00 f0    3 -> 01 00 f3
 *   1 -> 01 00 f1    4 -> 01 00 f4
 *   2 -> 01 00 f2    5 -> 07 00 03
 * (left, right, middle, forward, back, DPI — physically, in some order).
 * This was previously `INCOTT_CMD_UNKNOWN_86`, decoded only for the vendor
 * tool's own `09 86 09` query (still unexplained, kept as
 * `INCOTT_SUB_UNKNOWN_86_VENDOR_QUERY`). See `incottDecodeButtonBinding` —
 * only the raw three bytes are exposed; what `type`/`code` mean inside them
 * is NOT established and is not guessed at here.
 */
export const INCOTT_CMD_QUERY_BUTTON = 0x86;
/** Button count: left, right, middle, forward, back, DPI. */
export const INCOTT_BUTTON_COUNT = 6;
/**
 * The vendor tool's own query, `09 86 09`. NOT a button index — buttons only
 * go up to 5. It reads the onboard profile index, the counterpart of the
 * `09 06 09 <index>` write (`setProfileIndex` in the vendor bundle). Neither
 * is implemented here: switching profiles in the vendor tool still replays
 * every setting individually, so what the device stores against the index is
 * unknown.
 */
export const INCOTT_SUB_UNKNOWN_86_VENDOR_QUERY = 0x09;

/**
 * Physical buttons, in left-to-right display order.
 */
export const INCOTT_BUTTON_NAMES = ["Left", "Right", "Middle", "Forward", "Back", "DPI"] as const;
export type IncottButtonName = (typeof INCOTT_BUTTON_NAMES)[number];

/**
 * Display order -> WIRE index. **These are not the same**, and assuming they
 * were would silently swap two buttons.
 *
 * The vendor's per-model key table carries an explicit `matrix` field and
 * addresses the device with it (`setMsK(dvar.key[i].matrix, code)`), not with
 * the array position. For this family Forward sits at array index 3 with
 * `matrix = 4`, and Back at array index 4 with `matrix = 3` — the two are
 * transposed. Every other button's matrix equals its position.
 */
export const INCOTT_BUTTON_WIRE_INDEX: Readonly<Record<IncottButtonName, number>> = {
  Left: 0,
  Right: 1,
  Middle: 2,
  Forward: 4,
  Back: 3,
  DPI: 5,
};

/**
 * Button actions, label -> 32-bit action word, in display order.
 *
 * Transcribed from the vendor bundle's `kf_hw()` encoder. One row is
 * confirmed against this contributor's hardware: the factory DPI button reads
 * back `07 00 03`, which is `0x00030007` little-endian — the value `kf_hw`
 * returns for that function.
 *
 * NOT covered here: macros (`slot << 16 | 9`), which need the `0x07` upload
 * command, and `fmeFAVOR`, which the vendor defines as a constant but has no
 * case for in its own encoder, so there is no code to send.
 */
const MOUSE_AND_MEDIA_ACTIONS: ReadonlyArray<readonly [string, number]> = [
  ["Left click", 0x00f00001],
  ["Right click", 0x00f10001],
  ["Middle click", 0x00f20001],
  ["Forward", 0x00f40001],
  ["Back", 0x00f30001],
  ["DPI cycle", 0x00030007],
  ["DPI +", 0x00010007],
  ["DPI -", 0x00020007],
  ["Rapid fire", 0x0218f00a],
  ["Profile switch", 0x0000f10a],
  ["Media player", 0x01830003],
  ["Play/Pause", 0x00cd0003],
  ["Stop", 0x00b70003],
  ["Previous track", 0x00b60003],
  ["Next track", 0x00b50003],
  ["Volume up", 0x00e90003],
  ["Volume down", 0x00ea0003],
  ["Mute", 0x00e20003],
  ["Email", 0x018a0003],
  ["Calculator", 0x01920003],
  ["File explorer", 0x01940003],
  ["Browser home", 0x02230003],
  ["Browser refresh", 0x02270003],
  ["Browser forward", 0x02250003],
  ["Browser back", 0x02240003],
  ["Browser search", 0x02210003],
  ["Disabled", 0x00000000],
];

/** HID keyboard modifier bits, as the vendor's encoder packs them at byte 1. */
const MODIFIER_CTRL = 0x01;
const MODIFIER_SHIFT = 0x02;
const MODIFIER_ALT = 0x04;
const MODIFIER_GUI = 0x08;

/**
 * Standard HID keyboard usage codes. Labels are display names, not key-cap
 * legends, so they stay readable in a flat picker.
 */
const KEY_USAGES: ReadonlyArray<readonly [string, number]> = [
  ...Array.from({ length: 26 }, (_, i) => [String.fromCharCode(65 + i), 0x04 + i] as const),
  ...Array.from({ length: 9 }, (_, i) => [String(i + 1), 0x1e + i] as const),
  ["0", 0x27],
  ...Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, 0x3a + i] as const),
  ["Enter", 0x28], ["Escape", 0x29], ["Backspace", 0x2a], ["Tab", 0x2b], ["Space", 0x2c],
  ["Insert", 0x49], ["Delete", 0x4c], ["Home", 0x4a], ["End", 0x4d],
  ["Page Up", 0x4b], ["Page Down", 0x4e],
  ["Up", 0x52], ["Down", 0x51], ["Left", 0x50], ["Right", 0x4f],
  ["Caps Lock", 0x39], ["Num Lock", 0x53], ["Scroll Lock", 0x47],
  ["Print Screen", 0x46], ["Pause", 0x48], ["Context Menu", 0x65],
  ["Left Ctrl", 0xe0], ["Left Shift", 0xe1], ["Left Alt", 0xe2], ["Left Windows", 0xe3],
  ["Right Ctrl", 0xe4], ["Right Shift", 0xe5], ["Right Alt", 0xe6], ["Right Windows", 0xe7],
];

/** Common chords, since the flat picker cannot express "any key + any modifier". */
const KEY_SHORTCUTS: ReadonlyArray<readonly [string, number, number]> = [
  ["Ctrl + A", MODIFIER_CTRL, 0x04], ["Ctrl + C", MODIFIER_CTRL, 0x06],
  ["Ctrl + V", MODIFIER_CTRL, 0x19], ["Ctrl + X", MODIFIER_CTRL, 0x1b],
  ["Ctrl + Z", MODIFIER_CTRL, 0x1d], ["Ctrl + Y", MODIFIER_CTRL, 0x1c],
  ["Ctrl + S", MODIFIER_CTRL, 0x16], ["Ctrl + O", MODIFIER_CTRL, 0x12],
  ["Ctrl + N", MODIFIER_CTRL, 0x11], ["Ctrl + T", MODIFIER_CTRL, 0x17],
  ["Ctrl + W", MODIFIER_CTRL, 0x1a], ["Ctrl + F", MODIFIER_CTRL, 0x09],
  ["Ctrl + Shift + Escape", MODIFIER_CTRL | MODIFIER_SHIFT, 0x29],
  ["Alt + Tab", MODIFIER_ALT, 0x2b], ["Alt + F4", MODIFIER_ALT, 0x3d],
  ["Alt + Left", MODIFIER_ALT, 0x50], ["Alt + Right", MODIFIER_ALT, 0x4f],
  ["Win + D", MODIFIER_GUI, 0x07], ["Win + E", MODIFIER_GUI, 0x08],
  ["Win + L", MODIFIER_GUI, 0x0f], ["Win + R", MODIFIER_GUI, 0x15],
  ["Win + S", MODIFIER_GUI, 0x16], ["Win + Tab", MODIFIER_GUI, 0x2b],
];

/**
 * A keyboard action word, from the vendor's `kf_hw()` keyboard branch:
 *
 *     no modifier:   (keycode & 255) << 8  | 128
 *     with modifier: (keycode & 255) << 16 | (modifiers & 255) << 8
 *
 * The two forms are genuinely different shapes, not one with a zero
 * modifier — an unmodified key sets the `0x80` marker in the low byte and
 * puts the keycode one byte lower than a chord does.
 */
export function incottKeyboardActionCode(keycode: number, modifiers = 0): number {
  return modifiers === 0
    ? (((keycode & 0xff) << 8) | 0x80) >>> 0
    : (((keycode & 0xff) << 16) | ((modifiers & 0xff) << 8)) >>> 0;
}

/**
 * Everything a button can be set to, in display order: the mouse, DPI and
 * media actions above, then individual keys, then common chords.
 *
 * Keyboard bindings are enumerated rather than left out. The encoding is
 * parametric (any of 256 keycodes against any of 256 modifier masks) and the
 * shared `buttonOptions` contract is a flat list of labels, so the full space
 * cannot be offered — but a curated list covers what people actually bind,
 * and it is the same approach the MCHOSE driver in this repo already takes.
 */
export const INCOTT_BUTTON_ACTIONS: ReadonlyArray<readonly [string, number]> = [
  ...MOUSE_AND_MEDIA_ACTIONS,
  ...KEY_USAGES.map(([label, usage]) => [label, incottKeyboardActionCode(usage)] as const),
  ...KEY_SHORTCUTS.map(
    ([label, modifiers, usage]) => [label, incottKeyboardActionCode(usage, modifiers)] as const,
  ),
];

/** Label for a 32-bit action word, or null when it is not one this driver knows. */
export function incottButtonActionLabel(code: number): string | null {
  for (const [label, value] of INCOTT_BUTTON_ACTIONS) {
    if (value === code) return label;
  }
  return null;
}

/** 32-bit action word for a label, or null when the label is not in the table. */
export function incottButtonActionCode(label: string): number | null {
  for (const [name, value] of INCOTT_BUTTON_ACTIONS) {
    if (name === label) return value;
  }
  return null;
}

/**
 * How many DPI stages the cycle uses by default — and the value this driver
 * spent two sessions mistaking for a sub-command.
 *
 * `0x83`'s reply byte 2 is the stage COUNT, not an echo. Proven by the
 * captures: the vendor sends `09 83 00` and gets `09 83 06 01` back, and a
 * bare `09 83` sweep with no sub-command gets the same `06` — a byte the
 * request never contained cannot be an echo. Byte 3 is the active index,
 * which varies (`00`/`01`/`03`/`05`) while byte 2 stays `06`.
 *
 * This matters twice over:
 *   - `0x83` must NOT be treated as sub-echoing when matching responses. It
 *     belongs with `0x81`/`0x88`/`0x89`/`0x8f`, where byte 2 is data.
 *   - the `0x03` write carries the count alongside the index
 *     (`09 03 <count> <stage>`), so writing a hardcoded `06` while selecting
 *     a stage would reset a four-stage cycle back to six — the same shape of
 *     bug as the old `INCOTT_SUB_SET_DPI` constant below.
 */
export const INCOTT_DPI_STAGE_COUNT_DEFAULT = 6;
/**
 * Number of DPI stages the table holds. Both the `0x02` write and the `0x82`
 * read take a stage index in this range as their second payload byte — see
 * `incottEncodeSetDpi` and `incottDecodeDpiStage`.
 *
 * THIS WAS WRONG until 2026-09-08: the driver used to hardcode that byte as a
 * constant `INCOTT_SUB_SET_DPI = 0x01`, which could only ever write stage 1
 * of the table. Reading stages 0-5 on real hardware returned six independent
 * points on the DPI line (wire 0x07/0x0f/0x1f/0x2f/0x3f/0x7f ->
 * 400/800/1600/2400/3200/6400), proving the byte is a stage index, not a
 * fixed sub-command.
 */
export const INCOTT_DPI_STAGE_COUNT = 6;
export const INCOTT_SUB_LOD = 0x01;
export const INCOTT_SUB_RIPPLE = 0x02;
export const INCOTT_SUB_ANGLE_SNAP = 0x03;
export const INCOTT_SUB_MOTION_SYNC = 0x04;
/**
 * Sub-command for the "Performance mode" sensor setting (labelled HP / Corded
 * / LP in the vendor tool, described as trading performance for battery
 * life). The value-to-label mapping is now CONFIRMED: captured 2026-09-10 by
 * instrumenting Incott's own WebHID configurator with each click labelled
 * (unlike the 2026-09-07 capture, which only recorded the raw writes):
 *
 *   clicked "HP"      -> TX 09 04 05 02
 *   clicked "Corded"  -> TX 09 04 05 01
 *   clicked "LP"      -> TX 09 04 05 00
 *
 * i.e. HP=2, Corded=1, LP=0. **This is the REVERSE of the vendor UI's
 * left-to-right display order (HP | Corded | LP)** — exactly why this was
 * captured with each click labelled rather than assumed from the on-screen
 * order. See `INCOTT_PERFORMANCE_MODE_TO_WIRE`/`INCOTT_PERFORMANCE_MODE_FROM_WIRE`
 * for the single named table this reversal lives in, and
 * `incottEncodeSetPerformanceMode`.
 */
export const INCOTT_SUB_PERFORMANCE = 0x05;
export const INCOTT_SUB_DEBOUNCE = 0x01;
export const INCOTT_SUB_SLEEP = 0x03;
export const INCOTT_SUB_NONE = 0x00;

/**
 * DPI lives in a six-stage table, each stage a linear value — not an index
 * into a preset table. The wire value is little-endian at payload bytes 2-3
 * (write) / response bytes 3-4 (read):
 *   wire = dpi / 50 - 1        dpi = (wire + 1) * 50
 *
 * Verified on hardware 2026-09-08 by reading all six stages back as
 * 400/800/1600/2400/3200/6400 (wire 0x07/0x0f/0x1f/0x2f/0x3f/0x7f) — six
 * independent points on this line — then writing 25000 to stage 2 (wire 499)
 * and reading back exactly 25000, then restoring 1600 and reading that back
 * too. (An earlier, narrower proof from 2026-09-07 against a G23V2Pro only
 * ever exercised stage 1: `TX 09 02 01 0f 00` -> 800 DPI, `TX 09 02 01 f3 01`
 * -> 25000 DPI.) See `incottEncodeSetDpi` and `incottDecodeDpiStage`.
 *
 * The vendor's own device definition (js/gvarG23-v102.js) pairs two PixArt
 * sensor variants with different ceilings, both counting up from 50 in steps
 * of 50:
 *   sensor 0x3395 (PAW3395): 32000
 *   sensor 0x3950 (PAW3950): 45000
 * There is no known way to read which sensor variant is fitted to a given
 * unit, so `INCOTT_DPI_MAX` uses the higher of the two known ceilings. A
 * PAW3395 unit is expected to refuse anything above 32000; the existing
 * write-cache/read-back verification in `IncottHidClient.setDpi` is relied on
 * to report that honestly rather than this module guessing which sensor is
 * present.
 */
export const INCOTT_DPI_MIN = 50;
export const INCOTT_DPI_MAX = 45000;
export const INCOTT_DPI_STEP = 50;

/**
 * NOT the writable DPI range (see `INCOTT_DPI_MIN`/`INCOTT_DPI_MAX` above for
 * that) — the vendor's device definition calls this list the six DEFAULT
 * STAGE PRESETS. `0x83`/`0x06` reports which of these six stages is active as
 * an index 0-5 (see `incottDecodeDpiStageIndex`), not a DPI value. Kept as a
 * convenience list of round numbers; do not use it to validate or decode a
 * DPI write.
 */
export const INCOTT_DPI_DEFAULT_STAGE_PRESETS: readonly number[] = [400, 800, 1600, 2400, 3200, 6400];

/**
 * The full polling-rate ladder, available only over the 2.4 GHz wireless
 * connection (`INCOTT_PRODUCT_ID`, `0x522C`). See
 * `INCOTT_POLLING_STEPS_HZ_WIRED` for the lower ceiling the owner confirmed
 * on hardware when the mouse is plugged in.
 */
export const INCOTT_POLLING_STEPS_HZ: readonly number[] = [125, 250, 500, 1000, 2000, 4000, 8000];
/**
 * Wired ceiling — HARDWARE-VERIFIED: the owner confirmed the mouse only
 * reaches 1000 Hz over the USB cable (`INCOTT_PRODUCT_ID_WIRED`, `0x622C`);
 * 2000/4000/8000 Hz are wireless-only. Offering one of those over the cable
 * would produce a write the device silently refuses, which
 * `IncottHidClient.setPollingRate`'s read-back verification would then
 * report as a failure on every attempt — so `readStatus()` publishes this
 * narrower list instead of the full one whenever `incottIsWiredProduct` is
 * true. See `docs/incott-testing.md`.
 */
export const INCOTT_POLLING_STEPS_HZ_WIRED: readonly number[] = [125, 250, 500, 1000];
export const INCOTT_POLLING_WIRE_TO_HZ: Readonly<Record<number, number>> = {
  0: 1000, 1: 500, 2: 250, 3: 125, 4: 8000, 5: 4000, 6: 2000,
};
export const INCOTT_POLLING_HZ_TO_WIRE: Readonly<Record<number, number>> = {
  1000: 0, 500: 1, 250: 2, 125: 3, 8000: 4, 4000: 5, 2000: 6,
};

/**
 * Lift-off distance is carried in tenths of a millimetre.
 *
 * VERIFIED ON HARDWARE 2026-09-08. Setting 0.7 mm in Incott's own web
 * configurator and then reading `0x84`/sub `0x01` returned byte 3 = `2`,
 * so hardware 2 = 0.7 mm. That confirms IncottHIDApp's mapping, which is
 * what `INCOTT_LOD_WIRE_TO_TENTHS` below encodes.
 *
 * It also disproves a reading of the vendor's own device definition
 * (js/gvarG23-v102.js), which pairs `lodUI = [0.7, 1, 2]` with
 * `lodHW = [0, 1, 2]`. Those two arrays are NOT index-aligned — taking
 * them as a pair implies hardware 0 = 0.7 mm, which the device
 * contradicts. Do not 'fix' this mapping from that file.
 *
 * Remaining nuance: only the 0.7 mm point was read directly. Hardware 0
 * and 1 are 1 mm and 2 mm in that order per IncottHIDApp; since the
 * mapping is a bijection over {0,1,2} and its 0.7 mm claim proved correct,
 * the other two follow, but neither has been read back individually.
 */
export const INCOTT_LOD_STEPS_TENTHS: readonly number[] = [7, 10, 20];
export const INCOTT_LOD_WIRE_TO_TENTHS: Readonly<Record<number, number>> = { 0: 10, 1: 20, 2: 7 };
export const INCOTT_LOD_TENTHS_TO_WIRE: Readonly<Record<number, number>> = { 10: 0, 20: 1, 7: 2 };

export const INCOTT_DEBOUNCE_MIN_MS = 0;
export const INCOTT_DEBOUNCE_MAX_MS = 30;
export const INCOTT_SLEEP_MIN_S = 1;
export const INCOTT_SLEEP_MAX_S = 900;

/** All three raw wire values (LP/Corded/HP) are now hardware-confirmed — see `INCOTT_SUB_PERFORMANCE`. */
export const INCOTT_PERFORMANCE_MODE_MIN = 0;
export const INCOTT_PERFORMANCE_MODE_MAX = 2;

/**
 * The single named table the HP/Corded/LP value-to-label reversal lives in —
 * see `INCOTT_SUB_PERFORMANCE` for the capture that confirmed it. Keys are the
 * vendor tool's own display labels; `INCOTT_PERFORMANCE_MODE_NAMES` lists them
 * in the vendor UI's own left-to-right order (HP, Corded, LP) for advertising
 * to the app, while this table (and its inverse,
 * `INCOTT_PERFORMANCE_MODE_FROM_WIRE`) hold the REVERSED wire values.
 * `incottPerformanceModeToWire`/`incottPerformanceModeFromWire` are the
 * intended entry points; the raw tables are exported for tests.
 */
export const INCOTT_PERFORMANCE_MODE_NAMES: readonly string[] = ["HP", "Corded", "LP"];

/** name -> raw wire value. See `INCOTT_PERFORMANCE_MODE_NAMES`'s doc comment for the reversal warning. */
export const INCOTT_PERFORMANCE_MODE_TO_WIRE: Readonly<Record<string, number>> = {
  HP: 2,
  Corded: 1,
  LP: 0,
};

/** raw wire value -> name. The inverse of `INCOTT_PERFORMANCE_MODE_TO_WIRE`. */
export const INCOTT_PERFORMANCE_MODE_FROM_WIRE: Readonly<Record<number, string>> = {
  2: "HP",
  1: "Corded",
  0: "LP",
};

/** Validated name -> wire lookup for `incottEncodeSetPerformanceMode`/`IncottHidClient.setPowerMode`. Returns `null` for an unknown name rather than throwing, so callers can reject before writing anything. */
export function incottPerformanceModeToWire(name: string): number | null {
  return INCOTT_PERFORMANCE_MODE_TO_WIRE[name] ?? null;
}

/** Wire -> validated name lookup, the inverse of `incottPerformanceModeToWire`. Returns `null` for a value outside 0-2. */
export function incottPerformanceModeFromWire(wire: number): string | null {
  return INCOTT_PERFORMANCE_MODE_FROM_WIRE[wire] ?? null;
}

/**
 * A curated subset of the verified 1-900s sleep-timer range to offer in the
 * app's dropdown, in the same style as GEARHUB_SLEEP_OPTIONS and
 * MCHOSE_SLEEP_OPTIONS: the firmware accepts any integer second count in
 * range (see `incottEncodeSetSleep`), this is just a sane list of presets.
 * 900s (15 minutes) is the documented maximum.
 */
export const INCOTT_SLEEP_OPTIONS: readonly number[] = [10, 30, 60, 120, 300, 600, 900];

export const INCOTT_RECEIVER_LED_MODES: readonly string[] = [
  "Connect & polling rate",
  "Battery status",
  "Battery warning",
];

export type IncottToggleKind = "motionSync" | "angleSnapping" | "rippleControl";

export const INCOTT_TOGGLE_SUB: Readonly<Record<IncottToggleKind, number>> = {
  motionSync: INCOTT_SUB_MOTION_SYNC,
  angleSnapping: INCOTT_SUB_ANGLE_SNAP,
  rippleControl: INCOTT_SUB_RIPPLE,
};

/**
 * Builds a request payload. The report ID is deliberately absent: WebHID's
 * sendFeatureReport takes it as a separate argument.
 */
function payload(...values: readonly number[]): Uint8Array {
  const out = new Uint8Array(INCOTT_PAYLOAD_LENGTH);
  values.forEach((value, index) => {
    out[index] = value & 0xff;
  });
  return out;
}

/**
 * Throws `RangeError` unless `dpi` is a value the six-stage table can hold.
 * Split out from `incottEncodeSetDpi` so `IncottHidClient.setDpi` can reject
 * an invalid value before touching the device — determining which stage is
 * active requires a query, and an obviously-invalid DPI should never cost a
 * round-trip.
 */
export function incottValidateDpi(dpi: number): void {
  if (
    !Number.isInteger(dpi) ||
    dpi < INCOTT_DPI_MIN ||
    dpi > INCOTT_DPI_MAX ||
    dpi % INCOTT_DPI_STEP !== 0
  ) {
    throw new RangeError(`DPI out of range: ${dpi}`);
  }
}

/**
 * EDITS the DPI value stored in one stage — distinct from
 * `incottEncodeSetActiveDpiStage`, which only SELECTS which stage is active
 * and never touches a stored value. `stage` is a table index 0-5, NOT a
 * sub-command — see `INCOTT_DPI_STAGE_COUNT` for the hardware proof that this
 * byte varies (the driver used to hardcode it as a constant `0x01`, which
 * could only ever reach stage 1). The value itself is a plain little-endian
 * uint16 "wire" value — see the comment on `INCOTT_DPI_MIN` for the
 * conversion and the captured proof.
 *
 * PAYLOAD INDEX 7 IS AN AXIS BYTE, discovered 2026-09-10: the full write is
 * `02 <stage> <lo> <hi> 00 00 00 <axis>`, where `axis` 0 = both axes, 1 = X
 * only, 2 = Y only. This encoder always emits trailing zeros (see `payload`),
 * so it has only ever written axis 0 (both) — correct, but now for a known
 * reason rather than by accident. Independent X/Y is deliberately NOT
 * implemented: probing `0x82` with the axis byte set to 0, 1 and 2 returned
 * the identical value every time, i.e. there is no per-axis READ yet, and
 * this driver never ships a write it cannot verify. See
 * `docs/incott-testing.md` for the open question (find the read the vendor
 * tool uses to display separate X and Y DPI values) that would unblock this.
 */
export function incottEncodeSetDpi(stage: number, dpi: number): Uint8Array {
  if (!Number.isInteger(stage) || stage < 0 || stage >= INCOTT_DPI_STAGE_COUNT) {
    throw new RangeError(`DPI stage out of range: ${stage}`);
  }
  incottValidateDpi(dpi);
  const wire = dpi / INCOTT_DPI_STEP - 1;
  return payload(INCOTT_CMD_SET_DPI, stage, wire & 0xff, (wire >> 8) & 0xff);
}

/**
 * Writes the DPI cycle: `09 03 <count> <stage>` — how many stages the cycle
 * uses, and which one is active. Does NOT write a DPI value and does NOT
 * alter any stage's stored value; see `INCOTT_CMD_SET_DPI_STAGE` for the
 * hardware proof (select 0/3/5/1, table unchanged) and for why this is a
 * distinct operation from `incottEncodeSetDpi`, which edits a stage's stored
 * value.
 *
 * `count` IS REQUIRED, and callers must pass what the device currently
 * reports rather than a constant — the byte used to be hardcoded `0x06` in
 * the belief that it was a sub-command, which would silently reset a
 * four-stage cycle to six every time a stage was selected. See
 * `INCOTT_DPI_STAGE_COUNT_DEFAULT`.
 */
export function incottEncodeSetDpiCycle(count: number, stage: number): Uint8Array {
  if (!Number.isInteger(count) || count < 1 || count > INCOTT_DPI_STAGE_COUNT) {
    throw new RangeError(`DPI stage count out of range: ${count}`);
  }
  if (!Number.isInteger(stage) || stage < 0 || stage >= count) {
    throw new RangeError(`DPI stage ${stage} out of range for a ${count}-stage cycle`);
  }
  return payload(INCOTT_CMD_SET_DPI_STAGE, count, stage);
}

export function incottEncodeSetPollingRate(hz: number): Uint8Array {
  const wire = INCOTT_POLLING_HZ_TO_WIRE[hz];
  if (wire === undefined) throw new RangeError(`Unsupported polling rate: ${hz} Hz`);
  // No sub-command: the wire value occupies the sub-command slot.
  return payload(INCOTT_CMD_SET_POLLING, wire);
}

export function incottEncodeSetLiftOff(tenthsMm: number): Uint8Array {
  const wire = INCOTT_LOD_TENTHS_TO_WIRE[tenthsMm];
  if (wire === undefined) throw new RangeError(`Unsupported lift-off distance: ${tenthsMm}`);
  return payload(INCOTT_CMD_SET_SENSOR, INCOTT_SUB_LOD, wire);
}

export function incottEncodeSetToggle(kind: IncottToggleKind, on: boolean): Uint8Array {
  return payload(INCOTT_CMD_SET_SENSOR, INCOTT_TOGGLE_SUB[kind], on ? 0x01 : 0x00);
}

/**
 * Encodes a button binding write, `09 06 <button 0..5> <32-bit action, LE>`.
 *
 * The action is a 32-bit little-endian word — see `INCOTT_BUTTON_ACTIONS`
 * for the labelled codes. Confirmed against hardware: this unit's factory
 * binding for the DPI button reads back `07 00 03`, and the vendor's own
 * encoder returns `0x00030007` for that function, which is the same word.
 *
 * `button` is the WIRE index, which is not the physical left-to-right order
 * — see `INCOTT_BUTTON_WIRE_INDEX`.
 */
export function incottEncodeSetButtonBinding(button: number, code: number): Uint8Array {
  if (!Number.isInteger(button) || button < 0 || button >= INCOTT_BUTTON_COUNT) {
    throw new RangeError(`Button index out of range: ${button}`);
  }
  if (!Number.isInteger(code) || code < 0 || code > 0xffffffff) {
    throw new RangeError(`Button action code out of range: ${code}`);
  }
  return payload(
    INCOTT_CMD_SET_BUTTON,
    button,
    code & 0xff,
    (code >>> 8) & 0xff,
    (code >>> 16) & 0xff,
    (code >>> 24) & 0xff,
  );
}

/**
 * Encodes the raw 0-2 performance-mode value. The value-to-label mapping
 * (HP=2 / Corded=1 / LP=0) is now CONFIRMED — see `INCOTT_SUB_PERFORMANCE`
 * for the labelled capture and its REVERSED-vs-UI warning. Most callers
 * should go through `incottPerformanceModeToWire`/`IncottHidClient.setPowerMode`
 * with a name instead of a raw value; this function is the low-level codec
 * both build on.
 */
export function incottEncodeSetPerformanceMode(mode: number): Uint8Array {
  if (!Number.isInteger(mode) || mode < INCOTT_PERFORMANCE_MODE_MIN || mode > INCOTT_PERFORMANCE_MODE_MAX) {
    throw new RangeError(`Performance mode out of range: ${mode}`);
  }
  return payload(INCOTT_CMD_SET_SENSOR, INCOTT_SUB_PERFORMANCE, mode);
}

export function incottEncodeSetDebounce(ms: number): Uint8Array {
  if (!Number.isInteger(ms) || ms < INCOTT_DEBOUNCE_MIN_MS || ms > INCOTT_DEBOUNCE_MAX_MS) {
    throw new RangeError(`Debounce out of range: ${ms} ms`);
  }
  return payload(INCOTT_CMD_SET_TIMING, INCOTT_SUB_DEBOUNCE, ms);
}

export function incottEncodeSetSleep(seconds: number): Uint8Array {
  if (!Number.isInteger(seconds) || seconds < INCOTT_SLEEP_MIN_S || seconds > INCOTT_SLEEP_MAX_S) {
    throw new RangeError(`Sleep timer out of range: ${seconds} s`);
  }
  return payload(INCOTT_CMD_SET_TIMING, INCOTT_SUB_SLEEP, seconds & 0xff, (seconds >> 8) & 0xff);
}

export function incottEncodeSetReceiverLed(mode: number): Uint8Array {
  if (!Number.isInteger(mode) || mode < 0 || mode >= INCOTT_RECEIVER_LED_MODES.length) {
    throw new RangeError(`Receiver LED mode out of range: ${mode}`);
  }
  return payload(INCOTT_CMD_SET_RECEIVER_LED, mode);
}

export function incottEncodeQuery(cmd: number, sub: number = INCOTT_SUB_NONE): Uint8Array {
  return payload(cmd, sub);
}

/**
 * The models that share `093A:522C`/`093A:622C`. All six enumerate under the
 * same two product ids, so the USB descriptor cannot tell them apart — the
 * model is carried in the identity reply instead (`incottDecodeIdentity`).
 *
 * "Zero 29"/"Zero 39" are the English series names the vendor's own
 * `text_en` bundle uses (`msg94`/`msg95`); its code calls the same two models
 * `G29` and `FM23` internally and renders them as 零29/零39.
 */
export type IncottModel = "Ghero" | "G23" | "G24" | "G23V2" | "Zero 29" | "Zero 39";

/**
 * Identity byte 3 -> model, transcribed from the vendor configurator's own
 * `readDps()` dispatch. That dispatch is authoritative for all six models in
 * a way one owner's device can never be; only the `0x0e` row is confirmed
 * against hardware here, since this contributor has only a G23V2.
 *
 * `0x08` and `0x0e` BOTH mean G23V2 — the vendor tests them in a single
 * branch (`8 == rData[2] || 14 == rData[2]`). Two hardware revisions of one
 * model is the obvious reading, but that is an inference; what is certain is
 * that the vendor maps both to the same name.
 */
const INCOTT_MODEL_BY_CODE: ReadonlyMap<number, IncottModel> = new Map<number, IncottModel>([
  [0x01, "Ghero"],
  [0x02, "G23"],
  [0x03, "G24"],
  [0x06, "Zero 29"],
  [0x08, "G23V2"],
  [0x09, "Zero 39"],
  [0x0e, "G23V2"],
]);

/** PixArt PAW3395 — capped at 32000 DPI in the vendor's own DPI table. */
export const INCOTT_SENSOR_PAW3395 = 0x3395;
/** PixArt PAW3950 — capped at 45000 DPI, and what the "Pro" suffix means. */
export const INCOTT_SENSOR_PAW3950 = 0x3950;

/** Identity byte 2 is a fixed `0x01` guard; the vendor rejects the device otherwise. */
const INCOTT_IDENTITY_GUARD = 0x01;
/** Identity sensor byte: `0xF1` selects the PAW3950 profile, anything else the PAW3395. */
const INCOTT_IDENTITY_SENSOR_PAW3950 = 0xf1;
/** Identity byte 4 — `0x02` is the 8 KHz receiver. */
const INCOTT_IDENTITY_8K_RECEIVER = 0x02;

export interface IncottDeviceIdentity {
  /** Space-separated hex of the identity payload, for the details panel. */
  raw: string;
  /** Decoded model, or null when byte 3 carries a code this table does not know. */
  model: IncottModel | null;
  /** Raw byte 3, kept even when unrecognised so an unknown model can still be reported. */
  modelCode: number | null;
  /** Model plus a " Pro" suffix when the PAW3950 is fitted, e.g. "G23V2 Pro". */
  displayName: string | null;
  /** The FITTED sensor, from byte 6: `INCOTT_SENSOR_PAW3395` or `INCOTT_SENSOR_PAW3950`. */
  sensorId: number | null;
  /** True when the PAW3950 is fitted — what the vendor's "Pro" suffix means. */
  isPro: boolean;
  /** True when byte 4 reports the 8 KHz receiver. */
  is8KReceiver: boolean;
}

/**
 * A response frame is trustworthy only when the report ID, the command echo
 * and (when one was sent) the sub-command echo all agree with the request.
 * The device latches a single shared response buffer, so a frame left over
 * from an earlier query will otherwise be decoded as a real value.
 */
export function incottFrameMatches(frame: Uint8Array, cmd: number, sub: number | null): boolean {
  if (frame.length < 3) return false;
  if (frame[0] !== INCOTT_REPORT_ID) return false;
  if (frame[1] !== cmd) return false;
  if (sub !== null && frame[2] !== sub) return false;
  return true;
}

/** The DPI cycle as the device reports it: how many stages, and which is live. */
export interface IncottDpiCycle {
  /** Stages in the cycle, 1..`INCOTT_DPI_STAGE_COUNT`. */
  count: number;
  /** Active stage, 0-based and always below `count`. */
  active: number;
}

/**
 * `09 83` -> `<count> <active>` at response bytes 2 and 3.
 *
 * Byte 3 was proven not to be a DPI-value index on hardware 2026-09-07:
 * decoding it through `INCOTT_DPI_DEFAULT_STAGE_PRESETS` used to yield 800
 * DPI, matching the vendor UI only by coincidence (the device happened to be
 * on stage 1 of 6). Combine with `incottDecodeDpiStage` at `active` to get
 * the actual DPI value — see `IncottHidClient.readStatus`.
 *
 * Byte 2 was then mistaken for a sub-command echo, because the count on the
 * only device available is 6 and the driver happened to send `06`. It is
 * data: `09 83 00` and a bare `09 83` both answer `06`. Matching it as an
 * echo would reject every reply from a mouse whose cycle is not six stages
 * long, so this decoder matches on the COMMAND ONLY — see
 * `INCOTT_DPI_STAGE_COUNT_DEFAULT`.
 */
export function incottDecodeDpiCycle(frame: Uint8Array): IncottDpiCycle | null {
  if (!incottFrameMatches(frame, INCOTT_CMD_QUERY_DPI_STAGE, null)) return null;
  const count = frame[2];
  const active = frame[3];
  if (count === undefined || active === undefined) return null;
  if (count < 1 || count > INCOTT_DPI_STAGE_COUNT) return null;
  // An active index outside the cycle is not a reading this driver can make
  // sense of, and guessing a fallback would put the DPI panel on the wrong
  // stage. Report nothing instead.
  if (active >= count) return null;
  return { count, active };
}

/**
 * `09 82 <stage>` -> the DPI value stored in that stage, little-endian at
 * response bytes 3-4. This opcode used to be `INCOTT_CMD_UNKNOWN_82` — see
 * the comment on `INCOTT_CMD_QUERY_DPI_STAGE_VALUE` for the hardware proof
 * (six independent stage reads plus a write/read-back/restore round-trip on
 * stage 2). `0x82` echoes its sub-command like `0x83`/`0x84`/`0x85`/`0x8e`
 * (verified: `09 82 03` replies `09 82 03 …`), so `incottFrameMatches`
 * checking byte 2 against `stage` is safe here.
 */
export function incottDecodeDpiStage(frame: Uint8Array, stage: number): number | null {
  if (!incottFrameMatches(frame, INCOTT_CMD_QUERY_DPI_STAGE_VALUE, stage)) return null;
  if (frame.length < 5) return null;
  const wire = frame[3]! | (frame[4]! << 8);
  const dpi = (wire + 1) * INCOTT_DPI_STEP;
  return dpi >= INCOTT_DPI_MIN && dpi <= INCOTT_DPI_MAX ? dpi : null;
}

/**
 * The polling value sits in byte 2, mirroring the write, which also carries
 * its value in the sub-command slot. CONFIRMED on hardware 2026-09-08: writing
 * wire `1` then wire `0` and reading back showed byte 2 follow, `0 -> 1 -> 0`.
 * `0x81` does NOT echo a sub-command the way `0x82`-`0x86`/`0x8e` do — byte 2
 * here is data, not an echo — which is why it stays out of
 * `SUB_ECHOING_QUERIES` in `src/drivers/incott/hid.ts`.
 */
export function incottDecodePollingRate(frame: Uint8Array): number | null {
  if (!incottFrameMatches(frame, INCOTT_CMD_QUERY_POLLING, null)) return null;
  return INCOTT_POLLING_WIRE_TO_HZ[frame[2] ?? -1] ?? null;
}

/**
 * Reads lift-off from the packed byte 7 of the `0x84`/sub `0x00` response
 * (high nibble). Superseded as the driver's primary read by
 * `incottDecodeLiftOffDirect` (see `INCOTT_SUB_LOD`'s symmetric
 * `0x84`/`0x01` read), which is clearer, but kept and still exercised: it was
 * cross-checked against the symmetric read on hardware 2026-09-08 — hardware
 * values 0, 1, 2 round-tripped identically through both forms — so this is
 * not wrong, just less direct.
 */
export function incottDecodeLiftOff(frame: Uint8Array): number | null {
  if (!incottFrameMatches(frame, INCOTT_CMD_QUERY_SENSOR, INCOTT_SUB_NONE)) return null;
  if (frame.length < 8) return null;
  return INCOTT_LOD_WIRE_TO_TENTHS[frame[7] >> 4] ?? null;
}

/**
 * Symmetric single-purpose read for lift-off: `09 84 01` -> response byte 3
 * is the raw hardware value (0-2), matching the sub-command the `0x04`/`0x01`
 * write uses (see `incottEncodeSetLiftOff`). PREFERRED over
 * `incottDecodeLiftOff`'s packed byte-7 nibble read: verified on hardware
 * 2026-09-08 by round-tripping hw 0, 1, 2 through both this form and the
 * nibble form and finding they agree at every step. The hw-to-millimetre
 * label mapping is still an open question — see `INCOTT_LOD_WIRE_TO_TENTHS`.
 */
export function incottDecodeLiftOffDirect(frame: Uint8Array): number | null {
  if (!incottFrameMatches(frame, INCOTT_CMD_QUERY_SENSOR, INCOTT_SUB_LOD)) return null;
  const wire = frame[3];
  return wire !== undefined ? (INCOTT_LOD_WIRE_TO_TENTHS[wire] ?? null) : null;
}

/**
 * Reads motion sync from the packed byte 7 of the `0x84`/sub `0x00` response
 * (low nibble). Superseded as the driver's primary read by
 * `incottDecodeToggle(frame, INCOTT_SUB_MOTION_SYNC)` (the symmetric
 * `0x84`/`0x04` read), which is clearer, but kept and still exercised: it was
 * cross-checked against the symmetric read on hardware 2026-09-08 — 0/1/0
 * round-tripped identically through both forms — so this is not wrong, just
 * less direct.
 */
export function incottDecodeMotionSync(frame: Uint8Array): boolean | null {
  if (!incottFrameMatches(frame, INCOTT_CMD_QUERY_SENSOR, INCOTT_SUB_NONE)) return null;
  if (frame.length < 8) return null;
  const nibble = frame[7] & 0x0f;
  return nibble === 0x01 ? true : nibble === 0x00 ? false : null;
}

export function incottDecodeToggle(frame: Uint8Array, sub?: number): boolean | null {
  if (!incottFrameMatches(frame, INCOTT_CMD_QUERY_SENSOR, sub ?? null)) return null;
  const value = frame[3];
  if (value === 0x01) return true;
  if (value === 0x00) return false;
  return null;
}

/**
 * `09 84 05` -> response byte 3 carries the current raw 0-2 performance-mode
 * value. This follows the symmetric-read pattern every other `0x04`/`0x84`
 * sensor sub-command uses (lift-off, ripple, angle snap and motion sync all
 * pair a `0x04` write with an `0x84` read at the same sub-command), and
 * `0x84` is already in the sub-echoing set (`SUB_ECHOING_QUERIES` in
 * `src/drivers/incott/hid.ts`), so the existing transaction discipline covers
 * it. Callers must still treat `null` as "unreadable," not as a confirmed
 * value — see `IncottHidClient.setPowerMode`, which requires a non-null,
 * matching read-back before reporting success.
 */
export function incottDecodePerformanceMode(frame: Uint8Array): number | null {
  if (!incottFrameMatches(frame, INCOTT_CMD_QUERY_SENSOR, INCOTT_SUB_PERFORMANCE)) return null;
  const value = frame[3];
  return value !== undefined && value >= INCOTT_PERFORMANCE_MODE_MIN && value <= INCOTT_PERFORMANCE_MODE_MAX
    ? value
    : null;
}

export function incottDecodeDebounce(frame: Uint8Array): number | null {
  if (!incottFrameMatches(frame, INCOTT_CMD_QUERY_TIMING, INCOTT_SUB_DEBOUNCE)) return null;
  const value = frame[3] ?? -1;
  return value >= 0 && value <= INCOTT_DEBOUNCE_MAX_MS ? value : null;
}

export function incottDecodeSleep(frame: Uint8Array): number | null {
  if (!incottFrameMatches(frame, INCOTT_CMD_QUERY_TIMING, INCOTT_SUB_SLEEP)) return null;
  if (frame.length < 5) return null;
  const value = frame[3] | (frame[4] << 8);
  return value >= INCOTT_SLEEP_MIN_S && value <= INCOTT_SLEEP_MAX_S ? value : null;
}

export function incottDecodeReceiverLed(frame: Uint8Array): number | null {
  if (frame[0] !== INCOTT_REPORT_ID || frame[1] !== INCOTT_CMD_QUERY_RECEIVER_LED) return null;
  const value = frame[2] ?? -1;
  return value >= 0 && value < INCOTT_RECEIVER_LED_MODES.length ? value : null;
}

/**
 * DISPROVEN AS A BATTERY READING, 2026-09-08 — kept as a codec only (its
 * mechanical byte-6 decode is unchanged and still exercised by tests) and for
 * `IncottHidClient.readStatus`'s regression test that battery is no longer
 * sourced from this frame. See `INCOTT_CMD_QUERY_BATTERY` for the full
 * write-up: a full charge cycle from roughly 60% to roughly 97% left this
 * frame's byte 6 completely unchanged (`09 8e 01 5a 04 84 38 01`, `0x38` = 56
 * throughout), the same disproof `0x89` byte 8 suffered earlier. Originally
 * "proven" on hardware 2026-09-07 against a single static capture
 * (`TX 09 8e 01` -> `RX 09 8e 01 5a 04 84 38 01 00`) that only ever showed one
 * reading was never distinguished from a constant until the later
 * full-cycle test. The real battery percentage is a field of the unsolicited
 * input report the mouse emits while in use — see `incottDecodeInputStatus`
 * and `IncottHidClient`'s class comment.
 */
export function incottDecodeBattery(frame: Uint8Array): number | null {
  if (!incottFrameMatches(frame, INCOTT_CMD_QUERY_BATTERY, INCOTT_SUB_BATTERY)) return null;
  const value = frame[6];
  return value !== undefined && value >= 0 && value <= 100 ? value : null;
}

/**
 * Raw byte 1 (this module's convention — see below) of the mouse's
 * unsolicited input report, above which the mouse is charging. At or below
 * this, the raw byte IS the battery percentage; above it, subtract
 * `INCOTT_INPUT_BATTERY_CHARGING_OFFSET` to get the percentage. See
 * `incottDecodeInputStatus`.
 */
export const INCOTT_INPUT_BATTERY_CHARGING_THRESHOLD = 100;
/** See `INCOTT_INPUT_BATTERY_CHARGING_THRESHOLD`. */
export const INCOTT_INPUT_BATTERY_CHARGING_OFFSET = 128;

/**
 * Decoded fields of the mouse's unsolicited vendor-collection INPUT report
 * (report id `INCOTT_INPUT_REPORT_ID`) — see `incottDecodeInputStatus`.
 */
export interface IncottInputStatus {
  /** 0-100. */
  batteryPercent: number;
  /** True when `byte0 > INCOTT_INPUT_BATTERY_CHARGING_THRESHOLD`. */
  charging: boolean;
  /** High nibble of byte 1: which of the six DPI stages is active (0-5). Corroborates, but does not replace, the `0x83`/`0x06` feature-report read. */
  dpiStageIndex: number;
  /** Low nibble of byte 1: index into `INCOTT_POLLING_WIRE_TO_HZ`. Corroborates, but does not replace, the `0x81` feature-report read. */
  pollingIndex: number;
}

/**
 * Decodes the mouse's UNSOLICITED input report — battery plus a packed
 * DPI-stage/polling-rate snapshot. This is NOT a feature-report reply (no
 * request triggers it): the device emits it on report id
 * `INCOTT_INPUT_REPORT_ID` on its own, only while it is actively being used.
 *
 * BYTE-INDEX CONVENTION, mirroring the asymmetry this module's top-of-file
 * comment already documents for feature reports (WebHID's `sendFeatureReport`
 * takes the report id separately, so encoded payloads omit it, while
 * `receiveFeatureReport` returns it at byte 0, so decoded frames include it):
 * this function's `byte0`/`byte1` parameters EXCLUDE the report id, matching
 * WebHID's `inputreport` event, whose `data` DataView excludes it too
 * (`event.reportId` carries it separately). So `byte0` is
 * `event.data.getUint8(0)`, `byte1` is `event.data.getUint8(1)`.
 *
 * node-hid's raw input buffer, by contrast, INCLUDES the report id at index
 * 0 — the two hardware captures below were taken that way, so in node-hid
 * terms `byte0` is `buf[1]` and `byte1` is `buf[2]`. Get this backwards and
 * every field reads off by one byte. See
 * `captures/incott-8k-wireless/input-report-battery.hex` and
 * `src/drivers/incott/hid.ts`'s `onInputReport`, which unwraps the WebHID
 * event into this convention before calling this function.
 *
 * Hardware-verified 2026-09-08 across a full charge cycle (~60% to ~97%):
 * ```
 * discharging: 09 5f 10 04 00 0f 0f 10   (node-hid)  byte0=0x5f=95  -> 95%
 * charging:    09 e1 10 04 00 0f 0f 10   (node-hid)  byte0=0xe1=225 -> charging, 225-128=97%
 * ```
 * `raw > 100` means charging (subtract `INCOTT_INPUT_BATTERY_CHARGING_OFFSET`
 * for the percent); `raw <= 100` means discharging (raw IS the percent). This
 * is the same convention IncottHIDApp's `parseStatus` uses, and unlike that
 * project's other claims, this one is now independently hardware-verified in
 * both states — see `docs/incott-testing.md`.
 *
 * Byte 1's `0x10` on the unit under test decoded to DPI stage 1 / polling
 * index 0, and both independently matched what the feature reads returned at
 * the same moment (`09 83 06` -> stage 1, `09 81` byte 2 -> 0) — a
 * corroborating cross-check only; `IncottHidClient` still treats the feature
 * reads as authoritative for DPI stage and polling rate.
 *
 * Returns `null` when either byte is out of range, or when the derived
 * percent would fall outside 0-100 (a malformed or unrelated report).
 */
export function incottDecodeInputStatus(byte0: number, byte1: number): IncottInputStatus | null {
  if (byte0 === undefined || byte0 < 0 || byte0 > 255) return null;
  if (byte1 === undefined || byte1 < 0 || byte1 > 255) return null;
  const charging = byte0 > INCOTT_INPUT_BATTERY_CHARGING_THRESHOLD;
  const batteryPercent = charging ? byte0 - INCOTT_INPUT_BATTERY_CHARGING_OFFSET : byte0;
  if (batteryPercent < 0 || batteryPercent > 100) return null;
  return {
    batteryPercent,
    charging,
    dpiStageIndex: (byte1 >> 4) & 0x0f,
    pollingIndex: byte1 & 0x0f,
  };
}

/**
 * A button's current binding: the raw 32-bit action word, plus the label
 * when it is one this driver knows.
 *
 * `label` is null for a binding the action table does not cover — a keyboard
 * key, a macro, or an action from a model this contributor cannot test. The
 * `code` is always reported so an unrecognised binding round-trips
 * unchanged rather than being flattened to a default.
 */
export interface IncottButtonBinding {
  button: number;
  code: number;
  label: string | null;
}

/**
 * `09 86 <button 0..5>` -> response bytes 3-6 = the binding, 32-bit
 * little-endian.
 *
 * PREVIOUSLY A BUG: this read only bytes 3-5 and reported them as three
 * unnamed bytes, silently truncating the top byte. Every action in
 * `INCOTT_BUTTON_ACTIONS` whose code exceeds 24 bits — "Rapid fire"
 * (`0x0218F00A`) among them — decoded to a different value than was
 * written. The vendor reads the same four bytes
 * (`rData[5]<<24|rData[4]<<16|rData[3]<<8|rData[2]`).
 */
export function incottDecodeButtonBinding(frame: Uint8Array, button: number): IncottButtonBinding | null {
  if (!incottFrameMatches(frame, INCOTT_CMD_QUERY_BUTTON, button)) return null;
  if (frame.length < 7) return null;
  const code = ((frame[6]! << 24) | (frame[5]! << 16) | (frame[4]! << 8) | frame[3]!) >>> 0;
  return { button, code, label: incottButtonActionLabel(code) };
}

/**
 * Decodes the identity reply (`09 8f 00` -> `09 8f 01 0e 02 f0 f1 00 ff`).
 *
 * Byte map, transcribed from the vendor configurator's `readDps()` and
 * confirmed byte-for-byte against this contributor's G23V2 (capture
 * 2026-09-07, `captures/incott-8k-wireless/query-sweep-0x80-0x8f.hex`):
 *
 *     byte 2  guard, always 0x01   -- the vendor abandons the device otherwise
 *     byte 3  model code           -- 0x0e = G23V2, see INCOTT_MODEL_BY_CODE
 *     byte 4  receiver type        -- 0x02 = 8 KHz receiver
 *     byte 5  sensor profile, WIRED link    -- 0xF0 -> PAW3395, 0xF1 -> PAW3950
 *     byte 6  sensor profile, WIRELESS link
 *
 * WHY BYTE 6 AND NOT BYTE 5: the vendor picks its sensor byte by connection
 * (`let i = this.iswireless ? 5 : 4` over its own report-id-less buffer), and
 * on this G23V2 the two bytes DISAGREE — `f0 f1`. Taken as hardware identity
 * that is a contradiction: a mouse does not swap sensors when a cable goes
 * in. Taken as a per-link CAPABILITY profile it is consistent, because the
 * vendor feeds this value straight into `getStDPI(sensor)` to pick a DPI
 * ceiling (PAW3395 -> 32000, PAW3950 -> 45000) — and the cable is already
 * known to be the reduced-capability path on this device, capping polling at
 * 1000 Hz (see `INCOTT_POLLING_STEPS_HZ_WIRED`).
 *
 * So the FITTED sensor is read from byte 6, the full-capability slot, and the
 * decoded name is therefore stable across wired and wireless. The vendor's
 * own tool is not: because it re-reads the byte by connection, it labels this
 * one physical mouse "G23V2Pro" on the dongle and "G23V2" on the cable. That
 * cosmetic flip is deliberately NOT mirrored — a model name that changes when
 * you plug in a cable is a worse answer than the hardware's own.
 *
 * This is the one inference in this decoder rather than a transcription, and
 * it is falsifiable: if the vendor tool ever shows "G23V2Pro" while WIRED,
 * byte 5 is not a wired-capability profile and this reading is wrong. Byte 5
 * is otherwise unused here — a per-link DPI ceiling is not implemented,
 * because nothing has yet confirmed the cable actually caps DPI at 32000.
 *
 * Returns `null` ONLY when the report id or command echo is wrong — `open()`
 * uses that as its collection-liveness probe. A frame that is well-formed
 * but too short, or whose guard byte is not `0x01`, still yields an identity
 * carrying `raw` with every decoded field left null: an unreadable model is
 * reported as unknown, never guessed.
 */
export function incottDecodeIdentity(frame: Uint8Array): IncottDeviceIdentity | null {
  if (frame[0] !== INCOTT_REPORT_ID || frame[1] !== INCOTT_CMD_QUERY_IDENTITY) return null;
  const raw = Array.from(frame.slice(2, 9))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join(" ");
  const unknown: IncottDeviceIdentity = {
    raw,
    model: null,
    modelCode: null,
    displayName: null,
    sensorId: null,
    isPro: false,
    is8KReceiver: false,
  };
  if (frame.length < 7) return unknown;
  if (frame[2] !== INCOTT_IDENTITY_GUARD) return unknown;
  const modelCode = frame[3]!;
  const model = INCOTT_MODEL_BY_CODE.get(modelCode) ?? null;
  const sensorId = frame[6] === INCOTT_IDENTITY_SENSOR_PAW3950
    ? INCOTT_SENSOR_PAW3950
    : INCOTT_SENSOR_PAW3395;
  const isPro = sensorId === INCOTT_SENSOR_PAW3950;
  return {
    raw,
    model,
    modelCode,
    displayName: model === null ? null : isPro ? `${model} Pro` : model,
    sensorId,
    isPro,
    is8KReceiver: frame[4] === INCOTT_IDENTITY_8K_RECEIVER,
  };
}

/**
 * True when this product id is the WIRED one (`0x622C`) rather than the 2.4
 * GHz dongle's (`0x522C`, `INCOTT_PRODUCT_ID`) — hardware-verified 2026-09-08,
 * see `INCOTT_PRODUCT_ID_WIRED`. Formerly `incottIsChargingProduct`: it
 * always returned exactly this, but under a name that mislabelled the
 * connection as a charging flag. Charging is real for this product id, but
 * it is a CONSEQUENCE of being plugged in, not what the id itself encodes —
 * see `IncottHidClient.readStatus`, which now sets `connectionType` from
 * this helper directly and derives `batteryState: "Charging"` from it rather
 * than from a same-named constant.
 */
export function incottIsWiredProduct(productId: number): boolean {
  return productId === INCOTT_PRODUCT_ID_WIRED;
}

/**
 * Tidies the raw HID product string for display: drops a single leading
 * vendor word ("incott") and a single trailing "mouse", case-insensitively,
 * leaving whatever sits between. Falls back to the untouched raw string if
 * stripping both would leave nothing.
 *
 * "incott Esports G23V2Pro mouse" -> "Esports G23V2Pro"
 * "incott 8K wireless mouse"      -> "8K wireless"
 *
 * WHY THIS EXISTS: the product string names a model only over the CABLE
 * ("incott Esports G23V2Pro mouse", hardware-verified 2026-09-08); the
 * wireless dongle reports a generic "incott 8K wireless mouse" with no model
 * in it at all. This function only TIDIES whatever raw string the device
 * actually reported; it never invents one.
 *
 * This is now the FALLBACK, not the primary source. The identity reply's
 * byte layout has since been decoded (`incottDecodeIdentity`), so
 * `IncottHidClient.readStatus` prefers the model read from the device —
 * which works wirelessly too — and drops back to this function only when the
 * identity query fails or reports a model code the table does not know.
 */
export function incottNormalizeProductName(raw: string): string {
  const words = raw.trim().split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return raw;
  const start = words[0]!.toLowerCase() === "incott" ? 1 : 0;
  const endExclusive = words.length > start && words[words.length - 1]!.toLowerCase() === "mouse"
    ? words.length - 1
    : words.length;
  const trimmed = words.slice(start, Math.max(start, endExclusive)).join(" ");
  return trimmed.length > 0 ? trimmed : raw;
}

/** Maps the lift-off wire value (in tenths of a millimetre) to the shared Low/Medium/High stops. */
export function incottLiftOffLabel(tenthsMm: number): "Low" | "Medium" | "High" | null {
  if (tenthsMm === 7) return "Low";
  if (tenthsMm === 10) return "Medium";
  if (tenthsMm === 20) return "High";
  return null;
}

/** Maps a Low/Medium/High stop back to tenths of a millimetre for `incottEncodeSetLiftOff`. */
export function incottLiftOffTenths(level: "Low" | "Medium" | "High"): number {
  return level === "Low" ? 7 : level === "Medium" ? 10 : 20;
}
