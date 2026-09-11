import type { MouseStatus, MouseUiHints } from "../mouse-types.ts";
import {
  incottButtonActionCode,
  incottDecodeButtonBinding,
  incottDecodeDebounce,
  incottDecodeDpiStage,
  incottDecodeDpiCycle,
  incottDecodeIdentity,
  incottDecodeInputStatus,
  incottDecodeLiftOffDirect,
  incottDecodePerformanceMode,
  incottDecodePollingRate,
  incottDecodeReceiverLed,
  incottDecodeSleep,
  incottDecodeToggle,
  incottEncodeQuery,
  incottEncodeSetButtonBinding,
  incottEncodeSetDebounce,
  incottEncodeSetDpi,
  incottEncodeSetDpiCycle,
  incottEncodeSetLiftOff,
  incottEncodeSetPerformanceMode,
  incottEncodeSetPollingRate,
  incottEncodeSetReceiverLed,
  incottEncodeSetSleep,
  incottEncodeSetToggle,
  incottFrameMatches,
  incottIsWiredProduct,
  incottLiftOffLabel,
  incottLiftOffTenths,
  incottNormalizeProductName,
  incottPerformanceModeFromWire,
  incottPerformanceModeToWire,
  incottValidateDpi,
  INCOTT_BUTTON_ACTIONS,
  INCOTT_BUTTON_NAMES,
  INCOTT_BUTTON_WIRE_INDEX,
  INCOTT_CMD_QUERY_BUTTON,
  INCOTT_CMD_QUERY_DPI_STAGE,
  INCOTT_CMD_QUERY_DPI_STAGE_VALUE,
  INCOTT_CMD_QUERY_IDENTITY,
  INCOTT_CMD_QUERY_POLLING,
  INCOTT_CMD_QUERY_RECEIVER_LED,
  INCOTT_CMD_QUERY_SENSOR,
  INCOTT_CMD_QUERY_TIMING,
  INCOTT_DEBOUNCE_MAX_MS,
  INCOTT_DPI_DEFAULT_STAGE_PRESETS,
  INCOTT_DPI_MAX,
  INCOTT_DPI_MIN,
  INCOTT_DPI_STAGE_COUNT,
  INCOTT_DPI_STEP,
  INCOTT_INPUT_REPORT_ID,
  INCOTT_PERFORMANCE_MODE_NAMES,
  INCOTT_POLLING_STEPS_HZ,
  INCOTT_POLLING_STEPS_HZ_WIRED,
  INCOTT_PRODUCT_IDS,
  INCOTT_SLEEP_OPTIONS,
  INCOTT_REPORT_ID,
  INCOTT_RESPONSE_LENGTH,
  INCOTT_SUB_ANGLE_SNAP,
  INCOTT_SUB_DEBOUNCE,
  INCOTT_SUB_LOD,
  INCOTT_SUB_MOTION_SYNC,
  INCOTT_SUB_NONE,
  INCOTT_SUB_PERFORMANCE,
  INCOTT_SUB_RIPPLE,
  INCOTT_SUB_SLEEP,
  INCOTT_USAGE_PAGE,
  INCOTT_VENDOR_ID,
  type IncottDpiCycle,
  type IncottInputStatus,
} from "../../incott/index.ts";

type LiftOffLevel = "Low" | "Medium" | "High";

/**
 * The slice of HIDDevice this layer needs for feature-report exchanges, so
 * tests can supply a fake instead of a real WebHID device. A real HIDDevice
 * satisfies this structurally.
 */
export interface FeatureTransport {
  sendFeatureReport(reportId: number, data: BufferSource): Promise<void>;
  receiveFeatureReport(reportId: number): Promise<DataView>;
}

