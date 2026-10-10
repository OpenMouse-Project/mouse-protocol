import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEVICE_DRIVERS } from "./registry.ts";
import { SUPPORTED_HID_FILTERS, VENDOR_ID } from "./vendors.ts";
import { LAMZU_ATLANTIS_PRODUCTS, LAMZU_PRODUCTS } from "@openmouse/protocol/lamzu";
import { ORBITAL_DEVICES } from "@openmouse/protocol/orbital";
import { MCHOSE_V3_PRODUCT_IDS } from "@openmouse/protocol/mchose";
import { KEYCHRON_8K_NORDIC_PRODUCT_IDS } from "@openmouse/protocol/keychron";
import {
  DELUX_M600_PRO_WIRED_PID,
  DELUX_M800_MINI_WIRELESS_PID,
  DELUX_OEM_VENDOR_ID,
} from "@openmouse/protocol/delux";
import { COOLERMASTER_PRODUCT_IDS } from "@openmouse/protocol/coolermaster";

const DEVICES_DIR = dirname(fileURLToPath(import.meta.url));

const REPORT_IDS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 0x09, 0x0e, 0x0f, 0x10, 0x11, 0x20, 0x51, 0xa1, 0xb3, 0xb4, 0xb5];
const USAGE_PAGES = [0x01, 0x0a, 0x0c, 0x8c, 0xFF07, 0xff, 0xff00, 0xff01, 0xff02, 0xff05, 0xff0a, 0xff1c, 0xff42, 0xff43, 0xff55, 0xff60, 0xffa0, 0xffc0, 0xffc1, 0xffc2, 0xffff];
// Usage 4 is the Corsair config collection; 0x61 is VIA raw HID; 0xc7 is
// Ryunix telemetry; 0x0e is Rapoo's 0xBA configuration channel.
const USAGES = [0, 1, 0x0202, 0x0212, 2, 4, 0x0e, 0x10, 0x61, 0xc7];

function report(reportId: number, byteLength = 16): HIDReportInfo {
  return { reportId, items: [{ reportSize: 8, reportCount: byteLength }] } as unknown as HIDReportInfo;
}

function collection(
  usagePage: number,
  usage: number,
  options: { feature?: number[]; input?: number[]; output?: number[] } = {},
): HIDCollectionInfo {
  return {
    usagePage,
    usage,
    type: 1,
    children: [],
    featureReports: (options.feature ?? []).map((id) => report(id)),
    inputReports: (options.input ?? []).map((id) => report(id)),
    outputReports: (options.output ?? []).map((id) => report(id)),
  } as unknown as HIDCollectionInfo;
}

/**
 * The collection shapes a hypothetical device can present.
 *
 * The vocabulary is deliberately finite so the sweep can exhaust it, but it is
 * kept as small as it can be while still firing every driver: each usage page ×
 * usage gets one collection carrying every report id, plus singleton shapes for
 * the drivers that require exactly one input/output report (Teevolution,
 * Pulsar) or a lone feature report. The exhaustive per-page × per-usage ×
 * per-report-id cross product this used to enumerate was ~8,600 shapes and made
 * the file take ~15 minutes; this pruned set is ~250. The "every driver fires"
 * assertion below is the guard that the pruning did not drop a driver.
 */
function collectionShapes(): HIDCollectionInfo[][] {
  const shapes: HIDCollectionInfo[][] = [[]];
  // Dareu's receiver exposes a service collection beside its report-8 command
  // channel; retain both so strict multi-collection drivers are exercisable.
  shapes.push([
    collection(0xff05, 0),
    collection(0xff02, 2, { input: [8], output: [8] }),
  ]);
  // G-Wolves XVI: a single unnumbered 64-byte feature report, found by shape.
  shapes.push([{ ...collection(0xff00, 1), featureReports: [report(0, 64)] } as HIDCollectionInfo]);
  // A device offering every usage page at once, so a driver that only needs one
  // of them is reachable without a shape per page.
  shapes.push(USAGE_PAGES.map((page) =>
    collection(page, 1, { feature: REPORT_IDS, input: REPORT_IDS, output: REPORT_IDS })));
  for (const page of USAGE_PAGES) {
    for (const usage of USAGES) {
      shapes.push([collection(page, usage, { feature: REPORT_IDS, input: REPORT_IDS, output: REPORT_IDS })]);
    }
  }
  for (const id of REPORT_IDS) {
    // Exactly one input and one output report.
    shapes.push([collection(0x01, 0, { input: [id], output: [id] })]);
    // Exactly one feature report.
    shapes.push([collection(0x01, 0, { feature: [id] })]);
  }
  // The Pulsar XS1 dongle is claimed on the 0xffff:0x01 feature interface but
  // only when no legacy input/output control collection sits beside it, so
  // probe that interface feature-only.
  shapes.push([collection(0xffff, 0x01, { feature: REPORT_IDS })]);
  return shapes;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
  });
}

