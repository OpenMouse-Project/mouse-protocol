import type { MouseStatus } from "../mouse-types.ts";
import { pulsarVgnDpiOptions } from "@openmouse/protocol/pulsar";
import { AttackSharkHidClient } from "../attackshark/hid.ts";
import { PulsarHidClient, type PulsarDeviceInfo } from "./pulsar-hid.ts";

// The first-generation X2 Wireless and X2 Mini Wireless enumerate under
// Areson's vendor id with a Compx JM03 controller. They speak the same
// report-8 commands, checksum and flash map as PulsarHidClient, but the
// descriptor declares report 8 as a 16-byte feature report (there is no
// output report) and the mouse answers on input report 9. Sources, both
// tested on hardware: packerlschupfer/pulsar-mouse-linux PR #10
// (drivers/x2_areson_*.py, X2 Wireless on these PIDs) and
// VitaminDB/ardor-mouse (src/transport/hidraw.rs embeds the live descriptor,
// which matches the X2 Mini's collections exactly). DPI is the flat 50-step
// encoding (pulsarVgnEncodeDpi). Not yet tested on an X2 Mini.
export const PULSAR_ARESON_VENDOR_ID = 0x25a7;
const WIRED_PRODUCT_ID = 0xfa7b;
const RECEIVER_PRODUCT_ID = 0xfa7c;
const COMMAND_REPORT_ID = 0x08;
const RESPONSE_REPORT_ID = 0x09;
// PAW3370 sensor, 20,000 DPI on Pulsar's spec sheet.
const DPI_MAX = 20_000;

export class PulsarAresonHidClient extends PulsarHidClient {
  protected override readonly responseReportId = RESPONSE_REPORT_ID;

  static override isSupported(device: HIDDevice): boolean {
    return device.vendorId === PULSAR_ARESON_VENDOR_ID
      && [WIRED_PRODUCT_ID, RECEIVER_PRODUCT_ID].includes(device.productId)
      && device.collections.some((collection) => collection.featureReports.some((report) => report.reportId === COMMAND_REPORT_ID))
      && device.collections.some((collection) => collection.inputReports.some((report) => report.reportId === RESPONSE_REPORT_ID))
      // Areson's generic PIDs are shared across OEMs; a GearHub control channel means Attack Shark's.
      && !AttackSharkHidClient.isSupported(device);
  }

  // Neither open driver sends the 0x01 identification challenge, so this
  // firmware may not answer it; the product id already says what we need.
  override async readDeviceInfo(): Promise<PulsarDeviceInfo> {
    await this.open();
    const wired = this.device.productId === WIRED_PRODUCT_ID;
    return { cid: 0, mid: 0, type: wired ? 2 : 0, dongleType: 0xff, connection: wired ? "Wired" : "Wireless", maximumPollingRateHz: 1000 };
  }

  override async readStatus(): Promise<MouseStatus> {
    const status = await super.readStatus();
    const productName = this.device.productName || "X2 Wireless";
    return {
      ...status,
      name: /pulsar/i.test(productName) ? productName : `Pulsar ${productName}`,
      connectionDetail: this.device.productId === WIRED_PRODUCT_ID ? "USB · Areson report 8" : "2.4 GHz receiver · Areson report 8",
      // Codes 1 and 2 are 1 mm and 2 mm; the 0.7 mm code 3 does not exist here.
      supportedLiftOffDistances: ["Medium", "High"],
    };
  }

  override getDpiOptions(): number[] {
    return pulsarVgnDpiOptions().filter((dpi) => dpi <= DPI_MAX);
  }

  protected override isVgnReceiver(): boolean {
    return true;
  }

  protected override async sendPacket(packet: Uint8Array<ArrayBuffer>): Promise<void> {
    await this.device.sendFeatureReport(COMMAND_REPORT_ID, packet);
  }
}
