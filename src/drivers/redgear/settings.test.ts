import assert from "node:assert/strict";
import test from "node:test";
import {
  redgearDecodeRawStatus,
  redgearDecodeSettings,
  redgearEncodeDpi,
  redgearEncodePollingRate,
  redgearEncodeStaticColor,
  redgearEncodeVendorStaticColor,
  redgearDecodeStaticColor,
} from "../../redgear/index.js";
import { X13_NATIVE_STATUS_HEX } from "./status-fixture.js";

// Independent intercepted vendor API arguments. Calls were denied before USB transmission.
const vendor = [
  {
    dpi: 4000,
    rate: 1000,
    hex: "0305033000ff00000102030405060700ff000000ff000000ffffff0000ffffff00ffffffff000000",
  },
  {
    dpi: 2400,
    rate: 1000,
    hex: "0303033000ff00000102030405060700ff000000ff000000ffffff0000ffffff00ffffffff000000",
  },
  {
    dpi: 800,
    rate: 1000,
    hex: "0301033000ff00000102030405060700ff000000ff000000ffffff0000ffffff00ffffffff000000",
  },
  {
    dpi: 4000,
    rate: 500,
    hex: "0305023000ff00000102030405060700ff000000ff000000ffffff0000ffffff00ffffffff000000",
  },
  {
    dpi: 4000,
    rate: 250,
    hex: "0305013000ff00000102030405060700ff000000ff000000ffffff0000ffffff00ffffffff000000",
  },
  {
    dpi: 4000,
    rate: 125,
    hex: "0305003000ff00000102030405060700ff000000ff000000ffffff0000ffffff00ffffffff000000",
  },
];
const payload = (hex: string) =>
  redgearDecodeRawStatus(Uint8Array.from(Buffer.from(hex, "hex"))).payload;

test("DPI/rate decoder matches independent vendor API captures", () => {
  for (const row of vendor)
    assert.deepEqual(redgearDecodeSettings(payload(row.hex)), {
      dpi: row.dpi,
      pollingRateHz: row.rate,
    });
  assert.deepEqual(redgearDecodeSettings(payload(X13_NATIVE_STATUS_HEX)), {
    dpi: 4000,
    pollingRateHz: 1000,
  });
});

test("encoders reproduce vendor changes and preserve every unrelated native byte", () => {
  const base = payload(vendor[0]!.hex);
  for (const row of vendor) {
    const expected = payload(row.hex);
    const result =
      row.rate === 1000
        ? redgearEncodeDpi(base, row.dpi)
        : redgearEncodePollingRate(base, row.rate);
    assert.deepEqual(result, expected);
    assert.deepEqual(base, payload(vendor[0]!.hex));
  }
  const native = payload(X13_NATIVE_STATUS_HEX);
  for (const [result, offset] of [
    [redgearEncodeDpi(native, 2400), 0],
    [redgearEncodePollingRate(native, 500), 1],
  ] as const) {
    for (let i = 0; i < 39; i++)
      if (i !== offset) assert.equal(result[i], native[i]);
    assert.equal(result[2], 0x31); // vendor cached Apply would overwrite this unknown lighting bit.
  }
});

test("settings codec rejects unsupported values, invalid codes and malformed frames", () => {
  const base = payload(X13_NATIVE_STATUS_HEX);
  for (const dpi of [0, 401, 1600, 16400, NaN, Infinity, 2400.5])
    assert.throws(() => redgearEncodeDpi(base, dpi));
  for (const rate of [0, 126, 2000, NaN, 500.5])
    assert.throws(() => redgearEncodePollingRate(base, rate));
  for (const size of [0, 38, 40])
    assert.throws(() => redgearDecodeSettings(new Uint8Array(size)));
  const bad = base.slice();
  bad[0] = 7;
  assert.throws(() => redgearDecodeSettings(bad));
  bad[0] = 5;
  bad[1] = 4;
  assert.throws(() => redgearEncodeDpi(bad, 2400));
});

test("static colour matches two independent vendor calls and preserves unrelated bytes", () => {
  const red = payload(
    "0305030000ff00000102030405060700ff000000ff000000ffffff0000ffffff00ffffffff000000",
  );
  const green = payload(
    "030503000000ff000102030405060700ff000000ff000000ffffff0000ffffff00ffffffff000000",
  );
  assert.deepEqual(redgearEncodeVendorStaticColor(red, "#00ff00"), green);
  assert.deepEqual(redgearEncodeVendorStaticColor(green, "#ff0000"), red);
  const native = payload(X13_NATIVE_STATUS_HEX);
  const changed = redgearEncodeVendorStaticColor(native, "#00ff00");
  assert.deepEqual(changed, green);
  const unknown = native.slice();
  unknown[2] = 0x3f;
  assert.equal(redgearEncodeStaticColor(unknown, "#00ff00")[2], 0x0e);
  for (const color of ["red", "#fff", "#gg0000", "00ff00"])
    assert.throws(() => redgearEncodeStaticColor(native, color));
});

test("hardware colour correction matches independently observed R,B,G channel trials", () => {
  const original = payload(
    "03050300043235ff0102030405060700ff000000ff000000ffffff0000ffffff00ffffffff000000",
  );
  const observed = [
    {
      color: "#ff0000",
      hex: "0305030004ff00000102030405060700ff000000ff000000ffffff0000ffffff00ffffffff000000",
    },
    {
      color: "#0000ff",
      hex: "030503000400ff000102030405060700ff000000ff000000ffffff0000ffffff00ffffffff000000",
    },
    {
      color: "#00ff00",
      hex: "03050300040000ff0102030405060700ff000000ff000000ffffff0000ffffff00ffffffff000000",
    },
  ];
  for (const row of observed) {
    assert.deepEqual(
      redgearEncodeStaticColor(original, row.color),
      payload(row.hex),
    );
    assert.deepEqual(redgearDecodeStaticColor(payload(row.hex)), {
      mode: "Static",
      color: row.color,
    });
  }
  assert.equal(redgearDecodeStaticColor(original).color, "#32ff35");
  assert.equal(
    redgearDecodeStaticColor(payload(X13_NATIVE_STATUS_HEX)).mode,
    null,
  );
  assert.throws(() => redgearEncodeStaticColor(original, "green"));
});
