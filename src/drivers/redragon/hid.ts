import type { MouseLighting, MouseLightingMode, MouseStatus } from "../mouse-types.js";
import {
  REDRAGON_ACTIVE_PROFILE_ADDRESS,
  REDRAGON_BUTTON_BASES,
  REDRAGON_BUTTON_LENGTH,
  REDRAGON_COMMIT_CODES,
  REDRAGON_CONFIG_USAGE,
  REDRAGON_CONFIG_USAGE_PAGE,
  REDRAGON_M612_EFFECTS,
  REDRAGON_M612_LIGHTING_BLOCK_LENGTH,
  REDRAGON_M612_LIGHTING_EFFECT_ADDRESS,
  REDRAGON_M724_EFFECTS,
  REDRAGON_M724_LIGHTING_BLOCK_LENGTH,
  REDRAGON_MAX_TRANSFER,
  REDRAGON_MODELS,
  REDRAGON_POLLING_CODES,
  REDRAGON_POLLING_RATES,
  REDRAGON_PRODUCTS,
  REDRAGON_PRODUCT_IDS,
  REDRAGON_PROFILE_BASES,
  REDRAGON_PROFILE_COUNT,
  REDRAGON_PROFILE_SELECT_CODE,
  REDRAGON_REPORT_ID,
  REDRAGON_SLOT_LENGTH,
  REDRAGON_STAGE_COUNT,
  REDRAGON_VENDOR_ID,
  redragonDecodeRead,
  redragonEncodeCommit,
  redragonEncodeRead,
  redragonEncodeWrite,
  redragonM612EffectForBit,
  redragonM724EffectForBlock,
  redragonM724LightingAddress,
  redragonPollAddress,
  redragonSession,
  redragonSlotAddress,
  type RedragonM612Effect,
  type RedragonModel,
} from "@openmouse/protocol/redragon";

/** RDCfg gaps consecutive writes ~8-18 ms; stay well above that. */
const WRITE_DELAY_MS = 30;

const LIFT_OFF_LEVELS = ["Low", "Medium", "High"] as const;
type LiftOff = (typeof LIFT_OFF_LEVELS)[number];

/** RDCfg's three brightness positions as percentages. */
const BRIGHTNESS = [33, 67, 100] as const;
/** Lighting speed 1 (slowest) to 8; the wire byte is `9 - speed`. */
const SPEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

/** M612 effects OpenMouse can show; FLASH has no matching lighting mode. */
const M612_MODES: ReadonlyArray<readonly [RedragonM612Effect, MouseLightingMode]> = [
  ["static", "Static"],
  ["breathing", "Breathing single"],
  ["spectrumBreathing", "Breathing random"],
  ["wave", "Wave"],
  ["off", "Off"],
];

interface Settings {
  profile: number;
  activeStage: number;
  stages: number[];
  pollingHz: number;
}

function hasConfigCollection(collections: readonly HIDCollectionInfo[]): boolean {
  return collections.some((collection) =>
    (collection.usagePage === REDRAGON_CONFIG_USAGE_PAGE &&
      collection.usage === REDRAGON_CONFIG_USAGE &&
      (collection.featureReports ?? []).some((report) => report.reportId === REDRAGON_REPORT_ID)) ||
    hasConfigCollection(collection.children ?? []));
}

const hex = (bytes: ArrayLike<number>) => Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join(" ");

/**
 * Redragon Holtek mice (K1NG 1K M724 `04d9:fc7a`, Predator M612 `04d9:fc61`)
 * over WebHID.
 *
 * Both keep their settings in one flat memory on the `0xFFA0:0x01`
 * collection (see `@openmouse/protocol/redragon`): every value shown is
 * read from the mouse with `F2`, and every write runs inside the vendor
 * bracket, is followed by the commit block, and is read back before it is
 * reported as done. DPI stages, polling, buttons, and (on the M724)
 * lighting live per onboard profile, so they follow the active profile.
 */
export class RedragonHidClient {
  readonly device: HIDDevice;
  private readonly model: RedragonModel;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(device: HIDDevice) {
    const model = REDRAGON_MODELS.get(device.productId);
    if (!model) throw new Error(`Redragon product 0x${device.productId.toString(16)} is not a supported Holtek mouse.`);
    this.device = device;
    this.model = model;
  }

  static isSupported(device: HIDDevice): boolean {
    if (device.vendorId !== REDRAGON_VENDOR_ID) return false;
    if (!REDRAGON_PRODUCT_IDS.includes(device.productId)) return false;
    return hasConfigCollection(device.collections);
  }

