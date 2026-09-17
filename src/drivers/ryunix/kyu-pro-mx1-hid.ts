import type { MouseLighting, MouseStatus } from "../mouse-types.ts";
import { decodeKyuProMx1Report } from '../../ryunix/kyu-pro-mx1.js';

export const RYUNIX_HID_FILTERS = [
  { vendorId: 0x04F3, productId: 0x026E }, // Wired
  { vendorId: 0x04F3, productId: 0x026F }, // Wireless
];

const LED_MODE_MAP: Record<number, any> = {
  0x00: "Off",
  0x01: "Spectrum",
  0x02: "Breathing single",
  0x03: "Static",
  0x04: "Wave",
  0x05: "Reactive",
  0x06: "Cycling",
  0x07: "Wave",
};

export class KyuProMx1Client {
  private onStatusChange?: (status: NonNullable<KyuProMx1Client['currentStatus']>) => void;
  public device: HIDDevice; 
  public currentStatus: {
    isActive: boolean;
    dpiStage: number;
    batteryLevel: number;
    isCharging: boolean;
    pollingRateHz: number;
    ledModeCode: number;
  } | null = null;
  
  public static readonly VENDOR_ID = 0x04F3;
  public static readonly PRODUCT_ID_WIRED = 0x026E;
  public static readonly PRODUCT_ID_WIRELESS = 0x026F;

  public static isSupported(device: HIDDevice): boolean {
    return (
      device.vendorId === KyuProMx1Client.VENDOR_ID &&
      (device.productId === KyuProMx1Client.PRODUCT_ID_WIRED ||
       device.productId === KyuProMx1Client.PRODUCT_ID_WIRELESS)
    );
  }

  constructor(device: HIDDevice) {
    this.device = device;
  }

