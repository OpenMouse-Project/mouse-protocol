import { AsusGladiusIIHidClient } from "./asus/hid.ts";
import { AtkBitmouseHidClient } from "./atk/bitmouse-hid.ts";
import { AtkHidClient } from "./atk/hid.ts";
import { AttackSharkHidClient } from "./attackshark/hid.ts";
import { EggOp1HidClient } from "./endgame/egg-op1-hid.ts";
import { FantechHidClient } from "./fantech/hid.ts";
import { GearHubHidClient } from "./gearhub/hid.ts";
import { eggWeCreate, eggWeIsSupported, eggWeSupportScore, isEggWeClient, type EggWeHidClient } from "./endgame/egg-we-control.ts";
import { FinalmouseHidClient } from "./finalmouse/hid.ts";
import { KeychronM6HidClient } from "./keychron/m6-hid.ts";
import { KeychronNapeHidClient } from "./keychron/nape-hid.ts";
import { LamzuAtlantisHidClient } from "./lamzu-atlantis/hid.ts";
import { LamzuHidClient } from "./lamzu/hid.ts";
import { LogitechHidppClient } from "./logitech/hidpp.ts";
import { ModdoHidClient } from "./moddo/hid.ts";
import { NinjutsoHidClient } from "./ninjutso/hid.ts";
import { OrbitalHidClient } from "./orbital/hid.ts";
import { PulsarHidClient } from "./pulsar/pulsar-hid.ts";
import { PulsarProHidClient } from "./pulsar/pulsar-pro-hid.ts";
import { PulsarXs1HidClient } from "./pulsar/pulsar-xs1-hid.ts";
import { RazerCobraHidClient } from "./razer/cobra-hid.ts";
import { RazerHidClient } from "./razer/hid.ts";
import { RazerViperHidClient } from "./razer/viper-hid.ts";
import { RazerViperMiniHidClient } from "./razer/viper-mini-hid.ts";
import { RazerViperV4ProHidClient } from "./razer/viper-v4-pro-hid.ts";
import { TeevolutionHidClient } from "./teevolution/hid.ts";
import { VgnF2HidClient } from "./vgn/hid.ts";
import { WallhackKeyboardHidClient } from "./wallhack/keyboard-hid.ts";
import { WallhackMouseHidClient } from "./wallhack/mouse-hid.ts";
import { WLMouseHidClient } from "./wlmouse/hid.ts";
import { WootingHidClient } from "./wooting/hid.ts";
import { ZaunkoenigHidClient } from "./zaunkoenig/hid.ts";
import { CorsairHidClient } from "./corsair/hid.ts";
import { GWolvesHidClient } from "./gwolves/hid.ts";
import { SteelSeriesRival3HidClient } from "./steelseries/hid.ts";
import { SteelSeriesAerox3HidClient } from "./steelseries/aerox3-hid.ts";
import { SteelSeriesRival3WirelessHidClient } from "./steelseries/rival3-wireless-hid.ts";
import { SteelSeriesAerox5HidClient } from "./steelseries/aerox5-hid.ts";
import { SteelSeriesAerox5WirelessHidClient } from "./steelseries/aerox5-wireless-hid.ts";
import { SteelSeriesRival650HidClient } from "./steelseries/rival650-hid.ts";
import { SteelSeriesAerox9WirelessHidClient } from "./steelseries/aerox9-wireless-hid.ts";
import { SteelSeriesRival310HidClient } from "./steelseries/rival310-hid.ts";
import { SteelSeriesPrimePlusHidClient } from "./steelseries/prime-plus-hid.ts";
import { SteelSeriesPrimeMiniWirelessHidClient } from "./steelseries/prime-mini-wireless-hid.ts";
import { SteelSeriesSenseiTenHidClient } from "./steelseries/sensei-ten-hid.ts";
import { GloriousHidClient } from "./glorious/hid.ts";
import { GloriousClassicHidClient } from "./glorious/classic-hid.ts";
import { MchoseHidClient } from "./mchose/hid.ts";
import { MchoseDockHidClient } from "./mchose/dock-hid.ts";
import { MchoseA5ProMaxHidClient } from "./mchose/a5-gen1-hid.ts";
import { KsnakeHidClient } from "./ksnake/hid.ts";
import { MicrosoftHidClient } from "./microsoft/hid.ts";
import { DareuHidClient } from "./dareu/hid.ts";
import { IncottHidClient } from "./incott/hid.ts";
import { HyperXHidClient } from "./hyperx/hid.ts";
import { MchoseV3HidClient } from "./mchose/v3-hid.ts";