  get supportedPollingRates(): number[] {
    return [...REDRAGON_POLLING_RATES];
  }

  getDpiOptions(): number[] {
    return [...this.model.dpi.labels];
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
  }

  async close(): Promise<void> {
    if (this.device.opened) await this.device.close();
  }

  async readStatus(): Promise<MouseStatus> {
    return await this.run(async () => {
      await this.open();
      const settings = await this.readSettings();
      const product = REDRAGON_PRODUCTS.get(this.model.productId)!;
      const labels = this.model.dpi.labels;
      const liftOff = await this.readLiftOff();
      return {
        brand: "Redragon",
        name: `Redragon ${product.name}`,
        ui: {
          family: "redragon",
          settingsReady: true,
          valuesVerified: true,
          hideUnsupportedPollingRates: true,
          hideProcessingCard: true,
          dpiStageEditor: {
            maxStages: REDRAGON_STAGE_COUNT,
            countEditable: false,
            minDpi: labels[0]!,
            maxDpi: labels[labels.length - 1]!,
            stepDpi: this.model.dpi.step,
          },
          defaultDisplayName: `Redragon ${product.name}`,
          showAdvancedSection: true,
        },
        batteryPercent: null,
        batteryState: "Unknown",
        dpi: settings.stages[settings.activeStage]!,
        dpiStages: settings.stages,
        activeDpiStage: settings.activeStage,
        pollingRateHz: settings.pollingHz,
        supportedPollingRates: this.supportedPollingRates,
        activeProfile: settings.profile + 1,
        profileCount: REDRAGON_PROFILE_COUNT,
        buttonMappings: await this.readButtonMappings(settings.profile),
        buttonOptions: [...this.model.buttons.options],
        lighting: this.model.lighting === "profile" ? await this.readProfileLighting(settings.profile) : await this.readEffectLighting(),
        connectionType: "Wired",
        liftOffDistance: liftOff,
        ...(this.model.liftOffAddress === undefined ? {} : { supportedLiftOffDistances: [...LIFT_OFF_LEVELS] }),
        firmware: [],
      };
    });
  }

  /**
   * Rewrites one stage slot of the active profile, keeping its enabled byte,
   * then reads it back. Returns the DPI label the mouse now holds, which
   * can differ from the request by the slider's step.
   */
  async setDpiStageValue(stage: number, dpi: number): Promise<number> {
    // Validate both before anything is sent.
    const code = this.model.dpi.encode(dpi);
    redragonSlotAddress(0, stage);
    return await this.run(async () => {
      await this.open();
      const address = redragonSlotAddress(await this.readActiveProfile(), stage);
      const slot = await this.readBytes(address, REDRAGON_SLOT_LENGTH);
      await this.writeAndConfirm(address, [slot[0]!, code.value, code.range, code.value, code.range]);
      return code.dpi;
    });
  }

  /** Selects the active DPI stage of the active profile, as the DPI button does. */
  async setActiveDpiStage(stage: number): Promise<number> {
    if (!Number.isInteger(stage) || stage < 0 || stage >= REDRAGON_STAGE_COUNT) {
      throw new Error(`Redragon DPI stage ${stage} is outside 0-${REDRAGON_STAGE_COUNT - 1}.`);
    }
    return await this.run(async () => {
      await this.open();
      await this.writeAndConfirm(REDRAGON_PROFILE_BASES[await this.readActiveProfile()]!, [stage]);
      return stage;
    });
  }

  /** Rewrites the active profile's polling code, keeping the byte after it. */
  async setPollingRate(hz: number): Promise<number> {
    const code = REDRAGON_POLLING_CODES[hz];
    if (code === undefined) {
      throw new Error(`Redragon polling rate ${hz} Hz is not offered; supported: ${REDRAGON_POLLING_RATES.join(", ")}.`);
    }
    return await this.run(async () => {
      await this.open();
      const address = redragonPollAddress(await this.readActiveProfile());
      const [, next] = await this.readBytes(address, 2);
      await this.writeAndConfirm(address, [code, next!]);
      return hz;
    });
  }

