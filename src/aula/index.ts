export const SC380_PRO_VENDOR_ID = 0x258a;
export const SC380_PRO_RECEIVER_ID = 0x0138;
export const SC380_PRO_USAGE_PAGE = 0xff02;
export const SC380_PRO_USAGE = 0x02;
export const SC380_PRO_REPORT_ID = 0x09;

export const SC380_PRO_READ_SETTINGS = 0x44;
export const SC380_PRO_SETTINGS_LENGTH = 400;
export const SC380_PRO_POLLING_RATES = [125, 250, 500, 1000] as const;
export const SC380_PRO_DPI_STEP = 100;
export const SC380_PRO_MAX_DPI = 12000;

const REPORT_LENGTH = 520;
const HEADER_LENGTH = 8;
const SETTINGS_MARKER = 0x64;
const PAW3311_CODE = 0x18;
const DPI_X_OFFSET = 7;
const DPI_Y_OFFSET = 27;

export function encodeSc380ProReport(command: number, argument: number, length: number, data?: Uint8Array): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(length) || length < 0 || length > REPORT_LENGTH - HEADER_LENGTH
      || (data && data.length !== length)) {
    throw new Error("Invalid AULA SC380 Pro report length.");
  }

  // WebHID supplies the report ID separately.
  const payload = new Uint8Array(REPORT_LENGTH - 1);
  payload.set([command, argument, 1, 0, length & 0xff, length >> 8], 1);
  if (data) payload.set(data, HEADER_LENGTH - 1);
  payload[0] = payload.reduce((sum, byte) => sum + byte, 0) & 0xff;
  return payload;
}

export function decodeSc380ProReply(reply: Uint8Array, command: number, argument: number, length: number): Uint8Array {
  // Some WebHID transports include the report ID in the DataView.
  for (const offset of reply[0] === SC380_PRO_REPORT_ID ? [1, 0] : [0]) {
    const start = offset + HEADER_LENGTH - 1;
    if (reply.length >= start + length && reply[offset + 1] === command
        && reply[offset + 2] === argument && reply[offset + 3] === 1 && reply[offset + 4] === 0
        && reply[offset + 5] === (length & 0xff) && reply[offset + 6] === (length >> 8)) {
      if (command === SC380_PRO_READ_SETTINGS) {
        const checksum = reply.subarray(offset + 1, start + length).reduce((sum, byte) => sum + byte, 0) & 0xff;
        if (reply[offset] !== checksum) {
          if (offset === 1) continue;
          throw new Error("Invalid AULA SC380 Pro settings checksum.");
        }
      }
      return reply.slice(start, start + length);
    }
  }
  throw new Error("Unexpected AULA SC380 Pro reply.");
}

export function decodeSc380ProSettings(block: Uint8Array) {
  if (block.length !== SC380_PRO_SETTINGS_LENGTH) throw new Error("Unexpected AULA SC380 Pro settings block.");
  const count = block[3]! & 0x0f;
  const active = (block[3]! >> 4) - 1;
  const polling = SC380_PRO_POLLING_RATES[(block[2]! & 0x0f) - 1];
  if (block[0] !== SETTINGS_MARKER
      || (block[1]! & 0x1f) !== PAW3311_CODE || count < 1 || count > 6
      || active < 0 || active >= count || polling === undefined) {
    throw new Error("Unexpected AULA SC380 Pro settings block.");
  }
  const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
  const readStages = (start: number) => Array.from({ length: count }, (_, stage) =>
    (view.getUint16(start + 2 * stage, true) + 1) * SC380_PRO_DPI_STEP);
  const x = readStages(DPI_X_OFFSET);
  const y = readStages(DPI_Y_OFFSET);
  if ([...x, ...y].some((dpi) => dpi > SC380_PRO_MAX_DPI)) {
    throw new Error("Unexpected AULA SC380 Pro DPI value.");
  }
  return { active, polling, x, y };
}

export function setSc380ProStageDpi(block: Uint8Array, stage: number, x: number, y: number): void {
  const { x: stages } = decodeSc380ProSettings(block);
  if (!Number.isInteger(stage) || stage < 0 || stage >= stages.length) {
    throw new Error("Invalid AULA SC380 Pro DPI stage.");
  }
  if ([x, y].some((dpi) => !Number.isInteger(dpi) || dpi < SC380_PRO_DPI_STEP
      || dpi > SC380_PRO_MAX_DPI || dpi % SC380_PRO_DPI_STEP !== 0)) {
    throw new Error("Invalid AULA SC380 Pro DPI value.");
  }
  const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
  view.setUint16(DPI_X_OFFSET + 2 * stage, x / SC380_PRO_DPI_STEP - 1, true);
  view.setUint16(DPI_Y_OFFSET + 2 * stage, y / SC380_PRO_DPI_STEP - 1, true);
}
