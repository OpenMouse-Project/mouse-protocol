import assert from "node:assert/strict";
import test from "node:test";

import {
  REDRAGON_M690_PRO_BLOCK_LENGTH,
  REDRAGON_M690_PRO_BLOCK_REPORT_ID,
  REDRAGON_M690_PRO_BUTTONS_LENGTH,
  REDRAGON_M690_PRO_CMD_IDENTIFY,
  REDRAGON_M690_PRO_CMD_LINK,
  REDRAGON_M690_PRO_CMD_STATUS,
  REDRAGON_M690_PRO_COMMAND_LENGTH,
  REDRAGON_M690_PRO_COMMAND_REPORT_ID,
  REDRAGON_M690_PRO_CONFIG_LENGTH,
  REDRAGON_M690_PRO_DEVICE_ID,
  REDRAGON_M690_PRO_MODEL_BYTE,
  REDRAGON_M690_PRO_RECEIVER_PRODUCT_ID,
  REDRAGON_M690_PRO_USAGE,
  REDRAGON_M690_PRO_USAGE_PAGE,
  REDRAGON_M690_PRO_VENDOR_ID,
} from "@openmouse/protocol/redragon";
import {
  SINOWEALTH_BLOCK_LENGTH,
  SINOWEALTH_BLOCK_REPORT_ID,
  SINOWEALTH_BUTTONS_LENGTH,
  SINOWEALTH_CMD_IDENTIFY,
  SINOWEALTH_CMD_LINK,
  SINOWEALTH_CMD_STATUS,
  SINOWEALTH_COMMAND_LENGTH,
  SINOWEALTH_COMMAND_REPORT_ID,
  SINOWEALTH_CONFIG_LENGTH,
  SINOWEALTH_KILONOVA_3335IC,
  SINOWEALTH_M690_PRO,
  SINOWEALTH_USAGE,
  SINOWEALTH_USAGE_PAGE,
  SINOWEALTH_VENDOR_ID,
  sinowealthCheckBlock,
  sinowealthCheckCommandReply,
  sinowealthDecodeIdentity,
  sinowealthDecodeLink,
  sinowealthDecodeStatus,
  sinowealthDeviceOfBlock,
  sinowealthEncodeCommand,
} from "@openmouse/protocol/sinowealth";

const bytes = (text: string): Uint8Array => Uint8Array.from(text.replace(/\s+/g, "").match(/../g)!.map((byte) => parseInt(byte, 16)));

/**
 * The Kilonova 3335IC's receiver settings bank, read in one probing session
 * (`05 21` then report 8; docs/kilonova-3335ic.md). 154 bytes like the M690
 * PRO's banks, model byte 0x11 at index 9, `a5 00` at 152-153, and a stage
 * table at 0x0d that does not name the M690 PRO's DPI list.
 */
const KILONOVA_BANK = bytes(`
  08210000000000006411043600030007000f001f003f009f0000000000000000
  00000000000000000000000000ff000000ff000000ffffff0000ffffff00ff00
  00000000000543004000ff004207ff000000ff000000ff00ffffffff00fa00fa
  ffffff034240ff000000ff000000ffffff0000ffffffffff0000000000000000
  000000004200ff00ff0000424202ff000000000000ff0000a500`);

/** A settings bank like the M690 PRO's only in the bytes this framing shares. */
const M690_LIKE_BANK = new Uint8Array(SINOWEALTH_CONFIG_LENGTH);
M690_LIKE_BANK[0] = SINOWEALTH_BLOCK_REPORT_ID;
M690_LIKE_BANK[1] = 0x21;
M690_LIKE_BANK[9] = SINOWEALTH_M690_PRO.modelByte;
M690_LIKE_BANK[SINOWEALTH_CONFIG_LENGTH - 2] = 0xa5;