export interface IncottTransactionOptions {
  /** Delay between sending a request and reading the response. */
  settleMs?: number;
  /** How many reads to attempt before giving up. */
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Serializes feature-report request/response pairs for the Incott protocol.
 *
 * The device exposes a single shared response buffer, so overlapping requests
 * and leftover frames both produce values that belong to a different query —
 * probing the same query three times in separate runs returned three
 * different payloads on real hardware. Every request therefore runs alone,
 * discards whatever was already latched, and accepts a frame only when its
 * command and sub-command echo the request. Ported intact from IncottHub
 * (`src/drivers/incott/transaction.ts`), including the stale-frame regression
 * this exists to prevent — the prior-art Go implementation (IncottHIDApp)
 * matches on the command byte alone and is fooled by exactly this.
 */
export class IncottTransactionQueue {
  private readonly transport: FeatureTransport;
  private readonly settleMs: number;
  private readonly attempts: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(transport: FeatureTransport, options: IncottTransactionOptions = {}) {
    this.transport = transport;
    this.settleMs = options.settleMs ?? 50;
    this.attempts = options.attempts ?? 10;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /**
   * Sends one request and returns the matching response frame, or null when
   * no matching frame arrives. Never rejects: a device that stops answering
   * yields null so the caller can render an em dash instead of a stale value.
   */
  request(payload: Uint8Array, cmd: number, sub: number | null): Promise<Uint8Array | null> {
    const run = this.tail.then(() => this.exchange(payload, cmd, sub));
    // Keep the chain alive even if one exchange throws.
    this.tail = run.catch(() => undefined);
    return run;
  }

  /**
   * Sends a write, which the device does not answer. Queued alongside
   * requests so ordering holds, but it never reads: waiting for a response
   * that will never arrive would spend the entire attempt budget per write.
   */
  send(payload: Uint8Array): Promise<void> {
    const run = this.tail.then(async () => {
      try {
        await this.transport.sendFeatureReport(INCOTT_REPORT_ID, toArrayBuffer(payload));
      } catch {
        // A failed write surfaces as a failed read-back in the client.
      }
    });
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async exchange(
    payload: Uint8Array,
    cmd: number,
    sub: number | null,
  ): Promise<Uint8Array | null> {
    try {
      // Discard anything latched by a previous exchange before sending.
      await this.read();
      await this.transport.sendFeatureReport(INCOTT_REPORT_ID, toArrayBuffer(payload));
      for (let attempt = 0; attempt < this.attempts; attempt += 1) {
        if (this.settleMs > 0) await this.sleep(this.settleMs);
        const frame = await this.read();
        if (frame && incottFrameMatches(frame, cmd, sub)) return frame;
      }
      return null;
    } catch {
      return null;
    }
  }

  private async read(): Promise<Uint8Array | null> {
    try {
      const view = await this.transport.receiveFeatureReport(INCOTT_REPORT_ID);
      const out = new Uint8Array(INCOTT_RESPONSE_LENGTH);
      const length = Math.min(view.byteLength, INCOTT_RESPONSE_LENGTH);
      for (let index = 0; index < length; index += 1) out[index] = view.getUint8(index);
      return out;
    } catch {
      return null;
    }
  }
}

/**
 * Sends the identity query (`09 8f 00`) directly against a transport and
 * checks for a well-formed reply — byte 0 the report id (`0x09`), byte 1 the
 * echoed command (`0x8f`). Never throws: a transport whose `sendFeatureReport`
 * rejects, or that answers with something else entirely, both resolve to
 * `false` (via `IncottTransactionQueue`'s own catch-and-return-null path),
 * exactly like a device that is not there.
 *
 * WHY THIS EXISTS (BUG, hardware-verified 2026-09-08): wired, the mouse
 * exposes TWO top-level collections on usage page `0xFF05` on the same
 * interface — identical as far as vendor/product id and usage page go — but
 * only one of them actually answers feature reports. The other rejects every
 * one at the OS level (`HidD_SetFeature: (0x00000001) Incorrect function` on
 * Windows). Usage page alone cannot tell them apart; only sending something
 * and checking for a real reply can. See `incottSelectCollection` for the
 * ordered probe-and-pick algorithm this backs, and the comment on
 * `IncottHidClient.open()` for why a WebHID-based client can only apply this
 * to the single collection it was handed, not choose between two.
 */
export async function incottProbeCollection(
  transport: FeatureTransport,
  options?: IncottTransactionOptions,
): Promise<boolean> {
  const queue = new IncottTransactionQueue(transport, options);
  const frame = await queue.request(
    incottEncodeQuery(INCOTT_CMD_QUERY_IDENTITY, INCOTT_SUB_NONE),
    INCOTT_CMD_QUERY_IDENTITY,
    null,
  );
  return frame !== null && frame[0] === INCOTT_REPORT_ID && frame[1] === INCOTT_CMD_QUERY_IDENTITY;
}

/**
 * Picks the first candidate transport whose collection actually answers the
 * identity probe, trying candidates in the given order and moving on to the
 * next one when a candidate throws, never replies, or replies with garbage.
 * Returns `null` when no candidate answers.
 *
 * Candidates must be pre-ordered by the CALLER, most likely first — this
 * function only probes in the order it is given, it does not itself inspect
 * usage pages. This is the general form of the wired dead-collection fix
 * (see `incottProbeCollection`): a transport layer that genuinely has more
 * than one candidate to try (for example a Node-hid-based tool with access
 * to every top-level collection's own path) can use this directly. WebHID
 * cannot: it hands `IncottHidClient` exactly one `HIDDevice` per collection,
 * already chosen by the browser's picker/filters before this driver ever
 * sees it, so `IncottHidClient.open()` uses `incottProbeCollection` on
 * itself instead of calling this with more than one candidate.
 */
export async function incottSelectCollection<T extends FeatureTransport>(
  candidates: readonly T[],
  options?: IncottTransactionOptions,
): Promise<T | null> {
  for (const candidate of candidates) {
    try {
      if (await incottProbeCollection(candidate, options)) return candidate;
    } catch {
      // Move on to the next candidate.
    }
  }
  return null;
}

/**
 * Byte 2 echoes the sub-command for the DPI-stage-value, sensor and timing
 * queries, so it must be matched there. For polling, receiver LED and
 * identity it carries data instead, and matching it would reject valid
 * responses (every polling rate but 1000 Hz, every LED mode but 0, and
 * identity entirely).
 *
 * `0x82` (DPI stage value) was added on 2026-09-08, confirmed directly on
 * hardware: `09 82 03` replies `09 82 03 …`. `0x81` (polling) was
 * DELIBERATELY re-confirmed NOT to belong here on the same date: writing wire
 * `1` then wire `0` and reading back showed byte 2 of the `0x81` reply follow
 * the write (`0 -> 1 -> 0`) — it is data, not an echoed sub-command, and
 * matching it as one would reject every polling rate but 1000 Hz.
 *
 * `0x8e` (battery) used to be registered here (added 2026-09-07 alongside the
 * original, now-disproven DPI/battery corrections — see
 * `INCOTT_CMD_QUERY_BATTERY`) but this driver no longer queries `0x8e` for
 * anything: battery is read from the mouse's unsolicited input report
 * instead (see `onInputReport` below), so there is no live query left for
 * this list to matter to. `incottDecodeBattery`'s own frame-matching in
 * `src/incott/index.ts` is unaffected by this list either way.
 *
 * `0x86` echoes the button index in the same position, and MUST stay in this
 * list now that buttons are read: six reads go out back to back, and the
 * device latches a single shared response buffer, so matching on the command
 * byte alone would let button 2's reply satisfy button 3's request.
 *
 * `0x83` WAS in this list and has been removed. Its byte 2 is the DPI stage
 * COUNT, not an echo — `09 83 00` answers `09 83 06 01` — so treating it as
 * one only worked because this contributor's mouse has a six-stage cycle and
 * the driver happened to send `06`. On a mouse configured for four stages
 * every DPI read would have been rejected. See
 * `INCOTT_DPI_STAGE_COUNT_DEFAULT`.
 */
const SUB_ECHOING_QUERIES: readonly number[] = [
  INCOTT_CMD_QUERY_DPI_STAGE_VALUE,
  INCOTT_CMD_QUERY_SENSOR,
  INCOTT_CMD_QUERY_TIMING,
  INCOTT_CMD_QUERY_BUTTON,
];

function toggleWord(value: boolean | null): string {
  return value === null ? "an unreadable state" : value ? "on" : "off";
}

/**
 * WebHID client for the Incott protocol (vendor 0x093A, products 0x522C /
 * 0x622C). Ported from IncottHub, adapted to mouse-protocol's driver
 * interface: the client owns `device`, `open()` and `close()` directly
 * instead of taking an externally-managed transport, matching every other
 * driver in this registry.
 *
 * FOUR bugs fixed 2026-09-08 from an owner's hardware probes in BOTH wireless
 * and wired modes (see `docs/incott-testing.md`):
 *
 *   1. WIRED MODE WAS COMPLETELY BROKEN. The wired mouse exposes two
 *      identical-looking `0xFF05` collections; only one answers feature
 *      reports, and usage page alone cannot tell them apart. See `open()`'s
 *      identity probe and `incottProbeCollection`/`incottSelectCollection`.
 *   2. `0x622C` means the connection is WIRED, not "charging" — charging is
 *      a consequence of being plugged in, not what the id encodes. See
 *      `incottIsWiredProduct` (renamed from `incottIsChargingProduct`) and
 *      `MouseStatus.connectionType` below.
 *   3. The polling-rate ceiling depends on the connection: the full
 *      125-8000 Hz ladder is wireless-only, and the mouse only reaches
 *      1000 Hz over the cable — see `INCOTT_POLLING_STEPS_HZ_WIRED`.
 *   4. The real model name ("Esports G23V2Pro") is only in the WIRED product
 *      string; wireless reports a generic name with no model in it at all.
 *      See `incottNormalizeProductName`.
 *
 * Polling rate (0x81) is verified readable on hardware, but `readStatus()`
 * must not throw (see the write-a-driver doc): when it cannot be read after
 * the transaction queue's full retry budget, the client falls back to an
 * identity-only status — real `name`, `brand`, and whatever else was
 * genuinely readable — with `ui.settingsReady: false` and
 * `ui.valuesVerified: false` so the app hides the settings grid instead of
 * rendering fabricated values. `MouseStatus.pollingRateHz` is non-nullable,
 * so the degraded path still assigns it a number; see the comment at that
 * assignment for why that is not a fabricated reading.
 *
 * DPI USED to have no known read-back at all; that changed 2026-09-08. DPI
 * lives in a six-stage table (see `INCOTT_DPI_STAGE_COUNT` in
 * `src/incott/index.ts`) with FOUR independent operations, not one:
 *
 *   which stage is active   read: `0x83`/`0x06`     write: `0x03`/`0x06 <idx>`
 *   what a stage holds      read: `0x82`/`<stage>`  write: `0x02 <stage> <lo> <hi>`
 *
 * `readStatus()` reads which stage is active (`incottDecodeDpiStageIndex`)
 * and every one of the six stages' stored values (`incottDecodeDpiStage`),
 * populating `dpiStages`/`activeDpiStage` for OpenMouse's shared multi-stage
 * DPI editor (`MouseUiHints.dpiStageEditor`) and deriving `dpi` as the active
 * stage's own value — a genuine live read, not a write cache.
 *
 * `setActiveDpiStage()` and `setDpiStageValue()` map onto the select and edit
 * operations above respectively, matching OpenMouse's existing generic
 * contract (`requireClientMethod` in `openmouse/src/device/controller.ts`).
 * `setDpi()` is kept for the plain preset row and is defined as "set the
 * ACTIVE stage's value" — i.e. it is exactly `setDpiStageValue` at whichever
 * stage is currently active — since that is the only meaning left for it now
 * that a real select operation exists.
 *
 * A SECOND DPI BUG, found from an owner report and fixed the same day
 * (2026-09-08): `setDpi()` used to be the *only* way to touch DPI, so the app
 * called it every time the user picked a value from the plain preset row —
 * indistinguishable, from the user's point of view, from "select the stage
 * that already holds this value." It never did that: it read the active
 * stage and overwrote *that* stage's stored value with whatever was picked,
 * one stage at a time destroying the mouse's factory-programmed table.
 * (IncottHIDApp's own `0x03`/`0x06` write — which that project mislabels "set
 * DPI" — is actually the active-stage SELECT and never touches the table;
 * see `INCOTT_CMD_SET_DPI_STAGE` in `src/incott/index.ts`.) Wiring
 * `dpiStages`/`activeDpiStage`/`dpiStageEditor` here gives the app a real
 * select control (`setActiveDpiStage`) so `setDpi` is no longer asked to do a
 * select's job.
 *
 * `valuesVerified` is true once both the polling-rate query and the active
 * stage's DPI read have answered — see `readStatus()`.
 *
 * A FIFTH bug, fixed 2026-09-08: battery used to be read from the `0x8e`
 * feature-report reply, byte 6. Charging a unit through a full cycle (roughly
 * 60% to roughly 97%) while polling that reply showed byte 6 never move at
 * all — a constant, not a live reading, the same failure mode `0x89` byte 8
 * suffered before it (see `INCOTT_CMD_QUERY_BATTERY` in
 * `src/incott/index.ts`). The real battery level lives in an UNSOLICITED
 * INPUT report the mouse emits on report id 0x09 while it is actively being
 * used — see `onInputReport` below and `incottDecodeInputStatus`. The device
 * only emits these while in use, so `readStatus()` reports `batteryPercent:
 * null` / `batteryState: "Unknown"` until the first one arrives; nothing here
 * fabricates a number or falls back to the disproven feature-report bytes.
 * `batteryState`'s charging flag comes from the report's own high bit
 * (`raw > 100`), not from the product id: `incottIsWiredProduct` (0x622C)
 * still means the CONNECTION is wired, which is what `connectionType` below
 * uses, and being wired does imply charging in practice, but the input report
 * is the authoritative source for the charging state, not an inference from
 * the product id.
 *
 * A SIXTH addition, 2026-09-10: performance mode (HP/Corded/LP) is now wired
 * into OpenMouse's shared `powerModes`/`powerMode`/`setPowerMode` contract.
 * The value-to-label mapping was hardware-confirmed by labelling every click
 * in the vendor tool before recording its write — see `getPowerModes`,
 * `setPowerMode`, and `INCOTT_SUB_PERFORMANCE` in `src/incott/index.ts` for
 * the capture and the REVERSED-vs-UI warning (HP=2, Corded=1, LP=0). `readStatus()`
 * populates `powerMode` from a live `0x84`/`0x05` read, leaving it `undefined`
 * (never fabricated) when the collection is dead or the read fails.
 */
export class IncottHidClient {
  readonly device: HIDDevice;
  private readonly queue: IncottTransactionQueue;
  /**
   * Cached decode of the mouse's unsolicited input report (battery plus a
   * packed DPI-stage/polling-rate snapshot) — see `onInputReport` and the
   * class comment's battery section. `null` until the first report arrives
   * (the mouse only emits them while actively in use), which is exactly when
   * `readStatus()` must report `batteryPercent: null` / `batteryState:
   * "Unknown"` rather than a fabricated value.
   */
  private lastInputStatus: IncottInputStatus | null = null;
  /**
   * Whether `open()`'s identity probe got a well-formed reply from the
   * collection WebHID handed this client. `null` until `open()` runs (every
   * unit test that skips `open()` and calls `readStatus()` directly keeps
   * this `null`, so it behaves exactly as before this field existed);
   * `false` means this specific collection is the wired mouse's dead
   * look-alike (see the class comment and `open()`).
   */
  private collectionVerified: boolean | null = null;

  constructor(device: HIDDevice, options?: IncottTransactionOptions) {
    this.device = device;
    // A real HIDDevice satisfies FeatureTransport structurally.
    this.queue = new IncottTransactionQueue(device, options);
  }

  /**
   * Decodes the mouse's unsolicited input report and caches the result for
   * `readStatus()` — see the class comment's battery section and
   * `incottDecodeInputStatus` in `src/incott/index.ts`.
   *
   * BYTE-INDEX CONVENTION: WebHID's `inputreport` event carries `reportId`
   * separately from `data`, and `data` EXCLUDES the report id — unlike this
   * driver's feature-report frames, which include it because
   * `receiveFeatureReport` returns it at byte 0 (see the top-of-file comment
   * in `src/incott/index.ts` for that asymmetry, which this mirrors). So
   * `event.data.getUint8(0)`/`getUint8(1)` are this report's bytes 1/2 in
   * node-hid terms — node-hid's raw buffer includes the report id at index 0,
   * which is how `captures/incott-8k-wireless/input-report-battery.hex` is
   * indexed. Get this backwards and every field reads off by one byte.
   *
   * Filtered to report id `INCOTT_INPUT_REPORT_ID` (0x09): the mouse's other
   * HID collections (mouse/keyboard boot reports, etc.) are not this vendor
   * collection's traffic and must not be mistaken for it.
   */
  private readonly onInputReport = (event: HIDInputReportEvent): void => {
    if (event.reportId !== INCOTT_INPUT_REPORT_ID) return;
    if (event.data.byteLength < 2) return;
    const decoded = incottDecodeInputStatus(event.data.getUint8(0), event.data.getUint8(1));
    if (decoded) this.lastInputStatus = decoded;
  };

  /**
   * Usage page alone cannot tell the wired mouse's two look-alike `0xFF05`
   * collections apart (see the class comment and `open()`), so this stays
   * permissive on purpose: it accepts ANY device on a vendor-defined usage
   * page with a matching product id, including the one that turns out to be
   * the dead collection. Rejecting it here would also reject the live one,
   * since WebHID hands this method one collection at a time and both look
   * identical from `vendorId`/`productId`/`usagePage` alone. The actual
   * distinction is made by probing after `open()` — see `open()` and
   * `readStatus()`'s graceful degradation when the probe fails.
   */
  static isSupported(device: HIDDevice): boolean {
    if (device.vendorId !== INCOTT_VENDOR_ID) return false;
    if (!INCOTT_PRODUCT_IDS.includes(device.productId)) return false;
    // Require BOTH the vendor page and a declared feature report `0x09`. The
    // mouse exposes several vendor collections and only this one speaks the
    // protocol: enumerated on hardware 2026-09-10, page 0xFF05 declares
    // feature report 0x09, while 0xFF00 declares 0x03 and 0xFF01 declares
    // 0x04. Matching on the usage page alone (or on any page >= 0xFF00)
    // claims those siblings too, so the app lists the mouse once per
    // collection and every card but one is inert.
    return device.collections.some(
      (collection) =>
        collection.usagePage === INCOTT_USAGE_PAGE &&
        collection.featureReports.some((report) => report.reportId === INCOTT_REPORT_ID),
    );
  }

  /**
   * WebHID request filters for the vendor collection, one per product id —
   * both the wireless dongle's `0x522C` (`INCOTT_PRODUCT_ID`) and the wired
   * `0x622C` (`INCOTT_PRODUCT_ID_WIRED`), hardware-verified 2026-09-08, so
   * the picker offers the mouse in either mode.
   */
  static get filters(): HIDDeviceFilter[] {
    return INCOTT_PRODUCT_IDS.map((productId) => ({
      vendorId: INCOTT_VENDOR_ID,
      productId,
      usagePage: INCOTT_USAGE_PAGE,
    }));
  }

  /**
   * The real writable range: 50-45000 DPI in steps of 50 (see `INCOTT_DPI_MIN`
   * in `src/incott/index.ts`), returned densely so the shell's custom-DPI
   * entry (which validates by exact membership, not by snapping to a nearby
   * value) accepts any value in range — the same pattern already used for
   * Razer's Viper V4 Pro (`100-50,000 in 50-DPI increments`) and for
   * Zaunkoenig and Finalmouse. This is deliberately NOT
   * `INCOTT_DPI_DEFAULT_STAGE_PRESETS` (the six round numbers the vendor
   * calls default stage presets) — that list is too sparse for the shell to
   * let a user dial in, say, 12000 DPI, which this mouse genuinely supports.
   */
  getDpiOptions(): number[] {
    const count = (INCOTT_DPI_MAX - INCOTT_DPI_MIN) / INCOTT_DPI_STEP + 1;
    return Array.from({ length: count }, (_, index) => INCOTT_DPI_MIN + index * INCOTT_DPI_STEP);
  }

  /** The vendor's six default DPI stage presets — a convenience list, not the writable range. See `INCOTT_DPI_DEFAULT_STAGE_PRESETS`. */
  getDpiDefaultStagePresets(): number[] {
    return [...INCOTT_DPI_DEFAULT_STAGE_PRESETS];
  }

  /** Longest debounce the firmware accepts, in milliseconds (verified: section 8 of the IncottHub spec). */
  getDebounceMaxMs(): number {
    return INCOTT_DEBOUNCE_MAX_MS;
  }

  /** The firmware accepts any integer 0-30 ms, so every value in range is offered. */
  getDebounceOptions(): number[] {
    return Array.from({ length: INCOTT_DEBOUNCE_MAX_MS + 1 }, (_, ms) => ms);
  }

  /** Curated presets within the verified 1-900s sleep-timer range; see INCOTT_SLEEP_OPTIONS. */
  getSleepOptions(): number[] {
    return [...INCOTT_SLEEP_OPTIONS];
  }

  /**
   * Opens the device, then PROBES it with the identity query before trusting
   * it for anything else — see `incottProbeCollection`.
   *
   * WIRED-MODE BUG, hardware-verified 2026-09-08: the wired mouse exposes
   * two `0xFF05` collections on the same interface that are indistinguishable
   * by vendor id, product id, or usage page; only one of them answers
   * feature reports at all (the other fails every `HidD_SetFeature` call at
   * the OS level). WebHID hands this client exactly ONE `HIDDevice`, already
   * chosen by the browser's picker/filters before this driver ever sees
   * it — a WebHID `HIDDevice` corresponds to a single collection, so there is
   * no second candidate here for this method to fall back to the way
   * `incottSelectCollection` can for a transport with real alternatives. All
   * `open()` CAN do in the browser is find out, immediately and cheaply,
   * whether the one collection it got is the live one.
   *
   * This never throws on a dead collection — it records the result in
   * `collectionVerified` instead. `readStatus()` checks that flag and skips
   * straight to a fully degraded, `ui.settingsReady: false` status (see
   * there) rather than burning the full retry budget on roughly a dozen
   * queries that a collection already known to be dead cannot answer either.
   *
   * Also attaches `onInputReport` (see the class comment's battery section):
   * the mouse's battery lives only in an unsolicited input report it emits
   * while actively in use, and WebHID delivers those solely as `inputreport`
   * events on the device — there is no way to poll for one, so the listener
   * must be attached here, before the device is ever read, or an in-use
   * report could arrive and be missed before anything is listening.
   */
  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
    this.device.addEventListener("inputreport", this.onInputReport);
    const identity = incottDecodeIdentity(await this.query(INCOTT_CMD_QUERY_IDENTITY, INCOTT_SUB_NONE));
    this.collectionVerified = identity !== null;
  }

  async close(): Promise<void> {
    this.device.removeEventListener("inputreport", this.onInputReport);
    if (this.device.opened) await this.device.close();
  }

  async readStatus(): Promise<MouseStatus> {
    // `connectionType`/`batteryState` derive from the product id, which is a
    // USB descriptor field read at enumeration time — genuinely available
    // even when the collection this client was handed turns out to be the
    // wired mouse's dead one (see `open()`). Hardware-verified 2026-09-08:
    // 0x622C enumerates ONLY when plugged in over USB; 0x522C is the 2.4 GHz
    // dongle. This used to be read as a "charging" flag
    // (`incottIsChargingProduct`) — the wrong axis: 0x622C means the
    // CONNECTION is wired, and charging is a consequence of that, not what
    // the id itself encodes. See `incottIsWiredProduct`.
    const wired = incottIsWiredProduct(this.device.productId);
    // Fallback display name only — the model read from the device wins where
    // one is available, and `name` is settled below once the identity query
    // has answered. The product string names a model over the cable
    // ("incott Esports G23V2Pro mouse") but is a generic "incott 8K wireless
    // mouse" on the dongle, so it cannot be the primary source. `this.device`
    // stays public, so `client.device.productName` remains available as the
    // untouched raw string for anything that wants it.
    const rawName = this.device.productName || "Incott wireless mouse";

    // WIRED-MODE BUG, hardware-verified 2026-09-08 (see `open()`'s class
    // comment): when `open()`'s identity probe found this collection dead,
    // every one of the ~12 queries below would fail too, each only after
    // burning its own retry budget. Skip straight to the degraded values
    // instead of paying that cost for a foregone conclusion. `dead` stays
    // `false` (not just falsy) whenever `open()` was never called or its
    // probe succeeded, so every existing caller that reads status without
    // opening first is unaffected.
    const dead = this.collectionVerified === false;

    // DPI is a genuine live read as of 2026-09-08 (see the class comment
    // above): read which of the six stages is active, then every stage's own
    // value. Per the driver's graceful-degradation contract, a device that
    // stops answering yields `dpi: null` / an omitted `dpiStages` here rather
    // than throwing or fabricating a value.
    // One query answers both how many stages the cycle uses and which is
    // live — see `incottDecodeDpiCycle`. The count is NOT assumed to be six:
    // it is written back verbatim by every stage select, and publishing six
    // rows for a four-stage cycle would offer stages the mouse never visits.
    const dpiCycle = dead
      ? null
      : incottDecodeDpiCycle(await this.query(INCOTT_CMD_QUERY_DPI_STAGE, INCOTT_SUB_NONE));
    const activeDpiStage = dpiCycle?.active ?? null;
    // Six sequential queries, deliberately NOT parallelized: the device has a
    // single shared response buffer (see `IncottTransactionQueue`'s class
    // comment), and concurrent requests would corrupt each other's replies.
    // `this.query` already serializes through that queue, so a plain
    // sequential loop is enough.
    const dpiStageReads: Array<number | null> = [];
    for (let stage = 0; stage < INCOTT_DPI_STAGE_COUNT; stage += 1) {
      dpiStageReads.push(
        dead ? null : incottDecodeDpiStage(await this.query(INCOTT_CMD_QUERY_DPI_STAGE_VALUE, stage), stage),
      );
    }
    // `dpiStages` is populated only when every one of the six stages
    // answered — a partial table is never fabricated with a placeholder for
    // the stage(s) that did not. It is then trimmed to the stages the cycle
    // actually uses: the device keeps all six stored values, but the ones
    // past `count` are not in the rotation and must not be offered as if
    // they were.
    const dpiStages = dpiStageReads.every((value): value is number => value !== null)
      ? dpiStageReads.slice(0, dpiCycle?.count ?? dpiStageReads.length)
      : null;
    const dpi = activeDpiStage === null ? null : dpiStageReads[activeDpiStage] ?? null;
    const pollingRateHz = dead
      ? null
      : incottDecodePollingRate(await this.query(INCOTT_CMD_QUERY_POLLING, INCOTT_SUB_NONE));
    // The polling-rate (0x81) query is verified readable on hardware, but a
    // device that stops answering must not throw readStatus() — the app
    // degrades to identity-only fields instead (see `ui.settingsReady`
    // below). `valuesVerified` also requires the active DPI stage's value to
    // have answered.
    const valuesVerified = dpi !== null && pollingRateHz !== null;

    // Symmetric single-purpose reads, preferred over the packed byte-7
    // nibble trick (`incottDecodeLiftOff`/`incottDecodeMotionSync`, still
    // exported and tested): verified on hardware 2026-09-08 that both forms
    // agree at every step (lift-off hw 0/1/2, motion sync 0/1/0).
    const liftOffTenths = dead
      ? null
      : incottDecodeLiftOffDirect(await this.query(INCOTT_CMD_QUERY_SENSOR, INCOTT_SUB_LOD));
    const motionSync = dead
      ? null
      : incottDecodeToggle(await this.query(INCOTT_CMD_QUERY_SENSOR, INCOTT_SUB_MOTION_SYNC), INCOTT_SUB_MOTION_SYNC);
    const rippleControl = dead
      ? null
      : incottDecodeToggle(await this.query(INCOTT_CMD_QUERY_SENSOR, INCOTT_SUB_RIPPLE), INCOTT_SUB_RIPPLE);
    const angleSnapping = dead
      ? null
      : incottDecodeToggle(await this.query(INCOTT_CMD_QUERY_SENSOR, INCOTT_SUB_ANGLE_SNAP), INCOTT_SUB_ANGLE_SNAP);
    // Performance mode (HP/Corded/LP), hardware-confirmed 2026-09-10 — see
    // `INCOTT_SUB_PERFORMANCE` and `setPowerMode`. A live read of the raw wire
    // value, converted to its display name through `incottPerformanceModeFromWire`
    // (the single table the value-to-label reversal lives in). `undefined`,
    // never fabricated, when the collection is dead or the read fails/returns
    // an out-of-range value.
    const powerModeWire = dead
      ? null
      : incottDecodePerformanceMode(await this.query(INCOTT_CMD_QUERY_SENSOR, INCOTT_SUB_PERFORMANCE));
    const powerMode = powerModeWire === null ? undefined : incottPerformanceModeFromWire(powerModeWire) ?? undefined;
    const debounceMs = dead
      ? null
      : incottDecodeDebounce(await this.query(INCOTT_CMD_QUERY_TIMING, INCOTT_SUB_DEBOUNCE));
    const sleepTimeout = dead
      ? null
      : incottDecodeSleep(await this.query(INCOTT_CMD_QUERY_TIMING, INCOTT_SUB_SLEEP));
    // Battery comes from `lastInputStatus` — the mouse's unsolicited input
    // report, cached by `onInputReport` — NOT from a feature-report query.
    // Deliberately independent of `dead`/the feature-report collection probe:
    // the input report arrives on the device regardless of whether this
    // client's feature-report collection turned out to be the wired mouse's
    // dead look-alike (see `open()`), so a dead collection must not suppress
    // a battery reading that genuinely came in. `null` here means "no report
    // has arrived yet" (the mouse only emits them while actively in use), not
    // a failed read — see the class comment's battery section and
    // `incottDecodeInputStatus` in `src/incott/index.ts`. This REPLACES the
    // disproven `0x8e`/sub `0x01` byte-6 read (itself a replacement for the
    // also-disproven `0x89` byte 8) — see `INCOTT_CMD_QUERY_BATTERY` and
    // `incottDecodeBattery`, both kept only as codecs/regression coverage.
    const batteryPercent = this.lastInputStatus?.batteryPercent ?? null;
    // The charging bit comes from the input report itself (raw > 100), not
    // from the product id: `wired` (0x622C) is a genuinely reliable signal
    // that being charged is *likely* (the mouse is plugged into USB), but the
    // report is the authoritative source for whether it actually is charging
    // right now, so it is used here instead of inferring the state from the
    // connection.
    const batteryCharging = this.lastInputStatus?.charging ?? null;
    // The identity reply carries the model, the sensor and the receiver type
    // — see `incottDecodeIdentity` for the byte map. The raw hex is still
    // published under `firmware` below, because the remaining bytes (7-8) are
    // genuinely undecoded and a capture of them is what a second model's
    // owner would need to send.
    const identity = dead
      ? null
      : incottDecodeIdentity(await this.query(INCOTT_CMD_QUERY_IDENTITY, INCOTT_SUB_NONE));

    // The model READ FROM THE DEVICE is preferred over the product string:
    // it is the only source that works on the 2.4 GHz dongle, where the
    // product string has no model in it. All six Incott models share the
    // same two product ids, so this is the only thing that tells them apart
    // at all. Falls back to the tidied product string whenever the identity
    // query failed or returned a model code outside the known table — an
    // unrecognised model reports whatever the device called itself rather
    // than a guess.
    const name = identity?.displayName ?? incottNormalizeProductName(rawName);

    // The owner confirmed on hardware that the mouse only reaches 1000 Hz
    // over the cable — 2000/4000/8000 Hz are wireless-only (see
    // `INCOTT_POLLING_STEPS_HZ_WIRED`). Publishing the full ladder while
    // wired would let the shell offer a rate the device silently refuses,
    // which `setPollingRate`'s read-back verification would then report as a
    // failure on every attempt.
    const supportedPollingRates = wired ? [...INCOTT_POLLING_STEPS_HZ_WIRED] : [...INCOTT_POLLING_STEPS_HZ];

    // All six bindings, or nothing. A partial read would render some buttons
    // with a real assignment and the rest with a fabricated default, which is
    // worse than hiding the remapper: the shared UI writes back whatever it
    // shows, so a wrong reading becomes a wrong write the moment anything
    // else on the card is changed.
    const buttonMappings = dead ? null : await this.readButtonMappings();

    const ui: MouseUiHints = {
      family: "incott",
      // The advanced section is the only place debounce, sleep, motion sync,
      // angle snapping and ripple control render; Incott has no lighting and
      // no onboard profiles, so those cards stay hidden on their own
      // (nothing populates the fields that gate them).
      showAdvancedSection: true,
      // No command reports link quality.
      hideSignalCard: true,
      defaultDisplayName: name,
      // false only when the DPI and/or polling-rate query failed above (this
      // includes the wired dead-collection fast path, since every query is
      // forced to `null` there too); the app hides the settings grid rather
      // than render the placeholder numbers assigned to `dpi`/`pollingRateHz`
      // below in that case.
      settingsReady: valuesVerified,
      valuesVerified,
      // OpenMouse's device-overview card (App.tsx) hides the battery column
      // outright for a wired connection unless either a real percent is
      // already known OR this flag is set — a sane default for mice with no
      // battery at all while corded, but WRONG here: this mouse has an
      // internal battery it charges over the same USB cable, and until the
      // first unsolicited input report arrives (see the class comment's
      // battery section) `batteryPercent` is genuinely `null` regardless of
      // connection. Without this flag a freshly connected wired unit would
      // show no battery card at all instead of the em dash the app renders
      // for a null percent; with it, the card always shows (em dash first,
      // then the real reading once a report arrives).
      forceShowBattery: true,
      // The mouse cannot accept a rate outside `supportedPollingRates` for
      // its current connection, so hide the ones it would refuse rather than
      // let the shell offer a write that read-back verification would then
      // report as failed.
      hideUnsupportedPollingRates: true,
      pollingNote: wired
        ? "Up to 1,000 Hz over the cable; 8,000 Hz needs the wireless dongle."
        : "Up to 8,000 Hz wireless; 1,000 Hz over the cable.",
      // Set only when open()'s probe found this specific collection dead —
      // see the class comment on `open()`. Wired mice expose a second,
      // identical-looking 0xFF05 collection that never answers; WebHID hands
      // this client one collection at a time and cannot pick between them,
      // so the only remedy today is to reconnect and hope the browser offers
      // the other one.
      ...(dead
        ? { statusNote: "This HID collection never answered — wired mice expose a second, identical-looking collection that does not work. Try reconnecting." }
        : {}),
      // Six FIXED stages (`countEditable: false` hides the count picker —
      // this hardware has no command to add or remove a stage). 45000 is the
      // higher of the two known PixArt sensor ceilings paired in the
      // vendor's own device definition (PAW3395: 32000, PAW3950: 45000);
      // which one is fitted to a given unit cannot currently be read, so a
      // PAW3395 unit is expected to have a write above 32000 refused by the
      // existing read-back verification in `setDpi`/`setDpiStageValue`
      // rather than this module guessing which sensor is present.
      // `countEditable` only while the cycle actually read: the count picker
      // writes through `setDpiStageCount`, which needs a real current count
      // to preserve the active stage, and offering it against an unreadable
      // one would write a guess.
      dpiStageEditor: { maxStages: INCOTT_DPI_STAGE_COUNT, countEditable: dpiCycle !== null, minDpi: INCOTT_DPI_MIN, maxDpi: INCOTT_DPI_MAX, stepDpi: INCOTT_DPI_STEP },
    };

    return {
      brand: "Incott",
      name,
      ui,
      // A genuine live read (the active stage's own value) when it
      // succeeded. Otherwise this is inert placeholder data, not a
      // fabricated reading: MouseStatus.dpi is non-nullable, so a number must
      // go here, but `ui.settingsReady: false` above means the app never
      // renders it.
      dpi: dpi ?? 0,
      // All six stages' stored values, only when every one of them answered
      // — see the loop above. Omitted (not fabricated) on a partial read.
      ...(dpiStages !== null ? { dpiStages } : {}),
      ...(activeDpiStage !== null ? { activeDpiStage } : {}),
      // Same reasoning as `dpi` above: a real reading of the polling-rate
      // query (0x81) when it succeeded, otherwise inert placeholder data
      // behind `ui.settingsReady: false`.
      pollingRateHz: pollingRateHz ?? 0,
      supportedPollingRates,
      activeProfile: null,
      connectionType: wired ? "Wired" : "Wireless",
      batteryPercent,
      // Derived from the input report's own charging bit (`batteryCharging`,
      // see above), NOT from `wired`/the product id: `0x622C` reliably means
      // the connection is wired, and being wired does imply charging, but the
      // report — when one has arrived — is the authoritative source for
      // whether the mouse is actually charging right now. "Unknown" is for
      // when no input report has arrived yet, regardless of connection.
      batteryState: batteryCharging === null ? "Unknown" : batteryCharging ? "Charging" : "Discharging",
      liftOffDistance: liftOffTenths === null ? null : incottLiftOffLabel(liftOffTenths),
      supportedLiftOffDistances: ["Low", "Medium", "High"],
      // Both fields together, or neither: the shared remapper only renders
      // when it has the current assignments AND the list of actions it may
      // write back.
      ...(buttonMappings !== null
        ? { buttonMappings, buttonOptions: INCOTT_BUTTON_ACTIONS.map(([label]) => label) }
        : {}),
      motionSync,
      rippleControl,
      angleSnapping,
      debounceMs,
      sleepTimeout,
      // Named power/performance modes (HP/Corded/LP) — see `powerModeWire`
      // above. `powerModes` is only advertised alongside a real `powerMode`
      // reading, matching MCHOSE's identical three-way mode: never claim a
      // set of options exists on a collection that just failed to answer.
      ...(powerMode !== undefined ? { powerMode, powerModes: [...INCOTT_PERFORMANCE_MODE_NAMES] } : {}),
      firmware: [identity ? `Identity ${identity.raw}` : "Identity unavailable"],
    };
  }

  /**
   * Sets the ACTIVE stage's stored DPI value — the only sane meaning left for
   * a plain "set DPI" call now that a real stage-select operation exists (see
   * `setActiveDpiStage` below and the class comment's account of the bug this
   * used to have). This is exactly `setDpiStageValue(activeStage, dpi)`;
   * confirms the write by reading that stage back, the same pattern every
   * other setter in this client uses. Range/step are validated up front,
   * before any device round-trip, so an invalid value never costs the query
   * needed to find the active stage.
   */
  async setDpi(dpi: number): Promise<number> {
    incottValidateDpi(dpi);
    const stage = (await this.readDpiCycle())?.active ?? null;
    if (stage === null) throw new Error("Could not read the active DPI stage to write.");
    await this.write(incottEncodeSetDpi(stage, dpi));
    const got = incottDecodeDpiStage(await this.query(INCOTT_CMD_QUERY_DPI_STAGE_VALUE, stage), stage);
    if (got !== dpi) throw new Error(`The mouse kept ${got ?? "an unreadable"} DPI instead of ${dpi}.`);
    return dpi;
  }

  /** Reads the DPI cycle (stage count + active stage) in one query. */
  private async readDpiCycle(): Promise<IncottDpiCycle | null> {
    return incottDecodeDpiCycle(await this.query(INCOTT_CMD_QUERY_DPI_STAGE, INCOTT_SUB_NONE));
  }

  /**
   * SELECTS which DPI stage is active (`09 03 <count> <idx>`) — distinct from
   * `setDpi`/`setDpiStageValue`, which EDIT a stage's stored value. Confirmed
   * on hardware 2026-09-08 that a select never touches any stage's stored
   * value (see `INCOTT_CMD_SET_DPI_STAGE` in `src/incott/index.ts`), so
   * unlike every value setter in this client this one reads back the active
   * index rather than a DPI value.
   *
   * The stage count is READ FIRST and written back unchanged. It shares the
   * write with the index, so sending a constant here would silently resize a
   * cycle that is not six stages long — see
   * `INCOTT_DPI_STAGE_COUNT_DEFAULT`.
   */
  async setActiveDpiStage(stage: number): Promise<number> {
    if (!Number.isInteger(stage) || stage < 0 || stage >= INCOTT_DPI_STAGE_COUNT) {
      throw new RangeError(`DPI stage out of range: ${stage}`);
    }
    const cycle = await this.readDpiCycle();
    if (cycle === null) throw new Error("Could not read the DPI stage cycle to write.");
    if (stage >= cycle.count) {
      throw new RangeError(`DPI stage ${stage} is outside this mouse's ${cycle.count}-stage cycle.`);
    }
    await this.write(incottEncodeSetDpiCycle(cycle.count, stage));
    const got = (await this.readDpiCycle())?.active ?? null;
    if (got !== stage) throw new Error(`The mouse kept DPI stage ${got ?? "an unreadable"} instead of ${stage}.`);
    return stage;
  }

  /**
   * Sets how many stages the DPI cycle rotates through (`09 03 <count>
   * <idx>`). The stored value of every stage is left alone — stages above
   * the new count keep their values and simply stop being visited.
   *
   * The active stage rides along in the same write, so it is clamped into
   * the new cycle rather than left pointing past the end.
   */
  async setDpiStageCount(count: number): Promise<number> {
    if (!Number.isInteger(count) || count < 1 || count > INCOTT_DPI_STAGE_COUNT) {
      throw new RangeError(`DPI stage count out of range: ${count}`);
    }
    const cycle = await this.readDpiCycle();
    if (cycle === null) throw new Error("Could not read the DPI stage cycle to write.");
    const active = Math.min(cycle.active, count - 1);
    await this.write(incottEncodeSetDpiCycle(count, active));
    const got = await this.readDpiCycle();
    if (got?.count !== count) {
      throw new Error(`The mouse kept ${got?.count ?? "an unreadable"} DPI stages instead of ${count}.`);
    }
    return count;
  }

  /**
   * EDITS one stage's stored DPI value directly, by index — unlike `setDpi`,
   * which always targets whichever stage happens to be active right now.
   * This is the write OpenMouse's shared multi-stage DPI editor uses when the
   * user edits a specific stage row rather than the active-stage preset.
   */
  async setDpiStageValue(stage: number, dpi: number): Promise<number> {
    if (!Number.isInteger(stage) || stage < 0 || stage >= INCOTT_DPI_STAGE_COUNT) {
      throw new RangeError(`DPI stage out of range: ${stage}`);
    }
    incottValidateDpi(dpi);
    await this.write(incottEncodeSetDpi(stage, dpi));
    const got = incottDecodeDpiStage(await this.query(INCOTT_CMD_QUERY_DPI_STAGE_VALUE, stage), stage);
    if (got !== dpi) throw new Error(`The mouse kept ${got ?? "an unreadable"} DPI instead of ${dpi} on stage ${stage}.`);
    return dpi;
  }

  async setPollingRate(hz: number): Promise<number> {
    await this.write(incottEncodeSetPollingRate(hz));
    const got = incottDecodePollingRate(await this.query(INCOTT_CMD_QUERY_POLLING, INCOTT_SUB_NONE));
    if (got !== hz) throw new Error(`The mouse kept ${got ?? "an unreadable"} Hz instead of ${hz} Hz.`);
    return hz;
  }

  async setLiftOffDistance(level: LiftOffLevel): Promise<LiftOffLevel> {
    const tenths = incottLiftOffTenths(level);
    await this.write(incottEncodeSetLiftOff(tenths));
    // Symmetric single-purpose read (`0x84`/`0x01`), preferred over the
    // packed byte-7 nibble form — see the comment in `readStatus()`.
    const gotTenths = incottDecodeLiftOffDirect(await this.query(INCOTT_CMD_QUERY_SENSOR, INCOTT_SUB_LOD));
    const got = gotTenths === null ? null : incottLiftOffLabel(gotTenths);
    if (got !== level) {
      throw new Error(`The mouse kept a ${got ?? "unreadable"} lift-off distance instead of ${level}.`);
    }
    return level;
  }

  async setMotionSync(on: boolean): Promise<boolean> {
    await this.write(incottEncodeSetToggle("motionSync", on));
    // Symmetric single-purpose read (`0x84`/`0x04`), preferred over the
    // packed byte-7 nibble form — see the comment in `readStatus()`.
    const got = incottDecodeToggle(
      await this.query(INCOTT_CMD_QUERY_SENSOR, INCOTT_SUB_MOTION_SYNC),
      INCOTT_SUB_MOTION_SYNC,
    );
    if (got !== on) throw new Error(`The mouse kept Motion Sync ${toggleWord(got)} instead of ${on ? "on" : "off"}.`);
    return on;
  }

  async setAngleSnapping(on: boolean): Promise<boolean> {
    await this.write(incottEncodeSetToggle("angleSnapping", on));
    const got = incottDecodeToggle(
      await this.query(INCOTT_CMD_QUERY_SENSOR, INCOTT_SUB_ANGLE_SNAP),
      INCOTT_SUB_ANGLE_SNAP,
    );
    if (got !== on) throw new Error(`The mouse kept angle snapping ${toggleWord(got)} instead of ${on ? "on" : "off"}.`);
    return on;
  }

  async setRippleControl(on: boolean): Promise<boolean> {
    await this.write(incottEncodeSetToggle("rippleControl", on));
    const got = incottDecodeToggle(
      await this.query(INCOTT_CMD_QUERY_SENSOR, INCOTT_SUB_RIPPLE),
      INCOTT_SUB_RIPPLE,
    );
    if (got !== on) throw new Error(`The mouse kept ripple control ${toggleWord(got)} instead of ${on ? "on" : "off"}.`);
    return on;
  }

  async setDebounceTime(ms: number): Promise<number> {
    await this.write(incottEncodeSetDebounce(ms));
    const got = incottDecodeDebounce(await this.query(INCOTT_CMD_QUERY_TIMING, INCOTT_SUB_DEBOUNCE));
    if (got !== ms) throw new Error(`The mouse kept ${got ?? "an unreadable"} ms debounce instead of ${ms} ms.`);
    return ms;
  }

  async setSleepTimeout(seconds: number): Promise<number> {
    await this.write(incottEncodeSetSleep(seconds));
    const got = incottDecodeSleep(await this.query(INCOTT_CMD_QUERY_TIMING, INCOTT_SUB_SLEEP));
    if (got !== seconds) {
      throw new Error(`The mouse kept a ${got ?? "an unreadable"} s sleep timer instead of ${seconds} s.`);
    }
    return seconds;
  }

  /**
   * Not called generically by the app (no shared receiver-LED control exists
   * yet), kept for protocol parity with IncottHub.
   *
   * NOTE for whoever wires this up: the receiver LED is a property of the
   * 2.4 GHz dongle and is meaningless when `incottIsWiredProduct(device.productId)`
   * is true (checked 2026-09-08) — there is no dongle in that mode. Checked
   * `MouseUiHints` in `src/drivers/mouse-types.ts` for an existing `hide*`
   * flag to gate this with and found none scoped to the receiver LED
   * specifically (the closest, `hideSignalCard`, is about link-quality
   * telemetry, a different control); a new hint was deliberately NOT added to
   * that shared contract for a control this driver does not yet advertise
   * anywhere. Whoever wires a shared receiver-LED control into `MouseStatus`
   * should either add a scoped `hide*` flag there at that time, or simply
   * omit the wiring outright when wired, matching the other wireless-only
   * behavior in this driver (see `INCOTT_POLLING_STEPS_HZ_WIRED`).
   */
  /**
   * Reads all six button bindings, keyed by the physical button name.
   *
   * Returns null unless every button answered: see the call site in
   * `readStatus` for why a partial read is not published. A binding the
   * action table does not know (a keyboard key, a macro) reports its raw code
   * as `Unknown (0x...)` rather than being shown as one of the offered
   * actions — the shared remapper writes back what it displays, so labelling
   * an unknown binding as a known action would rewrite it on the next edit.
   */
  private async readButtonMappings(): Promise<Record<string, string> | null> {
    const mappings: Record<string, string> = {};
    for (const name of INCOTT_BUTTON_NAMES) {
      const index = INCOTT_BUTTON_WIRE_INDEX[name];
      const binding = incottDecodeButtonBinding(await this.query(INCOTT_CMD_QUERY_BUTTON, index), index);
      if (binding === null) return null;
      mappings[name] = binding.label ?? `Unknown (0x${binding.code.toString(16).padStart(8, "0")})`;
    }
    return mappings;
  }

  /**
   * Reassigns one button, then reads it back and refuses to report success
   * unless the device actually took the value.
   *
   * `button` is a physical name; the wire index it maps to is NOT the same
   * number (Forward and Back are transposed — see
   * `INCOTT_BUTTON_WIRE_INDEX`). This is a standalone command, so it cannot
   * disturb DPI, polling or the other five buttons.
   */
  async setButtonMapping(button: string, actionLabel: string): Promise<void> {
    const name = INCOTT_BUTTON_NAMES.find((candidate) => candidate === button);
    if (name === undefined) throw new Error(`This mouse has no "${button}" button.`);
    const code = incottButtonActionCode(actionLabel);
    if (code === null) throw new Error(`Unknown button action "${actionLabel}".`);

    const index = INCOTT_BUTTON_WIRE_INDEX[name];
    await this.write(incottEncodeSetButtonBinding(index, code));
    const applied = incottDecodeButtonBinding(await this.query(INCOTT_CMD_QUERY_BUTTON, index), index);
    if (applied === null) throw new Error("The mouse did not confirm the button change.");
    if (applied.code !== code) {
      throw new Error(`The mouse kept ${applied.label ?? "another binding"} on ${name} instead of ${actionLabel}.`);
    }
  }

  async setReceiverLed(mode: number): Promise<number> {
    await this.write(incottEncodeSetReceiverLed(mode));
    const got = incottDecodeReceiverLed(await this.query(INCOTT_CMD_QUERY_RECEIVER_LED, INCOTT_SUB_NONE));
    if (got !== mode) throw new Error(`The mouse kept receiver LED mode ${got ?? "unreadable"} instead of ${mode}.`);
    return mode;
  }

  /**
   * Low-level codec method: writes the RAW 0-2 performance-mode value. Kept
   * for protocol parity and as the primitive `setPowerMode` below builds on.
   * Most callers should use `setPowerMode(name)` instead, which validates a
   * name against the hardware-confirmed HP/Corded/LP mapping (see
   * `INCOTT_SUB_PERFORMANCE` in `src/incott/index.ts`) and requires a
   * matching read-back before reporting success.
   *
   * This method is intentionally more lenient than `setPowerMode`: a `null`
   * read-back (the device not answering) does not throw here, since a raw
   * numeric call has no name to validate up front and existing callers/tests
   * rely on this tolerance. See `setPowerMode` for the stricter contract.
   */
  async setPerformanceMode(mode: number): Promise<number> {
    await this.write(incottEncodeSetPerformanceMode(mode));
    const got = incottDecodePerformanceMode(
      await this.query(INCOTT_CMD_QUERY_SENSOR, INCOTT_SUB_PERFORMANCE),
    );
    if (got !== null && got !== mode) {
      throw new Error(`The mouse kept performance mode ${got} instead of ${mode}.`);
    }
    return mode;
  }

  /** See `setPerformanceMode`. Returns `null` when `0x84`/`0x05` does not answer. */
  async getPerformanceMode(): Promise<number | null> {
    return incottDecodePerformanceMode(await this.query(INCOTT_CMD_QUERY_SENSOR, INCOTT_SUB_PERFORMANCE));
  }

  /**
   * The named power/performance modes this mouse offers, in the vendor UI's
   * own left-to-right display order (HP, Corded, LP) — see
   * `INCOTT_PERFORMANCE_MODE_NAMES`. This order is deliberately NOT the wire
   * value order: see `setPowerMode` and `INCOTT_SUB_PERFORMANCE` in
   * `src/incott/index.ts` for the reversal this table exists to get right.
   */
  getPowerModes(): string[] {
    return [...INCOTT_PERFORMANCE_MODE_NAMES];
  }

  /**
   * OpenMouse's shared power/performance-mode contract
   * (`requireClientMethod("setPowerMode", …)` in
   * `openmouse/src/device/controller.ts`) — takes the mode NAME, not the raw
   * wire value. Maps name -> wire through `incottPerformanceModeToWire`
   * (`INCOTT_PERFORMANCE_MODE_TO_WIRE` in `src/incott/index.ts`), the single
   * table the HP=2/Corded=1/LP=0 reversal lives in — hardware-confirmed
   * 2026-09-10 by labelling each click in the vendor tool before recording
   * its write; see `INCOTT_SUB_PERFORMANCE`'s doc comment.
   *
   * Rejects an unknown name BEFORE writing anything (same pattern as
   * `incottValidateDpi`/`setDpi` above), then writes and requires a matching,
   * non-null read-back — unlike the lower-level `setPerformanceMode`, a
   * `null` read-back here is treated as a failure, not tolerated: every
   * setter in this driver verifies its write, and an unverifiable write must
   * report failure rather than claim success.
   */
  async setPowerMode(name: string): Promise<void> {
    const wire = incottPerformanceModeToWire(name);
    if (wire === null) {
      throw new Error(`This mouse has no "${name}" performance mode.`);
    }
    await this.write(incottEncodeSetPerformanceMode(wire));
    const got = incottDecodePerformanceMode(await this.query(INCOTT_CMD_QUERY_SENSOR, INCOTT_SUB_PERFORMANCE));
    if (got === null) {
      throw new Error(`Could not read back the performance mode to confirm ${name}.`);
    }
    if (got !== wire) {
      throw new Error(`The mouse kept performance mode ${incottPerformanceModeFromWire(got) ?? got} instead of ${name}.`);
    }
  }

  /** Queries return an all-zero frame on failure, which every decoder rejects. */
  private async query(cmd: number, sub: number): Promise<Uint8Array> {
    const matchSub = SUB_ECHOING_QUERIES.includes(cmd) ? sub : null;
    return (await this.queue.request(incottEncodeQuery(cmd, sub), cmd, matchSub)) ?? new Uint8Array(INCOTT_RESPONSE_LENGTH);
  }

  private async write(payload: Uint8Array): Promise<void> {
    await this.queue.send(payload);
  }
}

/**
 * WebHID's `sendFeatureReport` types its `data` parameter as `BufferSource`.
 * TypeScript's DOM lib makes `Uint8Array` generic over its backing buffer
 * type, defaulting a bare `Uint8Array` annotation to `Uint8Array<ArrayBufferLike>`,
 * which is not assignable to `BufferSource` (it admits `SharedArrayBuffer`).
 * Copying into a fresh array-like-constructed Uint8Array narrows the backing
 * buffer to a concrete `ArrayBuffer`, matching the pattern already used in
 * `src/drivers/corsair/hid.ts` and `src/drivers/zaunkoenig/hid.ts`.
 */
function toArrayBuffer(payload: Uint8Array): ArrayBuffer {
  return new Uint8Array(payload).buffer;
}