  public async init(): Promise<void> {
    if (!this.device.opened) {
      await this.device.open();
    }
    
    console.log('[Kyu Pro MX1] Total Collections:', this.device.collections.length);
    this.device.collections.forEach((col, index) => {
      console.log(`[Collection ${index}] UsagePage: 0x${col.usagePage?.toString(16)}, Usage: 0x${col.usage?.toString(16)}`, col);
    });

    this.device.addEventListener('inputreport', (event: HIDInputReportEvent) => {
      const { reportId, data } = event;
      
      const rawBytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      const hexString = Array.from(rawBytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
      
      console.log(`[Kyu Pro MX1 RAW] Report ID: ${reportId} | Length: ${data.byteLength} | Bytes: [ ${hexString} ]`);

      if (reportId !== 0x04) {
        return; 
      }

      try {
        const parsed = decodeKyuProMx1Report(rawBytes, reportId);
        console.log('[Kyu Pro MX1] Telemetry Report:', parsed);
        this.parseStatusReport(data);
      } catch (err) {
        console.error('[Kyu Pro MX1] Parse error:', err);
      }
    });
  }

  public async open(): Promise<void> {
    if (!this.device.opened) {
      await this.device.open();
    }

    // Find Collection 2 and verify it has the expected configuration usage and Feature Report ID [5]
    const configCollection = this.device.collections[2];
    if (!configCollection) {
      throw new Error("Invalid device topology: Collection 2 (Configuration Interface) is missing.");
    }

    if (configCollection.usagePage !== 0x0A || configCollection.usage !== 0xC7) {
      throw new Error(`Unexpected interface usage. Expected 0x0A/0xC7, got 0x${configCollection.usagePage?.toString(16)}/0x${configCollection.usage?.toString(16)}`);
    }

    const hasReport05 = configCollection.featureReports.some(r => r.reportId === 0x05);
    if (!hasReport05) {
      throw new Error("Configuration interface does not support Feature Report ID 0x05.");
    }

    await this.init();
  }
  
  public async close(): Promise<void> {
    if (this.device.opened) {
      await this.device.close();
    }
  }

  public getDpiOptions(): number[] {
    return [400, 800, 1600, 3200, 6400];
  }

  public getPollingRateOptions(): number[] {
    return [125, 250, 500, 1000];
  }

  public async readStatus(): Promise<MouseStatus> {
    await this.init();

    if (!this.currentStatus) {
      try {
        const featureData = await this.device.receiveFeatureReport(0x04);
        this.parseStatusReport(featureData);
      } catch {
        // Fallback if feature report isn't supported
      }
    }

    const currentModeName = this.currentStatus 
      ? (LED_MODE_MAP[this.currentStatus.ledModeCode] ?? "Static") 
      : "Static";

    return {
      brand: "Ryunix" as any,
      name: "Kyu Pro MX1",
      ui: {
        family: "ryunix",
        settingsReady: true,
        defaultDisplayName: "Kyu Pro MX1",
        dpiStageEditor: {
          maxStages: 6,
          countEditable: true,
          minDpi: 400,
          maxDpi: 6400,
          stepDpi: 50,
        },
      },
      batteryPercent: this.currentStatus ? this.currentStatus.batteryLevel : 0,
      batteryState: this.currentStatus ? (this.currentStatus.isCharging ? "Charging" : "Discharging") : "Unknown",
      
      dpi: 0,
      dpiY: 0,

      activeDpiStage: this.currentStatus ? this.currentStatus.dpiStage : 0,
      dpiStages: this.getDpiOptions(),
      dpiStageColors: [
        "#ff0000",
        "#00ff00",
        "#0000ff",
        "#ffff00",
        "#ff00ff",
      ],
      pollingRateHz: this.currentStatus ? this.currentStatus.pollingRateHz : 0,
      supportedPollingRates: this.getPollingRateOptions(),
      activeProfile: null,
      connectionType: this.device.productId === KyuProMx1Client.PRODUCT_ID_WIRELESS ? "Wireless" : "Wired",
      connectionDetail: this.device.productId === KyuProMx1Client.PRODUCT_ID_WIRELESS ? "2.4 GHz receiver" : "USB",
      liftOffDistance: null,
      firmware: ["Kyu Pro MX1 v1.0"],
      
      // Clean template lighting configuration for the UI tab
      lighting: {
        zone: "Logo & Scroll",
        modes: ["Off", "Static", "Cycling", "Wave", "Spectrum", "Reactive", "Breathing single"],
        mode: currentModeName,
        color: "#ff0000",
        color2: null,
        colorModes: ["Static", "Breathing single"],
        dualColorModes: [],
        reactiveModes: [],
        speeds: [],
        speed: null,
        brightness: 100,
        brightnessLevels: [0, 25, 50, 75, 100],
      },
    };
  }

  public async setDpi(dpi: number): Promise<number> {
    console.log(`[Kyu Pro MX1] setDpi called with: ${dpi}`);
    return dpi;
  }

  public async setPollingRate(rate: number): Promise<number> {
    console.log(`[Kyu Pro MX1] setPollingRate called with: ${rate}Hz`);

    const rateMap: Record<number, number> = {
      125: 0x08,
      250: 0x04,
      500: 0x02,
      1000: 0x01,
    };

    const rateCode = rateMap[rate];
    if (rateCode === undefined) {
      throw new Error(`Unsupported polling rate: ${rate}`);
    }

    // Construct the payload matching your device's expected format
    const payload = new Uint8Array(32);
    payload[0] = 0x04;    // Report ID or command header
    payload[1] = 0x01; 
    payload[2] = 0x00;    // Counter / flag byte
    payload[3] = 0x00;
    payload[4] = rateCode; 

    try {
      // Use sendReport (Output Report / SET_REPORT) instead of sendFeatureReport
      await this.device.sendReport(0x06, payload);
      console.log(`[Kyu Pro MX1] Successfully wrote polling rate via Report 0x06: ${rate}Hz`);
    } catch (err) {
      console.error('[Kyu Pro MX1] Failed to write report 0x06:', err);
      throw err;
    }

    if (this.currentStatus) {
      this.currentStatus.pollingRateHz = rate;
    }

    return rate;
  }

  public setOnStatusChange(callback: (status: NonNullable<KyuProMx1Client['currentStatus']>) => void) {
    this.onStatusChange = callback;
  }


  private parseStatusReport(data: DataView): void {
    if (data.byteLength < 6) {
      return;
    }

    const isActive = data.getUint8(0) === 0x01; // Index 0: 01 (Active)
    const dpiStage = data.getUint8(1);          // Index 1: 02 (DPI Stage)
    
    // Map polling rate code from Index 2 (e.g., 0x04 -> 250 Hz)
    const pollingByte = data.getUint8(2);       // Index 2: 04 (Polling code)
    const pollingMap: Record<number, number> = {
      0x08: 125,
      0x04: 250,
      0x02: 500,
      0x01: 1000,
    };
    const pollingRateHz = pollingMap[pollingByte] ?? 1000;

    const batteryLevel = data.getUint8(3);      // Index 3: 64 (100% Battery)
    const isCharging = data.getUint8(4) === 0x01; // Index 4: Charging state
    const ledModeCode = data.getUint8(5);

    this.currentStatus = {
      isActive,
      dpiStage,
      batteryLevel,
      isCharging,
      pollingRateHz,
      ledModeCode,
    };
    // Notify your UI framework immediately
    if (this.currentStatus && this.onStatusChange) {
      this.onStatusChange(this.currentStatus);
    }

    console.log(`[Kyu Pro MX1] Status Update -> Battery: ${batteryLevel}%, Charging: ${isCharging}, Active: ${isActive}, DPI Stage: ${dpiStage}, Polling Rate: ${pollingRateHz}Hz, LED Mode: ${ledModeCode}`);
  }
}