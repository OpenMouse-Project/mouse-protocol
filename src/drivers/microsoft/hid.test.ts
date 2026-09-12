import assert from "node:assert/strict";
import test from "node:test";
import { MicrosoftHidClient } from "./hid.ts";
import { MICROSOFT_PRODUCT_PRO, MICROSOFT_PRODUCT_CLASSIC, REPORT_ID_READ, REPORT_ID_WRITE, MICROSOFT_CLASSIC_USAGE_PAGE, MICROSOFT_CLASSIC_USAGE, MICROSOFT_PRO_USAGE_PAGE, MICROSOFT_PRO_USAGE } from "../../microsoft/index.ts";
import { VENDOR_ID } from "../vendors.ts";

const globals = globalThis as { window?: { setTimeout: typeof setTimeout } };
globals.window ??= { setTimeout };

function fakeMicrosoft(productId: number, options: { isPro: boolean, mockDpi?: number, mockColor?: string, mockPolling?: number, mockLod?: number }) {
  const sent: any[] = [];
  const listeners: Record<string, Function[]> = {};
  
  const device = {
    vendorId: VENDOR_ID.microsoft,
    productId,
    productName: options.isPro ? "Pro Intellimouse" : "Classic Intellimouse",
    opened: true,
    collections: [],
    open: async () => {},
    close: async () => {},
    sendFeatureReport: async (id: number, data: Uint8Array) => {
      sent.push({ reportId: id, data: new Uint8Array(data) });
      if (!options.isPro && id === REPORT_ID_WRITE && data[1] === 0x01) {
        const property = data[0];
        const replyLength = 32;
        const reply = new Uint8Array(replyLength);
        reply[0] = property;
        reply[1] = 0x00;
        reply[2] = 0x03;
        reply[3] = 0x00;
        if (property === 0x97) {
          reply[4] = (options.mockDpi || 0) & 0xff;
          reply[5] = ((options.mockDpi || 0) >> 8) & 0xff;
        }
        
        setTimeout(() => {
          const event = { reportId: REPORT_ID_READ, data: new DataView(reply.buffer) };
          (listeners["inputreport"] || []).forEach(fn => fn(event));
        }, 10);
      }
    },
    receiveFeatureReport: async (id: number) => {
      if (!options.isPro) throw new Error("Classic uses inputreport");
      const request = sent[sent.length - 1];
      if (!request) throw new Error("No request sent");
      const property = request.data[0];
      const replyLength = 73;
      const reply = new Uint8Array(replyLength);
      reply[0] = property;
      reply[1] = 0x00;
      reply[2] = 0x02;
      if (property === 0x97) {
        reply[3] = (options.mockDpi || 0) & 0xff;
        reply[4] = ((options.mockDpi || 0) >> 8) & 0xff;
      } else if (property === 0xB3 && options.mockColor) {
        const hex = options.mockColor.replace(/^#/, "");
        reply[3] = parseInt(hex.substring(0, 2), 16);
        reply[4] = parseInt(hex.substring(2, 4), 16);
        reply[5] = parseInt(hex.substring(4, 6), 16);
      } else if (property === 0x84) {
        reply[3] = options.mockPolling ?? 0x00;
      } else if (property === 0xB6) {
        reply[3] = options.mockLod ?? 0x00;
      }
      return new DataView(reply.buffer);
    },
    addEventListener: (type: string, listener: Function) => {
      if (!listeners[type]) listeners[type] = [];
      listeners[type].push(listener);
    },
    removeEventListener: (type: string, listener: Function) => {
      if (listeners[type]) {
        listeners[type] = listeners[type].filter(l => l !== listener);
      }
    },
  } as unknown as HIDDevice;
  
  return { device, sent };
}

test("isSupported accepts only known Microsoft products", () => {
  const supportedPro = { vendorId: VENDOR_ID.microsoft, productId: MICROSOFT_PRODUCT_PRO, collections: [{usagePage: MICROSOFT_PRO_USAGE_PAGE, usage: MICROSOFT_PRO_USAGE}] } as HIDDevice;
  const supportedClassic = { vendorId: VENDOR_ID.microsoft, productId: MICROSOFT_PRODUCT_CLASSIC, collections: [{usagePage: MICROSOFT_CLASSIC_USAGE_PAGE, usage: MICROSOFT_CLASSIC_USAGE}] } as HIDDevice;
  const unsupported = { vendorId: VENDOR_ID.microsoft, productId: 0x0000, collections: [] } as HIDDevice;
  const otherVendor = { vendorId: 0x1234, productId: MICROSOFT_PRODUCT_PRO, collections: [{usagePage: MICROSOFT_PRO_USAGE_PAGE, usage: MICROSOFT_PRO_USAGE}] } as HIDDevice;
  
  assert.equal(MicrosoftHidClient.isSupported(supportedPro), true);
  assert.equal(MicrosoftHidClient.isSupported(supportedClassic), true);
  assert.equal(MicrosoftHidClient.isSupported(unsupported), false);
  assert.equal(MicrosoftHidClient.isSupported(otherVendor), false);
});

test("Pro Intellimouse reads DPI and Color via receiveFeatureReport", async () => {
  const { device, sent } = fakeMicrosoft(MICROSOFT_PRODUCT_PRO, { isPro: true, mockDpi: 3200, mockColor: "#FF0000" });
  const client = new MicrosoftHidClient(device);
  
  const status = await client.readStatus();
  
  assert.equal(status.name, "Pro Intellimouse");
  assert.equal(status.dpi, 3200);
  assert.equal(status.lighting?.color, "#FF0000");
  assert.equal(status.pollingRateHz, 1000);
  assert.equal(status.ui?.hideUnsupportedPollingRates, true);
  assert.equal(status.ui?.pollingReadOnly, false);
});

test("Classic Intellimouse reads DPI via inputreport event", async () => {
  const { device, sent } = fakeMicrosoft(MICROSOFT_PRODUCT_CLASSIC, { isPro: false, mockDpi: 1600 });
  const client = new MicrosoftHidClient(device);
  
  const status = await client.readStatus();
  
  assert.equal(status.name, "Classic Intellimouse");
  assert.equal(status.dpi, 1600);
  assert.equal(status.lighting, undefined); // Classic has no lighting
});

test("Pro Intellimouse setDpi and setLighting send correct padded payloads", async () => {
  const { device, sent } = fakeMicrosoft(MICROSOFT_PRODUCT_PRO, { isPro: true, mockDpi: 800 });
  const client = new MicrosoftHidClient(device);
  
  await client.setDpi(1600); // 0x0640
  const dpiWrite = sent.find(s => s.data[0] === 0x96 && s.data[1] !== 0x01);
  assert.ok(dpiWrite, "DPI write report found");
  assert.equal(dpiWrite.data.length, 72); // 73 - 1
  assert.equal(dpiWrite.data[1], 2); // payload length
  assert.equal(dpiWrite.data[2], 0x40); // low byte
  assert.equal(dpiWrite.data[3], 0x06); // high byte
  
  await client.setLighting({ color: "#00FF00" });
  const colorWrite = sent.find(s => s.data[0] === 0xB2 && s.data[1] !== 0x01);
  assert.ok(colorWrite, "Color write report found");
  assert.equal(colorWrite.data[0], 0xB2);
  assert.equal(colorWrite.data[1], 3); // payload length
  assert.equal(colorWrite.data[2], 0x00); // R
  assert.equal(colorWrite.data[3], 0xFF); // G
  assert.equal(colorWrite.data[4], 0x00); // B
});

test("Classic Intellimouse setDpi sends correct 32-byte payload", async () => {
  const { device, sent } = fakeMicrosoft(MICROSOFT_PRODUCT_CLASSIC, { isPro: false, mockDpi: 400 });
  const client = new MicrosoftHidClient(device);
  
  await client.setDpi(3200); // 0x0C80
  const dpiWrite = sent.find(s => s.data[0] === 0x96 && s.data[1] !== 0x01);
  assert.ok(dpiWrite, "DPI write report found");
  assert.equal(dpiWrite.data.length, 31); // 32 - 1
  assert.equal(dpiWrite.data[0], 0x96);
  assert.equal(dpiWrite.data[1], 3); // payload length
  assert.equal(dpiWrite.data[2], 0x00); // padding
  assert.equal(dpiWrite.data[3], 0x80); // low byte
  assert.equal(dpiWrite.data[4], 0x0C); // high byte
});

test("Pro Intellimouse reads and writes polling rate and LOD", async () => {
  // mockPolling: 0x01 = 500Hz, mockLod: 0x01 = High
  const { device, sent } = fakeMicrosoft(MICROSOFT_PRODUCT_PRO, { isPro: true, mockDpi: 800, mockPolling: 0x01, mockLod: 0x01 });
  const client = new MicrosoftHidClient(device);
  
  const status = await client.readStatus();
  assert.equal(status.pollingRateHz, 500);
  assert.equal(status.liftOffDistance, "High");
  assert.equal(status.ui?.hideUnsupportedPollingRates, true);
  assert.equal(status.ui?.pollingReadOnly, false);
  assert.deepEqual(status.supportedLiftOffDistances, ["Low", "High"]);
  
  await client.setPollingRate(125);
  const pollingWrite = sent.find(s => s.data[0] === 0x83);
  assert.ok(pollingWrite);
  assert.equal(pollingWrite.data[1], 1); // length
  assert.equal(pollingWrite.data[2], 0x02); // 125Hz
  
  await client.setLiftOffDistance("Low");
  const lodWrite = sent.find(s => s.data[0] === 0xB8);
  assert.ok(lodWrite);
  assert.equal(lodWrite.data[1], 1); // length
  assert.equal(lodWrite.data[2], 0x00); // Low
});
