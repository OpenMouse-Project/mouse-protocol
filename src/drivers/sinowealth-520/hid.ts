import type { MouseStatus } from "../mouse-types.ts";
import { AulaSc380ProHidClient } from "../aula/hid.ts";
import { LeobogGm3HidClient } from "../leobog/hid.ts";
import {
  SC380_PRO_RECEIVER_ID,
  SC380_PRO_REPORT_ID,
  decodeSc380ProReply,
  encodeSc380ProReport,
} from "@openmouse/protocol/aula";

/** `05 01`, six bytes: the model signature both vendor tools read first. */
const READ_SIGNATURE = 0x05;
const SIGNATURE_LENGTH = 6;
const SIGNATURE_PREFIX = [0x04, 0, 0, 0, 0];
/** Last signature byte per model (docs/aula-sc380-pro.md, docs/leobog-gm3.md). */
const AULA_SC380_PRO = 0x2e;
const LEOBOG_GM3 = 0x22;

type Inner = AulaSc380ProHidClient | LeobogGm3HidClient;

/**
 * Controls copied onto this client once the mouse is named, so OpenMouse,
 * which offers a control when the client has its method, offers only what
 * the connected model supports.
 */
const DELEGATED = [
  "setPollingRate", "setActiveDpiStage", "setDpiStageValue", "setDpiStageAxes", "setDpi", "setDpiStageCount",
  "setDebounceTime", "setSleepTimeout", "setButtonMapping", "resetButtonMappings", "setMacro",
  "getDebounceOptions", "getSupportedPollingRates", "getSleepOptions", "getButtonOptions", "getButtonMappings",
  "getDefaultButtonMappings", "getMacros",
] as const;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The SinoWealth 520-byte report-9 family behind `258a:0136` (cable) and
 * `258a:0138` (2.4 GHz receiver): the AULA SC380 Pro and the LEOBOG GM3 share
 * both USB ids, the `0xFF02:0x02` collection and the frame format. Only the
 * model signature tells them apart, so this client reads it before anything
 * else and hands every call to that model's client. A mouse it does not know
 * is refused before a single setting is read or written.
 */
export class Sinowealth520HidClient {
  readonly device: HIDDevice;
  private inner: Inner | null = null;
  private naming: Promise<Inner> | null = null;

  constructor(device: HIDDevice) {
    this.device = device;
  }

  static isSupported(device: HIDDevice): boolean {
    return AulaSc380ProHidClient.isSupported(device) || LeobogGm3HidClient.isSupported(device);
  }

  /** The connected model's refresh interval; 0 until the mouse is named. */
  get pollIntervalMs(): number {
    return this.inner?.pollIntervalMs ?? 0;
  }

  getDpiOptions(): number[] {
    return this.inner?.getDpiOptions() ?? [];
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
  }

  async close(): Promise<void> {
    if (this.inner) await this.inner.close();
    else if (this.device.opened) await this.device.close();
  }

  async readStatus(): Promise<MouseStatus> {
    return (await this.name()).readStatus();
  }

  private name(): Promise<Inner> {
    this.naming ??= this.identify().catch((error: unknown) => {
      this.naming = null;
      throw error;
    });
    return this.naming;
  }

  private async identify(): Promise<Inner> {
    await this.open();
    await this.device.sendFeatureReport(SC380_PRO_REPORT_ID, encodeSc380ProReport(READ_SIGNATURE, 1, SIGNATURE_LENGTH));
    await sleep(30);
    const view = await this.device.receiveFeatureReport(SC380_PRO_REPORT_ID);
    const signature = decodeSc380ProReply(
      new Uint8Array(view.buffer, view.byteOffset, view.byteLength), READ_SIGNATURE, 1, SIGNATURE_LENGTH);
    if (!SIGNATURE_PREFIX.every((byte, index) => signature[index] === byte)) {
      throw new Error("This SinoWealth mouse did not identify as a supported model; nothing was changed.");
    }
    const model = signature[SIGNATURE_PREFIX.length];
    let inner: Inner;
    if (model === AULA_SC380_PRO) {
      if (this.device.productId !== SC380_PRO_RECEIVER_ID) {
        throw new Error("The AULA SC380 Pro is supported through its 2.4 GHz receiver only; nothing was changed.");
      }
      inner = new AulaSc380ProHidClient(this.device);
    } else if (model === LEOBOG_GM3) {
      inner = new LeobogGm3HidClient(this.device);
    } else {
      throw new Error(`This SinoWealth mouse reported model 0x${(model ?? 0).toString(16)}, which OpenMouse does not know; nothing was changed.`);
    }
    for (const method of DELEGATED) {
      const fn = (inner as unknown as Record<string, unknown>)[method];
      if (typeof fn === "function") (this as unknown as Record<string, unknown>)[method] = fn.bind(inner);
    }
    this.inner = inner;
    return inner;
  }
}