  /**
   * Switches the onboard profile (1-5) as RDCfg's MODE menu does: the profile
   * byte outside any bracket, `F1 02 01`, then the commit block. Without the
   * block the M724 stores the byte but keeps the old profile running.
   */
  async setProfile(profile: number): Promise<void> {
    if (!Number.isInteger(profile) || profile < 1 || profile > REDRAGON_PROFILE_COUNT) {
      throw new Error(`Redragon profile ${profile} is outside 1-${REDRAGON_PROFILE_COUNT}.`);
    }
    await this.run(async () => {
      await this.open();
      const current = await this.readBytes(REDRAGON_ACTIVE_PROFILE_ADDRESS, 2);
      const next = [profile - 1, current[1]!];
      await this.sendFrame(redragonEncodeWrite(REDRAGON_ACTIVE_PROFILE_ADDRESS, next));
      await this.sendFrame(redragonEncodeCommit(REDRAGON_PROFILE_SELECT_CODE));
      for (const code of REDRAGON_COMMIT_CODES) await this.sendFrame(redragonEncodeCommit(code));
      await this.confirm(REDRAGON_ACTIVE_PROFILE_ADDRESS, next);
    });
  }

  /**
   * Assigns an action from `buttonOptions` to one button of the active
   * profile. Refuses to take away the profile's last left click, which would
   * leave the mouse unable to click.
   */
  async setButtonMapping(button: string, action: string): Promise<void> {
    const slot = this.model.buttons.names.indexOf(button);
    if (slot < 0) throw new Error(`The Redragon ${this.model.model} has no button named "${button}".`);
    const value = this.model.buttons.encode(action);
    await this.run(async () => {
      await this.open();
      const profile = await this.readActiveProfile();
      if (action !== "Left click") {
        const mappings = await this.readButtonMappings(profile);
        const others = Object.entries(mappings).filter(([name, assigned]) => name !== button && assigned === "Left click");
        if (mappings[button] === "Left click" && others.length === 0) {
          throw new Error("Keep Left click on at least one button, or the mouse cannot click.");
        }
      }
      await this.writeAndConfirm(REDRAGON_BUTTON_BASES[profile]! + this.model.buttons.offsets[slot]!, value);
    });
  }

  /** Sets the lift-off height (M724 only): Low, Medium, or High. */
  async setLiftOffDistance(value: LiftOff): Promise<LiftOff> {
    const address = this.model.liftOffAddress;
    if (address === undefined) throw new Error(`The Redragon ${this.model.model} has no lift-off setting.`);
    const level = LIFT_OFF_LEVELS.indexOf(value);
    if (level < 0) throw new Error(`Redragon lift-off "${value}" is not Low, Medium, or High.`);
    await this.run(async () => {
      await this.open();
      const [, next] = await this.readBytes(address, 2);
      await this.writeAndConfirm(address, [level, next!]);
    });
    return value;
  }

  /**
   * Writes the lighting. On the M612 that is the global effect selector and
   * that effect's parameter block, where a colour, speed, or brightness equal
   * to what the current effect shows is treated as unchanged, so switching
   * effects keeps the target effect's own stored values. On the M724 it is
   * the active profile's single block.
   */
  async setLighting(lighting: MouseLighting): Promise<void> {
    const model = this.model.model;
    if (lighting.speed != null && !SPEEDS.includes(lighting.speed)) {
      throw new Error(`Redragon ${model} lighting speed ${lighting.speed} is outside 1-${SPEEDS.length}.`);
    }
    if (lighting.brightness != null && !BRIGHTNESS.includes(lighting.brightness as 33)) {
      throw new Error(`Redragon ${model} brightness ${lighting.brightness}% is not one of ${BRIGHTNESS.join(", ")}.`);
    }
    const rgb = lighting.color == null ? null : parseColor(lighting.color, model);
    if (this.model.lighting === "profile") {
      const info = REDRAGON_M724_EFFECTS.find((candidate) => candidate.name === lighting.mode);
      if (!info) throw new Error(`The Redragon ${model} has no "${lighting.mode}" lighting effect.`);
      await this.run(async () => {
        await this.open();
        const address = redragonM724LightingAddress(await this.readActiveProfile());
        const block = [...await this.readBytes(address, REDRAGON_M724_LIGHTING_BLOCK_LENGTH)];
        block[4] = info.mode;
        block[6] = info.kind;
        if (info.color && rgb) block.splice(1, 3, ...rgb);
        if (info.speed && lighting.speed != null) block[5] = SPEEDS.length + 1 - lighting.speed;
        if (lighting.brightness != null) block[7] = BRIGHTNESS.indexOf(lighting.brightness as 33) + 1;
        await this.writeAndConfirm(address, block);
      });
      return;
    }
    const effect = M612_MODES.find(([, mode]) => mode === lighting.mode)?.[0];
    if (!effect) throw new Error(`The Redragon ${model} has no "${lighting.mode}" lighting effect.`);
    const info = REDRAGON_M612_EFFECTS.find((candidate) => candidate.effect === effect)!;
    await this.run(async () => {
      await this.open();
      const shown = await this.readEffectLighting();
      const selector = await this.readBytes(REDRAGON_M612_LIGHTING_EFFECT_ADDRESS, 2);
      const writes: Array<[number, number[]]> = [];
      if (info.block !== null) {
        const block = [...await this.readBytes(info.block, REDRAGON_M612_LIGHTING_BLOCK_LENGTH)];
        if (info.color && rgb && lighting.color !== shown.color) block.splice(1, 3, ...rgb);
        if (info.speed && lighting.speed != null && lighting.speed !== shown.speed) {
          block[5] = SPEEDS.length + 1 - lighting.speed;
        }
        if (lighting.brightness != null && lighting.brightness !== shown.brightness) {
          block[7] = BRIGHTNESS.indexOf(lighting.brightness as 33) + 1;
        }
        writes.push([info.block, block]);
      }
      writes.push([REDRAGON_M612_LIGHTING_EFFECT_ADDRESS, [info.bit, selector[1]!]]);
      await this.writeSession(async () => {
        for (const [address, data] of writes) await this.sendFrame(redragonEncodeWrite(address, data));
        for (const code of REDRAGON_COMMIT_CODES) await this.sendFrame(redragonEncodeCommit(code));
      });
      for (const [address, data] of writes) await this.confirm(address, data);
    });
  }

