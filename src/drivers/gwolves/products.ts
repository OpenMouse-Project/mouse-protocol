export interface GWolvesProduct {
  model: string;
  wireless: boolean;
  /**
   * Only `verified: true` entries have been exercised against real hardware
   * by this project. Everything else would be a guess based on "probably
   * the same shared VGN-family protocol as the HTX Ultra" and should not be
   * assumed correct until actually tested — see PROTOCOL-NOTES.md in the
   * HTX Ultra PR for how the verified entries were confirmed (live HID
   * capture while using the official web driver at mouse.fit, cross-checked
   * independently with hidapitester).
   */
  verified: boolean;
}

export const GWOLVES_VENDOR_ID = 0x33e4;

export const GWOLVES_PRODUCTS: ReadonlyMap<number, GWolvesProduct> = new Map([
  [0x5618, { model: "HTX Ultra", wireless: false, verified: true }],
  [0x3854, { model: "HTX Ultra", wireless: true, verified: true }],
  // Everything below is transcribed from G-Wolves' own live web-driver config
  // (mouse.xyz's env-models.json, fetched 2026-08-30 — every entry shares the
  // HTX Ultra's vendor id 0x33e4 and "IsNewProtocol": "1"), not independently
  // hardware-tested. Add further G-Wolves models here as they're
  // captured/verified — but confirm with a real capture before setting
  // verified: true, since a wrong address/encoding on an unverified model
  // could silently write the wrong value rather than fail loudly.
  [0x3808, { model: "HTM Plus", wireless: false, verified: false }],
  [0x3817, { model: "HTM Plus", wireless: true, verified: false }],
  [0x6808, { model: "HSK Pro 2.0", wireless: false, verified: false }],
  [0x6817, { model: "HSK Pro 2.0", wireless: true, verified: false }],
  [0x5608, { model: "HTXU", wireless: false, verified: false }],
  [0x5617, { model: "HTXU", wireless: true, verified: false }],
  [0x3608, { model: "Fenrir Pro", wireless: false, verified: false }],
  [0x3617, { model: "Fenrir Pro", wireless: true, verified: false }],
  [0x3908, { model: "VUK", wireless: false, verified: false }],
  [0x3917, { model: "VUK", wireless: true, verified: false }],
  [0x7904, { model: "HT-S2", wireless: false, verified: false }],
  [0x7913, { model: "HT-S2", wireless: true, verified: false }],
  [0x3708, { model: "Fenir Max", wireless: false, verified: false }],
  [0x3717, { model: "Fenir Max", wireless: true, verified: false }],
  [0x5308, { model: "HTS Ultra", wireless: false, verified: false }],
  [0x5317, { model: "HTS Ultra", wireless: true, verified: false }],
  [0x7704, { model: "HTR", wireless: false, verified: false }],
  [0x7713, { model: "HTR", wireless: true, verified: false }],
  [0x3508, { model: "Fenrir", wireless: false, verified: false }],
  [0x3517, { model: "Fenrir", wireless: true, verified: false }],
  [0x7908, { model: "HT-S2 Pro", wireless: false, verified: false }],
  [0x7917, { model: "HT-S2 Pro", wireless: true, verified: false }],
  [0x5808, { model: "HSK Pro", wireless: false, verified: false }],
  [0x5817, { model: "HSK Pro", wireless: true, verified: false }],
  [0x2708, { model: "HTX Mini", wireless: false, verified: false }],
  [0x2717, { model: "HTX Mini", wireless: true, verified: false }],
  [0x5408, { model: "HTS Plus", wireless: false, verified: false }],
  [0x5417, { model: "HTS Plus", wireless: true, verified: false }],
  [0x5708, { model: "HTX", wireless: false, verified: false }],
  [0x5717, { model: "HTX", wireless: true, verified: false }],
  [0x5908, { model: "HSK Plus", wireless: false, verified: false }],
  [0x5917, { model: "HSK Plus", wireless: true, verified: false }],
  [0x7708, { model: "HTR Pro", wireless: false, verified: false }],
  [0x7717, { model: "HTR Pro", wireless: true, verified: false }],
  [0x5804, { model: "HSK Pro ACE", wireless: false, verified: false }],
  [0x5803, { model: "HSK Pro ACE", wireless: true, verified: false }],
  [0x5404, { model: "HTS Plus ACE", wireless: false, verified: false }],
  [0x5403, { model: "HTS Plus ACE", wireless: true, verified: false }],
  [0x5704, { model: "HTX ACE", wireless: false, verified: false }],
  [0x5703, { model: "HTX ACE", wireless: true, verified: false }],
  [0x5904, { model: "HSK Plus ACE", wireless: false, verified: false }],
  [0x5903, { model: "HSK Plus ACE", wireless: true, verified: false }],
  // "TEST HTS Plus" in that config (wired 0x5428, wireless 0x3854) is
  // deliberately skipped: its own name marks it a dev/test entry, and its
  // wireless id collides with the already-verified HTX Ultra's 0x3854.
]);
