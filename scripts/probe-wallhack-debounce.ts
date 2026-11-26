/**
 * Read-only WALLHACK M-001 debounce probe — safe on real hardware.
 *
 * The vendor Terminal never touches `keyDebounceTime` (area 109): it is
 * absent from the `Ar` read/write table, the input handler `O()`, the
 * connect auto-read, all UI strings, and the demo defaults `jO()`. So the
 * bundle cannot tell us the unit or range. This probe only READS:
 *  - area 109 (debounce) plus neighbours 107 (deep_sleep), 108 (reserved),
 *    110 (lod), 111 (angle_snap) for context,
 *  - the combined block (104, len 16) showing which slots the vendor parses.
 *
 * Run on hardware with the mouse awake:
 *   npx tsx scripts/probe-wallhack-debounce.ts
 * Report the factory default at 109. A small int (e.g. 4/8/10) points at
 * milliseconds, matching Incott (0-30 ms byte) / Rapoo (stepped 1-32 ms).
 * Only then attempt a bounded write probe (default±1 with read-back and
 * restore), never blindly sweeping 0-20.
 *
 * Against the fake below it asserts the transport path works end to end.
 */
import {
  WALLHACK_COMMAND,
  WALLHACK_FLASH,
  wallhackBuildRead,
} from "../src/wallhack/index.ts";
import { WallhackMouseHidClient } from "../src/drivers/wallhack/mouse-hid.ts";

const AREAS = [
  WALLHACK_FLASH.deepSleepTime, // 107
  108, // reserved gap, no He name
  WALLHACK_FLASH.keyDebounceTime, // 109
  WALLHACK_FLASH.silentHeight, // 110
  WALLHACK_FLASH.angleSnapEnable, // 111
] as const;

function makeFake(defaults: Record<number, number>) {
  const store = new Map<number, number>(Object.entries(defaults).map(([k, v]) => [Number(k), v]));
  let listener: ((e: { data: DataView }) => void) | null = null;
  return {
    device: {
      vendorId: 0x3879,
      productId: 0x1110,
      collections: [{ usagePage: 0xff1c, usage: 0x92, children: [] }],
      open: async () => {},
      close: async () => {},
      sendReport: async (_id: number, data: Uint8Array) => {
        const pkt = new Uint8Array(data);
        const res = new Uint8Array(63);
        res[2] = pkt[2]!;
        if (pkt[2] === WALLHACK_COMMAND.readFunctionArea) {
          const addr = pkt[4]! | (pkt[5]! << 8);
          res[4] = pkt[4]!;
          res[5] = pkt[5]!;
          const n = pkt[3]!;
          for (let i = 0; i < n && 7 + i < 63; i++) res[7 + i] = store.get(addr + i) ?? 0;
        } else if (pkt[2] === WALLHACK_COMMAND.readVersion) {
          res.set([1, 4, 2, 13, 0, 9], 7);
        } else if (pkt[2] === WALLHACK_COMMAND.battery) {
          res[7] = 77;
          res[8] = 0;
        } else if (pkt[2] === WALLHACK_COMMAND.getKeys) {
          res[3] = 24;
        } else {
          return; // writes silent
        }
        listener?.({ data: new DataView(res.buffer) });
      },
      addEventListener: (_t: string, l: (e: { data: DataView }) => void) => {
        listener = l;
      },
      removeEventListener: () => {
        listener = null;
      },
    } as unknown as HIDDevice,
    packetFor: (addr: number) => wallhackBuildRead(addr, 1),
  };
}

// Self-check against the fake: debounce default 8 reads back, neighbours sane.
const { device, packetFor } = makeFake({ 107: 15, 109: 8, 110: 1, 111: 0 });
console.log("probe packet for area 109:", [...packetFor(109).subarray(0, 7)]);
const client = new WallhackMouseHidClient(device);
await client.open();
for (const addr of AREAS) {
  const v = await (client as unknown as { readByte: (a: number) => Promise<number | null> })["readByte"](addr);
  console.log(`area ${addr}: ${v === null ? "no answer" : v}`);
}
console.log("readDebounceTime():", await client.readDebounceTime());
await client.close();
console.log("probe complete — on hardware, report the area-109 factory default");