test("the shared framing numbers match the Redragon module's", () => {
  assert.equal(SINOWEALTH_VENDOR_ID, REDRAGON_M690_PRO_VENDOR_ID);
  assert.equal(SINOWEALTH_USAGE_PAGE, REDRAGON_M690_PRO_USAGE_PAGE);
  assert.equal(SINOWEALTH_USAGE, REDRAGON_M690_PRO_USAGE);
  assert.equal(SINOWEALTH_COMMAND_REPORT_ID, REDRAGON_M690_PRO_COMMAND_REPORT_ID);
  assert.equal(SINOWEALTH_COMMAND_LENGTH, REDRAGON_M690_PRO_COMMAND_LENGTH);
  assert.equal(SINOWEALTH_BLOCK_REPORT_ID, REDRAGON_M690_PRO_BLOCK_REPORT_ID);
  assert.equal(SINOWEALTH_BLOCK_LENGTH, REDRAGON_M690_PRO_BLOCK_LENGTH);
  assert.equal(SINOWEALTH_CONFIG_LENGTH, REDRAGON_M690_PRO_CONFIG_LENGTH);
  assert.equal(SINOWEALTH_BUTTONS_LENGTH, REDRAGON_M690_PRO_BUTTONS_LENGTH);
  assert.equal(SINOWEALTH_CMD_IDENTIFY, REDRAGON_M690_PRO_CMD_IDENTIFY);
  assert.equal(SINOWEALTH_CMD_LINK, REDRAGON_M690_PRO_CMD_LINK);
  assert.equal(SINOWEALTH_CMD_STATUS, REDRAGON_M690_PRO_CMD_STATUS);
  assert.equal(SINOWEALTH_M690_PRO.modelByte, REDRAGON_M690_PRO_MODEL_BYTE);
  assert.equal(SINOWEALTH_M690_PRO.deviceId, REDRAGON_M690_PRO_DEVICE_ID);
  // The dongle the Kilonova 3335IC ships with is the M690 PRO receiver's id.
  assert.equal(SINOWEALTH_VENDOR_ID, 0x258a);
});

test("decodes the Kilonova 3335IC's captured short answers", () => {
  assert.equal(sinowealthDecodeIdentity(bytes("0501323331350000")), "2315");
  assert.equal(sinowealthDecodeLink(bytes("0580010100000000")), true);
  assert.deepEqual(sinowealthDecodeStatus(bytes("0590114600000000")), {
    wireless: true,
    batteryPercent: 70,
    charge: null,
    raw: 0x46,
  });
  assert.deepEqual(sinowealthEncodeCommand(SINOWEALTH_CMD_STATUS), bytes("0590000000000000"));
});

test("resolves a settings bank to its device", () => {
  assert.equal(sinowealthDeviceOfBlock(KILONOVA_BANK), SINOWEALTH_KILONOVA_3335IC);
  assert.equal(sinowealthDeviceOfBlock(M690_LIKE_BANK), SINOWEALTH_M690_PRO);
  const foreign = Uint8Array.from(KILONOVA_BANK);
  foreign[9] = 0x10;
  assert.equal(sinowealthDeviceOfBlock(foreign), null);
  assert.equal(sinowealthDeviceOfBlock(new Uint8Array(SINOWEALTH_CONFIG_LENGTH - 1)), null);
});

test("the bank checks reject foreign answers", () => {
  assert.throws(() => sinowealthCheckCommandReply(bytes("0490114600000000"), SINOWEALTH_CMD_STATUS));
  assert.throws(() => sinowealthCheckCommandReply(bytes("0580010100000000"), SINOWEALTH_CMD_STATUS));
  const noMarker = Uint8Array.from(KILONOVA_BANK);
  noMarker[SINOWEALTH_CONFIG_LENGTH - 2] = 0x00;
  sinowealthCheckBlock(noMarker, 0x21, SINOWEALTH_BUTTONS_LENGTH);
  assert.throws(() => sinowealthCheckBlock(noMarker, 0x21, SINOWEALTH_CONFIG_LENGTH));
  const wrongCommand = Uint8Array.from(KILONOVA_BANK);
  wrongCommand[1] = 0x22;
  assert.throws(() => sinowealthCheckBlock(wrongCommand, 0x21, SINOWEALTH_CONFIG_LENGTH));
  assert.throws(() => sinowealthCheckBlock(KILONOVA_BANK.subarray(0, 100), 0x21, SINOWEALTH_CONFIG_LENGTH));
});