  private async readButtonMappings(profile: number): Promise<Record<string, string>> {
    const { names, offsets, decode } = this.model.buttons;
    const bytes = await this.readRange(REDRAGON_BUTTON_BASES[profile]!, offsets.at(-1)! + REDRAGON_BUTTON_LENGTH);
    return Object.fromEntries(names.map((name, slot) =>
      [name, decode(bytes.subarray(offsets[slot]!, offsets[slot]! + REDRAGON_BUTTON_LENGTH))]));
  }

  private async readProfileLighting(profile: number): Promise<MouseLighting> {
    const block = await this.readBytes(redragonM724LightingAddress(profile), REDRAGON_M724_LIGHTING_BLOCK_LENGTH);
    const info = redragonM724EffectForBlock(block);
    const lit = info !== undefined && info.name !== "Off";
    return {
      zone: "Mouse",
      modes: REDRAGON_M724_EFFECTS.map((effect) => effect.name),
      mode: info?.name ?? null,
      color: `#${hex(block.subarray(1, 4)).replaceAll(" ", "")}`,
      color2: null,
      colorModes: REDRAGON_M724_EFFECTS.filter((effect) => effect.color).map((effect) => effect.name),
      dualColorModes: [],
      reactiveModes: REDRAGON_M724_EFFECTS.filter((effect) => effect.speed).map((effect) => effect.name),
      speeds: SPEEDS,
      speed: info?.speed && block[5]! >= 1 && block[5]! <= SPEEDS.length ? SPEEDS.length + 1 - block[5]! : null,
      brightness: lit ? (BRIGHTNESS[block[7]! - 1] ?? null) : null,
      brightnessLevels: lit ? [...BRIGHTNESS] : undefined,
    };
  }

  private async readEffectLighting(): Promise<MouseLighting> {
    const [bit] = await this.readBytes(REDRAGON_M612_LIGHTING_EFFECT_ADDRESS, 1);
    const info = redragonM612EffectForBit(bit ?? -1);
    const block = info?.block != null ? await this.readBytes(info.block, REDRAGON_M612_LIGHTING_BLOCK_LENGTH) : null;
    const mode = M612_MODES.find(([effect]) => effect === info?.effect)?.[1] ?? null;
    const modesWhere = (key: "color" | "speed") =>
      M612_MODES.filter(([effect]) => REDRAGON_M612_EFFECTS.find((e) => e.effect === effect)![key]).map(([, m]) => m);
    return {
      zone: "Mouse",
      modes: M612_MODES.map(([, m]) => m),
      mode,
      color: block ? `#${hex(block.subarray(1, 4)).replaceAll(" ", "")}` : null,
      color2: null,
      colorModes: modesWhere("color"),
      dualColorModes: [],
      reactiveModes: modesWhere("speed"),
      speeds: SPEEDS,
      speed: block && info?.speed && block[5]! >= 1 && block[5]! <= SPEEDS.length ? SPEEDS.length + 1 - block[5]! : null,
      brightness: block ? (BRIGHTNESS[block[7]! - 1] ?? null) : null,
      // Off has no parameter block, so there is no brightness to set.
      brightnessLevels: block !== null ? [...BRIGHTNESS] : undefined,
    };
  }