export type PulsarClient = PulsarHidClient | PulsarProHidClient | PulsarXs1HidClient;
export type SupportedClient = LogitechHidppClient | PulsarClient | EggOp1HidClient | EggWeHidClient | FinalmouseHidClient | WLMouseHidClient | LamzuHidClient | LamzuAtlantisHidClient | OrbitalHidClient | RazerHidClient | RazerViperHidClient | RazerViperMiniHidClient | RazerViperV4ProHidClient | RazerCobraHidClient | TeevolutionHidClient | AtkHidClient | AtkBitmouseHidClient | VgnF2HidClient | KeychronM6HidClient | KeychronNapeHidClient | ModdoHidClient | NinjutsoHidClient | ZaunkoenigHidClient | CorsairHidClient | AttackSharkHidClient | FantechHidClient | GearHubHidClient | WootingHidClient | WallhackMouseHidClient | WallhackKeyboardHidClient | GWolvesHidClient | SteelSeriesRival3HidClient | SteelSeriesAerox3HidClient | SteelSeriesRival3WirelessHidClient | SteelSeriesAerox5HidClient | SteelSeriesAerox5WirelessHidClient | SteelSeriesRival650HidClient | SteelSeriesAerox9WirelessHidClient | SteelSeriesRival310HidClient | SteelSeriesPrimePlusHidClient | SteelSeriesPrimeMiniWirelessHidClient | SteelSeriesSenseiTenHidClient | GloriousHidClient | GloriousClassicHidClient | MchoseHidClient | MchoseDockHidClient | MchoseA5ProMaxHidClient | KsnakeHidClient | MicrosoftHidClient | DareuHidClient | IncottHidClient | HyperXHidClient | MchoseV3HidClient | AsusGladiusIIHidClient;

export interface DeviceDriver {
  brand: string;
  supports(device: HIDDevice): boolean;
  create(device: HIDDevice): SupportedClient | null;
  score(device: HIDDevice): number;
}

