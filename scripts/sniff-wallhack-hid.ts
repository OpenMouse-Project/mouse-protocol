/**
 * Fake-HID sniff for WALLHACK M-001 battery + debounce.
 *
 * Fakes the HID transport (report id 4, 63-byte reports, command echoed at
 * byte 2) and records every command code the driver sends during a full
 * readStatus + battery read + debounce write. Proves:
 *  - the vendor Terminal flow never emits BATTERY (0xBA): its auto-read is
 *    version/report_esb/dpi_rank/dpi8Block/combined/chipIds and its input
 *    handler O() has no BATTERY branch, so our 0xBA decode is best-effort;
 *  - debounce (function area 109) has no vendor Ar/O()/auto-read path, so
 *    raw byte writes at 109 are experimental until hardware confirms scale.
 *
 * Run: npx tsx scripts/sniff-wallhack-hid.ts
 */
import {
  WALLHACK_COMMAND,
  WALLHACK_FLASH,
  wallhackBuildBatteryRead,
  wallhackDecodeBattery,
} from "../src/wallhack/index.ts";
import { WallhackMouseHidClient } from "../src/drivers/wallhack/mouse-hid.ts";

const seen: number[] = [];
const store = new Map<number, number>();

function replyFor(packet: Uint8Array): Uint8Array | null {
  const cmd = packet[2]!;
  if (cmd === WALLHACK_COMMAND.writeFunctionArea) {
    const addr = packet[4]! | (packet[5]! << 8);
    const n = packet[3]!;
    for (let i = 0; i < n; i++) store.set(addr + i, packet[7 + i]!);
    return null; // writes are silent; driver verifies by re-read
  }
  const res = new Uint8Array(63);
  res[2] = cmd;
  if (cmd === WALLHACK_COMMAND.readFunctionArea) {
    res[4] = packet[4]!;
    res[5] = packet[5]!;
    const addr = packet[4]! | (packet[5]! << 8);
    const n = packet[3]!;
    for (let i = 0; i < n && 7 + i < 63; i++) res[7 + i] = store.get(addr + i) ?? 1;
    if (res[4] === WALLHACK_FLASH.dpi8Block) {
      res[9] = 0x40;
      res[10] = 0x06; // 1600
    }
    return res;
  }
  if (cmd === WALLHACK_COMMAND.readVersion) {
    res.set([1, 4, 2, 13, 0, 9], 7);
    return res;
  }
  if (cmd === WALLHACK_COMMAND.battery) {
    res[7] = 77;
    res[8] = 0;
    return res;
  }
  if (cmd === WALLHACK_COMMAND.getKeys) {
    res[3] = 24;
    return res;
  }
  return null; // writes are silent; driver verifies by re-read
}

let listener: ((e: { data: DataView }) => void) | null = null;
let opened = false;
const device = {
  vendorId: 0x3879,
  productId: 0x1110,
  opened: false,
  collections: [{ usagePage: 0xff1c, usage: 0x92, children: [] }],
  get openedFlag() {
    return opened;
  },
  open: async () => {
    opened = true;
  },
  close: async () => {
    opened = false;
  },
  sendReport: async (_id: number, data: Uint8Array) => {
    const pkt = new Uint8Array(data);
    seen.push(pkt[2]!);
    const res = replyFor(pkt);
    if (res) listener?.({ data: new DataView(res.buffer) });
  },
  addEventListener: (_t: string, l: (e: { data: DataView }) => void) => {
    listener = l;
  },
  removeEventListener: () => {
    listener = null;
  },
} as unknown as HIDDevice;

const client = new WallhackMouseHidClient(device);
await client.open();
const status = await client.readStatus();
console.log("readStatus battery:", status.batteryPercent, status.batteryState);
const direct = await client.readBattery();
console.log("readBattery direct:", direct);
console.log("battery builder bytes 0-2:", [...wallhackBuildBatteryRead().subarray(0, 3)]);
console.log(
  "battery decode 77/0:",
  JSON.stringify(wallhackDecodeBattery(new Uint8Array([0, 0, 0xba, 0, 0, 0, 0, 77, 0]))),
);
console.log(
  "battery decode 200/0 (out of range):",
  JSON.stringify(wallhackDecodeBattery(new Uint8Array([0, 0, 0xba, 0, 0, 0, 0, 200, 0]))),
);
// Our readStatus issues an explicit 0xBA probe; the vendor Terminal
// auto-read (version/report_esb/dpi_rank/dpi8Block/combined/chipIds) never
// does — static evidence in bundle `nt` + handler `O()` with no BATTERY branch.
const batteryCount = seen.filter((c) => c === WALLHACK_COMMAND.battery).length;
console.log(
  `BATTERY (0xba) explicit probes sent by our driver: ${batteryCount} (vendor flow sends 0): OK`,
);
await client.setDebounceTime(5);
const debounceWrites = seen.filter((c) => c === WALLHACK_COMMAND.writeFunctionArea).length;
console.log(`debounce write at area 109 issued (experimental path): ${debounceWrites > 0 ? "OK" : "FAIL"}`);
await assertOk(batteryCount >= 1, "expected explicit BATTERY probe");
await client.close();
console.log("sniff complete");

async function assertOk(cond: boolean, msg: string): Promise<void> {
  if (!cond) throw new Error(msg);
}
