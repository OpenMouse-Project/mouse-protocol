import type { KeychronReceiverStatus, MouseLighting } from "../mouse-types.ts";
import { encodeReceiverKeys, decodeReceiverKeys } from "../../keychron/receiver-keys.ts";
import { keychronButtonOptions, keychronDecodeButton, keychronEncodeButton, keychronEncodeLighting, keychronLighting } from "./launcher-mouse.ts";

const BUTTONS = [
  { name: "Polling", index: 0, action: "Polling Loop" },
  { name: "Lighting", index: 1, action: "Lighting mode cycle" },
  { name: "Switch type", index: 2, action: "Toggle optical / magnetic" },
  { name: "DPI", index: 3, action: "DPI Loop" },
];
const EXTRA: ReadonlyArray<readonly [string, readonly number[]]> = [
  ["Lighting mode cycle", [6, 1]], ["Lighting speed cycle", [6, 2]], ["Lighting colour cycle", [6, 3]],
  ["Lighting brightness +", [6, 4]], ["Lighting brightness -", [6, 5]],
  ...([204, 0, 2] as const).flatMap((target, i) => ([
    [`Toggle optical / magnetic${i ? i === 1 ? " (left)" : " (right)" : ""}`, [15, 3, target, 0]],
    [`Optical${i ? i === 1 ? " (left)" : " (right)" : " (both)"}`, [15, 3, target, 1]],
    [`Magnetic${i ? i === 1 ? " (left)" : " (right)" : " (both)"}`, [15, 3, target, 2]],
  ] as const)),
];


export function isKeychronConfigurableReceiver(device: HIDDevice): boolean {
  return device.vendorId === 0x3434 && device.productId === 0xd05a;
}

type Query = (reportId: number, length: number, payload: number[], match: (bytes: Uint8Array) => boolean) => Promise<Uint8Array>;
type Send = (reportId: number, packet: Uint8Array) => Promise<void>;

/** Receiver controls share the mouse's transport queue, but use bridge_config commands. */
export class KeychronReceiverControls {
  constructor(private readonly query: Query, private readonly sendWithoutReply: Send) {}

  async readStatus(): Promise<KeychronReceiverStatus> {
    const version = await this.query(0xb5, 20, [2, 0], b => b[0] === 2);
    if (version.length < 9) throw new Error("Incomplete receiver identity.");
    const buttonMappings: Record<string, string> = {};
    for (const button of BUTTONS) buttonMappings[button.name] = await this.readReceiverButton(button.index, button.action);
    return {
      name: "Keychron TurboLink 8K",
      buttonMappings,
      buttonOptions: [...keychronButtonOptions("8k", true), ...EXTRA.map(([label]) => label)],
      lighting: await this.readReceiverLighting(),
      firmware: 'v' + version[8] + '.' + (version[7] >> 4) + '.' + (version[7] & 15),
    };
  }

  private async readReceiverButton(index: number, fallback: string): Promise<string> {
    const reply = await this.query(0xb3, 63, [0x31, index], b => b[0] === 0x31 && b[1] === index);
    if (reply.length < 4) throw new Error("Incomplete receiver button record.");
    const special = EXTRA.find(([, bytes]) => bytes.every((byte, i) => reply[3 + i] === byte));
    return special?.[0] ?? decodeReceiverKeys(reply) ?? keychronDecodeButton(reply, "8k") ?? fallback;
  }

  async setButtonMapping(button: string, action: string): Promise<void> {
    const target = BUTTONS.find(b => b.name === button);
    const bytes = EXTRA.find(([label]) => label === action)?.[1] ?? encodeReceiverKeys(action) ?? keychronEncodeButton(action, "8k");
    if (!target || !bytes) throw new Error("Unknown receiver button assignment.");
    const packet = new Uint8Array(63); packet.set([0x30, target.index, 0]); packet.set(bytes, 3);
    const ack = await this.query(0xb3, 63, Array.from(packet), b => b[0] === 0xe4 && b[2] === 0x30);
    if (ack[1] !== 0) throw new Error("The receiver rejected the button assignment.");
    const expected = action === "Default" ? target.action
      : bytes[0] === 2 ? decodeReceiverKeys(Uint8Array.from([0, 0, 0, ...bytes])) : action;
    if (await this.readReceiverButton(target.index, target.action) !== expected) throw new Error("The receiver did not keep the button assignment.");
  }

  private async readReceiverLighting(): Promise<MouseLighting> {
    const r = await this.query(0xb5, 20, [0x20, 0], b => b[0] === 0x20 && b[1] === 0);
    if (r.length < 10) throw new Error("Incomplete receiver lighting report.");
    return { ...keychronLighting({ mode: r[4]!, brightness: r[5]!, speed: r[6]!, rgb: [r[7]!, r[8]!, r[9]!] }, [1, 2, 3]), zone: "Receiver" };
  }

  async setLighting(lighting: MouseLighting): Promise<MouseLighting> {
    const next = keychronEncodeLighting(lighting, [1, 2, 3]);
    const packet = new Uint8Array(20); packet.set([0x24, 0, next.mode, next.brightness, next.speed, ...next.rgb]);
    await this.sendWithoutReply(0xb5, packet);
    const confirmed = await this.readReceiverLighting();
    const expected = keychronLighting(next, [1, 2, 3]);
    if (confirmed.mode !== expected.mode || confirmed.brightness !== expected.brightness || confirmed.speed !== expected.speed
      || confirmed.color !== expected.color) throw new Error("The receiver did not keep the lighting settings.");
    return confirmed;
  }
}
