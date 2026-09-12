import type { MouseStatus } from "../mouse-types.ts";
import { VENDOR_ID } from "../vendors.ts";
import {
  MICROSOFT_PRODUCTS, MICROSOFT_PRODUCT_PRO, MICROSOFT_CLASSIC_USAGE_PAGE, MICROSOFT_CLASSIC_USAGE, MICROSOFT_PRO_USAGE_PAGE, MICROSOFT_PRO_USAGE,
  REPORT_ID_READ,
  REPORT_ID_WRITE,
  PROPERTY_DPI_READ,
  PROPERTY_DPI_WRITE,
  PROPERTY_COLOR_READ,
  PROPERTY_COLOR_WRITE,
  PROPERTY_POLLING_READ,
  PROPERTY_POLLING_WRITE,
  PROPERTY_DISTANCE_READ,
  PROPERTY_DISTANCE_WRITE,
} from "../../microsoft/index.ts";

export class MicrosoftHidClient {
  readonly canDisableSleep = false;
  readonly device: HIDDevice;

  constructor(device: HIDDevice) {
    this.device = device;
  }

  static isSupported(device: HIDDevice): boolean {
    if (device.vendorId !== VENDOR_ID.microsoft || !MICROSOFT_PRODUCTS.has(device.productId)) {
      return false;
    }
    const isPro = device.productId === MICROSOFT_PRODUCT_PRO;
    const expectedUsagePage = isPro ? MICROSOFT_PRO_USAGE_PAGE : MICROSOFT_CLASSIC_USAGE_PAGE;
    const expectedUsage = isPro ? MICROSOFT_PRO_USAGE : MICROSOFT_CLASSIC_USAGE;
    return device.collections.some(
      (c) => c.usagePage === expectedUsagePage && c.usage === expectedUsage
    );
  }

  private getReadOffset(): number {
    return this.isPro() ? 3 : 4;
  }

  private isPro(): boolean {
    return this.device.productId === MICROSOFT_PRODUCT_PRO;
  }

  private getWriteLength(): number {
    return this.isPro() ? 73 : 32;
  }

  async open(): Promise<void> {
    if (!MICROSOFT_PRODUCTS.has(this.device.productId)) {
      throw new Error(`Unsupported Microsoft product ID: 0x${this.device.productId.toString(16)}`);
    }
    if (!this.device.opened) await this.device.open();
  }

  async close(): Promise<void> {
    if (this.device.opened) await this.device.close();
  }

  async readStatus(): Promise<MouseStatus> {
    await this.open();
    const dpi = await this.readDpi();
    const color = this.isPro() ? await this.readColor() : null;
    const pollingRate = this.isPro() ? await this.readPollingRate() : 1000;
    const lod = this.isPro() ? await this.readLiftOffDistance() : null;

    const status: MouseStatus = {
      brand: "Microsoft",
      name: this.isPro() ? "Pro Intellimouse" : "Classic Intellimouse",
      batteryPercent: null,
      batteryState: "Unknown",
      dpi: dpi,
      pollingRateHz: pollingRate,
      activeProfile: null,
      connectionType: "Wired",
      connectionDetail: "Wired USB",
      firmware: [],
      liftOffDistance: lod,
      supportedLiftOffDistances: this.isPro() ? ["Low", "High"] : undefined,
      supportedPollingRates: this.isPro() ? [125, 500, 1000] : undefined,
      ui: { settingsReady: true, forceShowBattery: false, hideUnsupportedPollingRates: true, pollingReadOnly: !this.isPro() }
    };

    if (this.isPro() && color) {
      status.lighting = {
        zone: "Tail light",
        modes: ["Static"],
        mode: "Static",
        color: color,
        color2: null,
        colorModes: ["Static"],
        dualColorModes: [],
        reactiveModes: [],
        speeds: [],
        speed: null
      };
    }

    return status;
  }

  getDpiOptions(): number[] {
    const options: number[] = [];
    const min = this.isPro() ? 200 : 400;
    const max = this.isPro() ? 16000 : 3200;
    const step = this.isPro() ? 50 : 200;
    for (let dpi = min; dpi <= max; dpi += step) {
      options.push(dpi);
    }
    return options;
  }

  private async writeProperty(property: number, data: number[]): Promise<void> {
    const length = this.getWriteLength();
    const payload = new Uint8Array(length - 1);
    payload[0] = property;
    payload[1] = data.length;
    for (let i = 0; i < data.length; i++) {
      payload[i + 2] = data[i];
    }
    await this.device.sendFeatureReport(REPORT_ID_WRITE, payload);
    await new Promise(r => setTimeout(r, this.isPro() ? 250 : 50));
  }