function candidateProductIds(): number[] {
  const ids = new Set<number>([
    0x0000,
    0x0001,
    0x1234,
    0xffff,
    ...LAMZU_PRODUCTS.keys(),
    ...LAMZU_ATLANTIS_PRODUCTS.keys(),
    ...ORBITAL_DEVICES.keys(),
    // The MCHOSE V3 driver matches on an id allowlist and shares its usage
    // page with the V2, so the probe needs a real one to reach it at all.
    ...MCHOSE_V3_PRODUCT_IDS,
    // The Keychron 8K Nordic driver claims its ids out of the 4K family's
    // shared collection, so the probe needs them to reach it.
    ...KEYCHRON_8K_NORDIC_PRODUCT_IDS,
    // The Cooler Master driver matches on an id allowlist, but its only
    // product id (0x0101) is defined in src/coolermaster/ and appears as no
    // literal under src/drivers/, so the source scan below would not find it.
    ...COOLERMASTER_PRODUCT_IDS,
    // Claimed by id alone and defined outside src/drivers, so the source
    // scan below would not find it.
    DELUX_M600_PRO_WIRED_PID,
  ]);
  for (const filter of SUPPORTED_HID_FILTERS) {
    if (filter.productId !== undefined) ids.add(filter.productId);
  }
  for (const file of sourceFiles(DEVICES_DIR)) {
    const text = readFileSync(file, "utf8");
    // Ids a driver compares directly against `device.productId`.
    for (const line of text.split("\n")) {
      if (!/product|pid/i.test(line)) continue;
      for (const match of line.matchAll(/0x[0-9a-f]{4}\b/gi)) {
        ids.add(Number.parseInt(match[0], 16));
      }
    }
    // Ids listed inside a product-id set or map. Their entries rarely carry the
    // word "product" on the line itself (e.g. Glorious' [[0x821d, {…}]] table,
    // Gravastar's bare id list), so match the declaration and take every id
    // literal up to the closing bracket. Scanning every 0x#### literal in the
    // tree instead pulled in ~700 report sizes and command bytes that no driver
    // can ever match on; this keeps the list to real product ids.
    for (const decl of text.matchAll(
      /(?:PRODUCT_IDS|PRODUCTS|PRODUCT_MAP|productIds?)\b[^=\n]*[=:][^=\n]*?(?:new\s+(?:Set|Map)\s*\(|\[)/gi,
    )) {
      let depth = 1;
      let cursor = (decl.index ?? 0) + decl[0].length;
      const start = cursor;
      while (cursor < text.length && depth > 0) {
        const ch = text[cursor];
        if (ch === "[" || ch === "(") depth += 1;
        else if (ch === "]" || ch === ")") depth -= 1;
        cursor += 1;
      }
      for (const match of text.slice(start, cursor).matchAll(/0x[0-9a-f]{4}\b/gi)) {
        ids.add(Number.parseInt(match[0], 16));
      }
    }
  }
  return [...ids];
}

const SHAPES = collectionShapes();
const PRODUCT_IDS = candidateProductIds();
const VENDOR_IDS = [...new Set(Object.values(VENDOR_ID))];

const probe = {
  vendorId: 0,
  productId: 0,
  productName: "probe",
  opened: false,
  collections: [] as HIDCollectionInfo[],
} as unknown as HIDDevice;

const NAMED_PROBES = [
  {
    vendorId: DELUX_OEM_VENDOR_ID,
    productId: DELUX_M800_MINI_WIRELESS_PID,
    productName: "Delux M800 Mini",
    collections: [] as HIDCollectionInfo[],
  },
  {
    vendorId: DELUX_OEM_VENDOR_ID,
    productId: DELUX_M600_PRO_WIRED_PID,
    productName: "USB Gaming Mouse",
    collections: [collection(0x0b, 0, { feature: [4, 6] })],
  },
] as const;

function claimsFor(
  vendorId: number,
  productId: number,
  collections: HIDCollectionInfo[],
  productName = "probe",
): string[] {
  const mutable = probe as unknown as {
    vendorId: number;
    productId: number;
    productName: string;
    collections: HIDCollectionInfo[];
  };
  mutable.vendorId = vendorId;
  mutable.productId = productId;
  mutable.productName = productName;
  mutable.collections = collections;
  const claims: string[] = [];
  for (const driver of DEVICE_DRIVERS) {
    if (driver.supports(probe)) claims.push(driver.brand);
  }
  return claims;
}

/**
 * One pass over the whole probe space. Both the coverage check and the overlap
 * check read this single result: the space is millions of devices × 80
 * drivers, and sweeping it once per test doubled the file's cost for no
 * benefit.
 */
function sweepProbeSpace(): { fired: Set<number>; clashes: string[] } {
  const fired = new Set<number>();
  const clashes = new Set<string>();
  const visit = (
    vendorId: number,
    productId: number,
    collections: HIDCollectionInfo[],
    productName = "probe",
  ): void => {
    const mutable = probe as unknown as {
      vendorId: number;
      productId: number;
      productName: string;
      collections: HIDCollectionInfo[];
    };
    mutable.vendorId = vendorId;
    mutable.productId = productId;
    mutable.productName = productName;
    mutable.collections = collections;
    const claims: string[] = [];
    DEVICE_DRIVERS.forEach((driver, index) => {
      if (driver.supports(probe)) {
        fired.add(index);
        claims.push(driver.brand);
      }
    });
    if (claims.length > 1) {
      clashes.add(
        `vid 0x${vendorId.toString(16)} pid 0x${productId.toString(16)}`
        + (productName === "probe" ? "" : ` name "${productName}"`)
        + `: ${claims.join(" + ")}`,
      );
    }
  };
  for (const vendorId of VENDOR_IDS) {
    for (const productId of PRODUCT_IDS) {
      for (const collections of SHAPES) visit(vendorId, productId, collections);
    }
  }
  for (const named of NAMED_PROBES) {
    visit(named.vendorId, named.productId, named.collections, named.productName);
  }
  return { fired, clashes: [...clashes] };
}

const PROBE_RESULT = sweepProbeSpace();

test("the probe matrix can trigger every driver", () => {
  const never = DEVICE_DRIVERS
    .map((driver, index) => ({ driver, index }))
    .filter(({ index }) => !PROBE_RESULT.fired.has(index))
    .map(({ driver, index }) => `[${index}] ${driver.brand}`);
  assert.deepEqual(
    never,
    [],
    "No synthetic device satisfies this driver's isSupported(), so the overlap test above proves nothing about it. Add its report id, usage page, or product id to REPORT_IDS / USAGE_PAGES.",
  );
});

test("no device can be claimed by more than one driver", () => {
  assert.deepEqual(
    PROBE_RESULT.clashes,
    [],
    "Two drivers accept the same device. driverFor() returns the first match in DEVICE_DRIVERS, so the later one is silently dead. Narrow one driver's isSupported().",
  );
});

test("every product id offered in the picker has a driver", () => {
  const orphans: string[] = [];
  for (const filter of SUPPORTED_HID_FILTERS) {
    const { vendorId, productId } = filter;
    if (vendorId === undefined || productId === undefined) continue;
    const claimed = SHAPES.some((collections) => claimsFor(vendorId, productId, collections).length > 0);
    if (!claimed) orphans.push(`vid 0x${vendorId.toString(16)} pid 0x${productId.toString(16)}`);
  }
  assert.deepEqual(
    orphans,
    [],
    "These ids are offered in the browser picker but no driver accepts them, so the device connects and then fails to read.",
  );
});

const WITHOUT_TESTS = new Set(["lamzu"]);

function deviceDirectories(): string[] {
  return readdirSync(DEVICES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

test("a new device directory ships tests", () => {
  const missing = deviceDirectories().filter((name) =>
    !WITHOUT_TESTS.has(name) && !readdirSync(join(DEVICES_DIR, name)).some((file) => file.endsWith(".test.ts")));
  assert.deepEqual(missing, [], "Add a *.test.ts covering this device's protocol encoding.");
});

test("the grandfathered list only names directories that still exist", () => {
  const present = new Set(deviceDirectories());
  const stale = [...WITHOUT_TESTS].filter((name) => !present.has(name));
  assert.deepEqual(stale, [], "Remove stale entries from WITHOUT_TESTS as devices gain coverage.");
});

test("every exported HID filter list is offered in the picker", async () => {
  const vendors = await import("./vendors.ts") as Record<string, unknown>;
  const offered = new Set(SUPPORTED_HID_FILTERS.map((filter) => JSON.stringify(filter)));
  const orphans: string[] = [];
  for (const [name, value] of Object.entries(vendors)) {
    if (name === "SUPPORTED_HID_FILTERS" || !name.endsWith("FILTERS") || !Array.isArray(value)) continue;
    if (!value.every((filter) => offered.has(JSON.stringify(filter)))) orphans.push(name);
  }
  assert.deepEqual(
    orphans,
    [],
    "These filters are defined but never spread into SUPPORTED_HID_FILTERS, so the browser picker never offers the device and it is simply never detected.",
  );
});
