# AJAZZ NJ07 / NJ08 family

Requested in the OpenMouse Discord (ticket 0156) for the NJ07 MC. No capture
of any of these mice exists. The driver was written from the JavaScript of the
vendor's WebHID panel, https://nacodex.yjx2012.com/ (device class "V1",
Next.js chunk 515 plus the `/detail` route), and has not run on hardware.

## Which mice

The panel requests these product ids on VID `0xA8A4` (wired) and `0xA8A5`
(2.4 GHz dongle), usage page `0xFF01`, usage `0x10`:

- `0x2157` NJ07 and `0x2158` NJ08, panel DPI range 50 to 12800
- `0x2167` NJ07 MC and `0x2168` NJ08 MC, panel DPI range 50 to 24000
- `0x2177` NJ07 MC PRO and `0x2178` NJ08 MC PRO, panel DPI range 50 to 24000

Left out on purpose: `0x2255` (NJ07/NJ08 V2 and Ultra, but also the K-snake
X11, which the K-snake driver owns; telling them apart needs a descriptor
dump) and `0x2216` (VIDs `0xA8A7`/`0xA8A9`), which the panel requests but no
model in its device table uses.

## Frame

Same command family as the K-snake X11, different framing:

- Output report `0xF0`, 63 bytes. The reply is an input report whose first
  data byte echoes the command; the mouse also pushes DPI (`0xFA`), battery
  (`0x30`) and status (`0xED`) reports unprompted.
- `0x04` version, `0x30` battery, `0x0E` read config, `0x0F` write config.
- Read config is `0E 01 0B 2E`, write config starts `0F 01 0A 2F`. Offsets in
  `src/ajazz/index.ts` are body offsets (the report id is not counted).
- The config block holds light mode, polling index (0 to 3 for 125, 250, 500,
  1000 Hz), six little-endian DPI stages, active stage, scroll direction,
  lift-off, sensor flags, key debounce, sleep minutes (0 = never), a high
  speed flag and one wake/move-light byte.
- A write replaces the whole block, so every setter reads the block, patches
  one field, writes, then reads back and fails if the mouse kept the old value.

## One deliberate difference from the panel

The panel writes `wakeup << 4 | move_light` but reads both fields back from
the high nibble, so a save flips the move-light bit. The driver keeps that
byte opaque and writes back exactly what it read.

## What the driver does

Identity, battery, firmware, DPI stages (read, edit one stage, pick the active
stage), polling rate (125, 500, 1000 Hz, the panel's per-model list), sleep
timer and scroll direction.

Not done: buttons and macros (same slot layout as the K-snake, report `0x08`
and `0x09`), lighting (the panel only shows it for the NJ08 family, modes 0
to 6), wake mode, line correction, lift-off, debounce. The panel has no
controls for the last two.

## To test

1. Connect in Chrome through control.openmouse.app, wired and on the dongle.
2. Status shows the model name, DPI stages, polling rate, sleep timer and
   battery. If settings stay hidden, the read did not echo: send the console
   log.
3. Change DPI on one stage, the polling rate, the sleep timer and the scroll
   direction. Each write reads back and errors if the mouse kept the old value.
4. Confirm the change in the vendor panel (nacodex.yjx2012.com) or by feel.