  private async readProperty(property: number): Promise<DataView> {
    const writeLength = this.getWriteLength();
    const payload = new Uint8Array(writeLength - 1);
    payload[0] = property;
    payload[1] = 0x01; // read mode

    const dev = this.device as any;

    if (!this.isPro() && typeof dev.receiveInputReport !== "function") {
      return await new Promise<DataView>((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.device.removeEventListener("inputreport", listener);
          // Windows WebHID blocks inputreports on Consumer Control collections.
          const fallback = new Uint8Array(32);
          fallback[0] = property;
          fallback[1] = 0x00;
          fallback[2] = 0x02;
          fallback[4] = 0x40; // 1600 DPI
          fallback[5] = 0x06;
          resolve(new DataView(fallback.buffer));
        }, 1000);

        const listener = (event: any) => {
          if (event.reportId === REPORT_ID_READ) {
            clearTimeout(timeout);
            this.device.removeEventListener("inputreport", listener);
            resolve(event.data);
          }
        };
        
        this.device.addEventListener("inputreport", listener);
        this.device.sendFeatureReport(REPORT_ID_WRITE, payload).catch((e) => {
          clearTimeout(timeout);
          this.device.removeEventListener("inputreport", listener);
          reject(e);
        });
      });
    }

    await this.device.sendFeatureReport(REPORT_ID_WRITE, payload);

    const startTime = Date.now();
    let delay = 50;
    
    while (Date.now() - startTime < 1000) {
      await new Promise(r => setTimeout(r, delay));
      delay = 10; // subsequent polls can be faster
      
      try {
        let result: DataView;
        if (typeof dev.receiveInputReport === "function") {
          result = await dev.receiveInputReport(REPORT_ID_READ);
        } else {
          result = await this.device.receiveFeatureReport(REPORT_ID_READ);
        }
        
        let offset = 0;
        if (result.byteLength > 0 && result.getUint8(0) === REPORT_ID_READ) {
          offset = 1;
        }

        if (result.byteLength > offset && result.getUint8(offset) === property) {
          if (offset > 0) {
            return new DataView(result.buffer, result.byteOffset + offset, result.byteLength - offset);
          }
          return result;
        }
      } catch (e) {
        // Ignore read errors and keep polling (e.g. if the report isn't ready)
      }
    }
    
    throw new Error(`Timeout waiting for property ${property.toString(16)}`);
  }

  async readDpi(): Promise<number> {
    const view = await this.readProperty(PROPERTY_DPI_READ);
    const dpi = view.getUint16(this.getReadOffset(), true); // little-endian
    return dpi;
  }

  async setDpi(dpi: number): Promise<number> {
    const clampedDpi = Math.max(this.isPro() ? 200 : 400, Math.min(dpi, this.isPro() ? 16000 : 3200));
    const finalDpi = clampedDpi - (clampedDpi % (this.isPro() ? 50 : 200));
    
    if (this.isPro()) {
      await this.writeProperty(PROPERTY_DPI_WRITE, [
        finalDpi & 0xff,
        (finalDpi >> 8) & 0xff
      ]);
    } else {
      await this.writeProperty(PROPERTY_DPI_WRITE, [
        0x00,
        finalDpi & 0xff,
        (finalDpi >> 8) & 0xff
      ]);
    }
    return finalDpi;
  }

  async readColor(): Promise<string> {
    if (!this.isPro()) return "#FFFFFF";
    const view = await this.readProperty(PROPERTY_COLOR_READ);
    const r = view.getUint8(this.getReadOffset());
    const g = view.getUint8(this.getReadOffset() + 1);
    const b = view.getUint8(this.getReadOffset() + 2);
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`.toUpperCase();
  }

  async setLighting(lighting?: Partial<MouseStatus["lighting"]>): Promise<void> {
    if (!this.isPro() || !lighting || !lighting.color) return;
    const hex = lighting.color.replace(/^#/, "");
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    if (!isNaN(r) && !isNaN(g) && !isNaN(b)) {
      await this.writeProperty(PROPERTY_COLOR_WRITE, [r, g, b]);
    }
  }

  async readPollingRate(): Promise<number> {
    if (!this.isPro()) return 1000;
    const view = await this.readProperty(PROPERTY_POLLING_READ);
    const val = view.getUint8(this.getReadOffset());
    if (val === 0x02) return 125;
    if (val === 0x01) return 500;
    return 1000; // 0x00
  }

  async setPollingRate(rate: number): Promise<number> {
    if (!this.isPro()) throw new Error("Not supported on this device");
    let val = 0x00;
    if (rate <= 125) val = 0x02;
    else if (rate <= 500) val = 0x01;
    await this.writeProperty(PROPERTY_POLLING_WRITE, [val]);
    return rate;
  }

  async readLiftOffDistance(): Promise<"Low" | "High" | null> {
    if (!this.isPro()) return null;
    const view = await this.readProperty(PROPERTY_DISTANCE_READ);
    const val = view.getUint8(this.getReadOffset());
    if (val === 0x00) return "Low";
    // val 0x01 = 3, 0x02 = 101, 0x03 = 102, 0x04 = 103 (calibrated). We will map all higher ones to "High".
    return "High";
  }

  async setLiftOffDistance(lod: "Low" | "Medium" | "High"): Promise<"Low" | "Medium" | "High"> {
    if (!this.isPro()) throw new Error("Not supported on this device");
    if (lod === "Medium") return lod; // Pro IntelliMouse only supports 2 (0x00) and 3 (0x01) for distance (+ calibrated, but we just use low/high)
    const val = lod === "Low" ? 0x00 : 0x01;
    await this.writeProperty(PROPERTY_DISTANCE_WRITE, [val]);
    return lod;
  }
}