  private async readLiftOff(): Promise<LiftOff | null> {
    if (this.model.liftOffAddress === undefined) return null;
    const [level] = await this.readBytes(this.model.liftOffAddress, 1);
    return LIFT_OFF_LEVELS[level!] ?? null;
  }

  private async readRange(address: number, length: number): Promise<Uint8Array> {
    const out = new Uint8Array(length);
    for (let offset = 0; offset < length; offset += REDRAGON_MAX_TRANSFER) {
      out.set(await this.readBytes(address + offset, Math.min(REDRAGON_MAX_TRANSFER, length - offset)), offset);
    }
    return out;
  }

  private async readSettings(): Promise<Settings> {
    const profile = await this.readActiveProfile();
    const [activeStage] = await this.readBytes(REDRAGON_PROFILE_BASES[profile]!, 1);
    if (activeStage === undefined || activeStage >= REDRAGON_STAGE_COUNT) {
      throw new Error(`The Redragon ${this.model.model} reported DPI stage ${activeStage}; expected 0-4.`);
    }
    const stages: number[] = [];
    for (let stage = 0; stage < REDRAGON_STAGE_COUNT; stage++) {
      const slot = await this.readBytes(redragonSlotAddress(profile, stage), REDRAGON_SLOT_LENGTH);
      stages.push(this.model.dpi.decode(slot[1]!, slot[2]!));
    }
    const [pollCode] = await this.readBytes(redragonPollAddress(profile), 1);
    const pollingHz = REDRAGON_POLLING_RATES.find((hz) => REDRAGON_POLLING_CODES[hz] === pollCode);
    if (pollingHz === undefined) {
      throw new Error(`The Redragon ${this.model.model} reported polling code ${pollCode}; expected 1, 2, 4, or 8.`);
    }
    return { profile, activeStage, stages, pollingHz };
  }

  private async readActiveProfile(): Promise<number> {
    const [profile] = await this.readBytes(REDRAGON_ACTIVE_PROFILE_ADDRESS, 1);
    if (profile === undefined || profile >= REDRAGON_PROFILE_COUNT) {
      throw new Error(`The Redragon ${this.model.model} reported profile ${profile}; expected 0-4.`);
    }
    return profile;
  }

  private async readBytes(address: number, length: number): Promise<Uint8Array> {
    await this.sendFrame(redragonEncodeRead(address, length));
    const view = await this.device.receiveFeatureReport(REDRAGON_REPORT_ID);
    const answer = new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
    return redragonDecodeRead(answer, address, length);
  }

  /** One write inside the vendor bracket + commit block, then a read-back. */
  private async writeAndConfirm(address: number, data: number[]): Promise<void> {
    await this.writeSession(async () => {
      await this.sendFrame(redragonEncodeWrite(address, data));
      for (const code of REDRAGON_COMMIT_CODES) await this.sendFrame(redragonEncodeCommit(code));
    });
    await this.confirm(address, data);
  }

  /** Reads `data.length` bytes back and throws unless they match. */
  private async confirm(address: number, data: readonly number[]): Promise<void> {
    const confirmed = await this.readBytes(address, data.length);
    if (confirmed.some((byte, index) => byte !== data[index])) {
      throw new Error(`The Redragon ${this.model.model} kept ${hex(confirmed)} at 0x${address.toString(16)} instead of ${hex(data)}.`);
    }
  }

  private async sendFrame(frame: Uint8Array): Promise<void> {
    await this.device.sendFeatureReport(REDRAGON_REPORT_ID, frame.slice(1).buffer as ArrayBuffer);
    await new Promise((resolve) => setTimeout(resolve, WRITE_DELAY_MS));
  }

  /** The bracket is always closed: a session left open hangs the interface. */
  private async writeSession(operation: () => Promise<void>): Promise<void> {
    await this.sendFrame(redragonSession(true));
    try {
      await operation();
    } finally {
      await this.sendFrame(redragonSession(false));
    }
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return await result;
  }
}

/** @deprecated `RedragonHidClient` serves the M612 too; the model follows the PID. */
export class RedragonM612HidClient extends RedragonHidClient {}

function parseColor(color: string, model: string): [number, number, number] {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (!match) throw new Error(`Redragon ${model} colour "${color}" is not #rrggbb.`);
  return [parseInt(match[1]!, 16), parseInt(match[2]!, 16), parseInt(match[3]!, 16)];
}