export const DEVICE_DRIVERS: readonly DeviceDriver[] = [
  {brand: "ASUS",supports: (device) => AsusGladiusIIHidClient.isSupported(device), create: (device) => new AsusGladiusIIHidClient(device), score: () => 10,},
  { brand: "Dareu", supports: (device) => DareuHidClient.isSupported(device), create: (device) => new DareuHidClient(device), score: () => 9 },
  { brand: "Zaunkoenig", supports: (device) => ZaunkoenigHidClient.isSupported(device), create: (device) => new ZaunkoenigHidClient(device), score: () => 10 },
  { brand: "Corsair", supports: (device) => CorsairHidClient.isSupported(device), create: (device) => new CorsairHidClient(device), score: () => 8 },
  { brand: "Finalmouse", supports: (device) => FinalmouseHidClient.isSupported(device), create: (device) => new FinalmouseHidClient(device), score: () => 10 },
  { brand: "Endgame Gear", supports: (device) => EggOp1HidClient.isSupported(device), create: (device) => new EggOp1HidClient(device), score: () => 10 },
  { brand: "Endgame Gear", supports: eggWeIsSupported, create: eggWeCreate, score: eggWeSupportScore },
  { brand: "Pulsar", supports: (device) => PulsarXs1HidClient.isSupported(device), create: (device) => new PulsarXs1HidClient(device), score: () => 8 },
  { brand: "Pulsar", supports: (device) => PulsarProHidClient.isSupported(device), create: (device) => new PulsarProHidClient(device), score: () => 8 },
  { brand: "Pulsar", supports: (device) => PulsarHidClient.isSupported(device), create: (device) => new PulsarHidClient(device), score: () => 7 },
  { brand: "Teevolution", supports: (device) => TeevolutionHidClient.isSupported(device), create: (device) => new TeevolutionHidClient(device), score: () => 7 },
  { brand: "VGN", supports: (device) => VgnF2HidClient.isSupported(device), create: (device) => new VgnF2HidClient(device), score: () => 7 },
  { brand: "Logitech", supports: (device) => LogitechHidppClient.isSupported(device), create: (device) => new LogitechHidppClient(device), score: (device) => LogitechHidppClient.supportScore(device) },
  { brand: "WLMouse", supports: (device) => WLMouseHidClient.isSupported(device), create: (device) => new WLMouseHidClient(device), score: () => 5 },
  { brand: "Lamzu", supports: (device) => LamzuHidClient.isSupported(device), create: (device) => new LamzuHidClient(device), score: () => 5 },
  { brand: "Lamzu", supports: (device) => LamzuAtlantisHidClient.isSupported(device), create: (device) => new LamzuAtlantisHidClient(device), score: () => 5 },
  { brand: "moddoMOUSE", supports: (device) => ModdoHidClient.isSupported(device), create: (device) => new ModdoHidClient(device), score: () => 5 },
  { brand: "Ninjutso", supports: (device) => NinjutsoHidClient.isSupported(device), create: (device) => new NinjutsoHidClient(device), score: () => 7 },
  { brand: "Orbital", supports: (device) => OrbitalHidClient.isSupported(device), create: (device) => new OrbitalHidClient(device), score: () => 6 },
  { brand: "Razer", supports: (device) => RazerHidClient.isSupported(device), create: (device) => new RazerHidClient(device), score: () => 6 },
  { brand: "Razer", supports: (device) => RazerCobraHidClient.isSupported(device), create: (device) => new RazerCobraHidClient(device), score: () => 6 },
  { brand: "Razer", supports: (device) => RazerViperMiniHidClient.isSupported(device), create: (device) => new RazerViperMiniHidClient(device), score: () => 6 },
  { brand: "Razer", supports: (device) => RazerViperHidClient.isSupported(device), create: (device) => new RazerViperHidClient(device), score: () => 6 },
  { brand: "ATK", supports: (device) => AtkBitmouseHidClient.isSupported(device), create: (device) => new AtkBitmouseHidClient(device), score: () => 7 },
  { brand: "ATK", supports: (device) => AtkHidClient.isSupported(device), create: (device) => new AtkHidClient(device), score: () => 5 },
  { brand: "Attack Shark", supports: (device) => AttackSharkHidClient.isSupported(device), create: (device) => new AttackSharkHidClient(device), score: () => 5 },
  { brand: "Razer", supports: (device) => RazerViperV4ProHidClient.isSupported(device), create: (device) => new RazerViperV4ProHidClient(device), score: () => 7 },
  { brand: "Keychron", supports: (device) => KeychronM6HidClient.isSupported(device), create: (device) => new KeychronM6HidClient(device), score: () => 7 },
  { brand: "Keychron", supports: (device) => KeychronNapeHidClient.isSupported(device), create: (device) => new KeychronNapeHidClient(device), score: () => 6 },
  // Ahead of Fantech: GearHub-V5 mice (Lingbao M5 Pro, Attack Shark R2, …)
  // answer on the same VID 0x3151, usage page 0xFFFF, usage 0x02 interface
  // that FantechHidClient claims, but need the 2.4G relay handshake and the
  // Bit7 checksum that driver has no notion of. Scoped to the two receiver
  // product ids so it cannot shadow Fantech's own hardware. The client
  // identifies the specific model from the device id after connecting; the
  // registry label is the M5 Pro's brand (the fallback identity).
  { brand: "Lingbao", supports: (device) => GearHubHidClient.isSupported(device), create: (device) => new GearHubHidClient(device), score: () => 7 },
  { brand: "Fantech", supports: (device) => FantechHidClient.isSupported(device), create: (device) => new FantechHidClient(device), score: () => 5 },
  { brand: "Wooting", supports: (device) => WootingHidClient.isSupported(device), create: (device) => new WootingHidClient(device), score: () => 6 },
  { brand: "WALLHACK", supports: (device) => WallhackMouseHidClient.isSupported(device), create: (device) => new WallhackMouseHidClient(device), score: () => 8 },
  { brand: "WALLHACK", supports: (device) => WallhackKeyboardHidClient.isSupported(device), create: (device) => new WallhackKeyboardHidClient(device), score: () => 8 },
  { brand: "G-Wolves", supports: (device) => GWolvesHidClient.isSupported(device), create: (device) => new GWolvesHidClient(device), score: () => 7 },
  { brand: "SteelSeries", supports: (device) => SteelSeriesRival3HidClient.isSupported(device), create: (device) => new SteelSeriesRival3HidClient(device), score: () => 6 },
  { brand: "SteelSeries", supports: (device) => SteelSeriesAerox3HidClient.isSupported(device), create: (device) => new SteelSeriesAerox3HidClient(device), score: () => 6 },
  { brand: "SteelSeries", supports: (device) => SteelSeriesRival3WirelessHidClient.isSupported(device), create: (device) => new SteelSeriesRival3WirelessHidClient(device), score: () => 6 },
  { brand: "SteelSeries", supports: (device) => SteelSeriesAerox5HidClient.isSupported(device), create: (device) => new SteelSeriesAerox5HidClient(device), score: () => 6 },
  { brand: "SteelSeries", supports: (device) => SteelSeriesAerox5WirelessHidClient.isSupported(device), create: (device) => new SteelSeriesAerox5WirelessHidClient(device), score: () => 6 },
  { brand: "SteelSeries", supports: (device) => SteelSeriesRival650HidClient.isSupported(device), create: (device) => new SteelSeriesRival650HidClient(device), score: () => 6 },
  { brand: "SteelSeries", supports: (device) => SteelSeriesAerox9WirelessHidClient.isSupported(device), create: (device) => new SteelSeriesAerox9WirelessHidClient(device), score: () => 6 },
  { brand: "SteelSeries", supports: (device) => SteelSeriesRival310HidClient.isSupported(device), create: (device) => new SteelSeriesRival310HidClient(device), score: () => 6 },
  { brand: "SteelSeries", supports: (device) => SteelSeriesPrimePlusHidClient.isSupported(device), create: (device) => new SteelSeriesPrimePlusHidClient(device), score: () => 6 },
  { brand: "SteelSeries", supports: (device) => SteelSeriesPrimeMiniWirelessHidClient.isSupported(device), create: (device) => new SteelSeriesPrimeMiniWirelessHidClient(device), score: () => 6 },
  { brand: "SteelSeries", supports: (device) => SteelSeriesSenseiTenHidClient.isSupported(device), create: (device) => new SteelSeriesSenseiTenHidClient(device), score: () => 6 },
  { brand: "Glorious", supports: (device) => GloriousHidClient.isSupported(device), create: (device) => new GloriousHidClient(device), score: () => 5 },
  { brand: "Glorious", supports: (device) => GloriousClassicHidClient.isSupported(device), create: (device) => new GloriousClassicHidClient(device), score: () => 5 },
  { brand: "MCHOSE", supports: (device) => MchoseA5ProMaxHidClient.isSupported(device), create: (device) => new MchoseA5ProMaxHidClient(device), score: () => 8 },
  { brand: "MCHOSE", supports: (device) => MchoseHidClient.isSupported(device), create: (device) => new MchoseHidClient(device), score: () => 7 },
  { brand: "MCHOSE", supports: (device) => MchoseDockHidClient.isSupported(device), create: (device) => new MchoseDockHidClient(device), score: () => 7 },
  // The A7 V3 generation shares the V2 usage page but not its protocol; the
  // two matchers are kept disjoint by product id.
  { brand: "MCHOSE", supports: (device) => MchoseV3HidClient.isSupported(device), create: (device) => new MchoseV3HidClient(device), score: () => 7 },
  { brand: "K-snake", supports: (device) => KsnakeHidClient.isSupported(device), create: (device) => new KsnakeHidClient(device), score: () => 5 },
  { brand: "Microsoft", supports: (device) => MicrosoftHidClient.isSupported(device), create: (device) => new MicrosoftHidClient(device), score: () => 5 },
  // Shares vendor id 0x093a with Glorious (see vendors.ts), but claims only
  // its own two product ids, so the two drivers never contend for a device.
  { brand: "Incott", supports: (device) => IncottHidClient.isSupported(device), create: (device) => new IncottHidClient(device), score: () => 8 },
  { brand: "HyperX", supports: (device) => HyperXHidClient.isSupported(device), create: (device) => new HyperXHidClient(device), score: () => 5 },
];

function driverFor(device: HIDDevice): DeviceDriver | undefined {
  return DEVICE_DRIVERS.find((driver) => driver.supports(device));
}

export function createSupportedClient(device: HIDDevice): SupportedClient | null {
  return driverFor(device)?.create(device) ?? null;
}

export function clientSupportScore(device: HIDDevice): number {
  return driverFor(device)?.score(device) ?? 0;
}

export function deviceBrand(client: SupportedClient): string {
  if (client instanceof EggOp1HidClient || isEggWeClient(client)) return "Endgame Gear";
  if (client instanceof LamzuHidClient) return client.deviceBrand();
  if (client instanceof AtkHidClient) return client.deviceBrand();
  return driverFor(client.device)?.brand ?? "Unknown";
}
