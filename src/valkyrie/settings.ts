export type ValkyriePollingSettings = {
  readonly pollingCodeRaw: number;
  readonly rawReply: Uint8Array;
};

export type ValkyrieDpiSettings = {
  readonly activeCountRaw: number;
  readonly activeIndexRaw: number;
  readonly stagesRaw: readonly { readonly x: number; readonly y: number }[];
  readonly rawReply: Uint8Array;
};

function readRequest(command: 0x12 | 0x13): Uint8Array {
  const payload = new Uint8Array(32);
  payload[0] = command;
  return payload;
}

export function valkyrieEncodePollingRequest(): Uint8Array {
  return readRequest(0x12);
}

export function valkyrieEncodeDpiRequest(): Uint8Array {
  return readRequest(0x13);
}

function replyView(payload: Uint8Array, command: number, dataLength: number): DataView | undefined {
  if (payload.length !== 32) return undefined;
  if (payload[0] !== command || payload[1] !== 0 || payload[2] !== 1 || payload[3] !== dataLength) {
    return undefined;
  }
  const checksum = payload.subarray(4, 31).reduce((sum, byte) => sum + byte, 0) & 0xff;
  if (payload[31] !== checksum) return undefined;
  return new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
}

/** Returns uninterpreted wire values and an independent copy of the complete reply. */
export function valkyrieDecodePollingReply(payload: Uint8Array): ValkyriePollingSettings | undefined {
  const view = replyView(payload, 0x12, 1);
  if (!view) return undefined;
  return { pollingCodeRaw: view.getUint8(4), rawReply: payload.slice() };
}

/** The stage nibbles and six coordinate pairs remain raw; no DPI scale or index base is assumed. */
export function valkyrieDecodeDpiReply(payload: Uint8Array): ValkyrieDpiSettings | undefined {
  const view = replyView(payload, 0x13, 0x19);
  if (!view) return undefined;
  const stageByte = view.getUint8(4);
  return {
    activeCountRaw: stageByte & 0x0f,
    activeIndexRaw: stageByte >>> 4,
    stagesRaw: Array.from({ length: 6 }, (_, index) => ({
      x: view.getUint16(5 + index * 4, true),
      y: view.getUint16(7 + index * 4, true),
    })),
    rawReply: payload.slice(),
  };
}

/** Codes 1/2/4/8 (1000/500/250/125 Hz); requires a complete validated polling read reply. */
export function valkyrieEncodePollingWrite(rawReply: Uint8Array, code: number): Uint8Array {
  const settings = valkyrieDecodePollingReply(rawReply);
  if (!settings) throw new RangeError("Invalid Valkyrie polling reply");
  if (code !== 1 && code !== 2 && code !== 4 && code !== 8) {
    throw new RangeError("Valkyrie polling code must be 1, 2, 4, or 8");
  }
  const payload = settings.rawReply;
  payload[0] = 0x02;
  payload[4] = code;
  payload[31] = payload.subarray(4, 31).reduce((sum, byte) => sum + byte, 0) & 0xff;
  return payload;
}

/**
 * Sensor-0x11 raw range only (1..232), with equal X/Y values. The caller must
 * establish the sensor separately and restrict writes to active stages.
 * Returns the verified 32-byte write payload, excluding transport report ID zero.
 */
export function valkyrieEncodeDpiStageWrite(rawReply: Uint8Array, stage: number, rawValue: number): Uint8Array {
  const settings = valkyrieDecodeDpiReply(rawReply);
  if (!settings) throw new RangeError("Invalid Valkyrie DPI reply");
  if (!Number.isInteger(stage) || stage < 0 || stage > 5) {
    throw new RangeError("Valkyrie DPI stage must be an integer from 0 through 5");
  }
  if (!Number.isInteger(rawValue) || rawValue < 1 || rawValue > 232) {
    throw new RangeError("Valkyrie sensor-0x11 raw DPI must be an integer from 1 through 232");
  }
  const payload = settings.rawReply;
  payload[0] = 0x03;
  payload[3] = 0x25;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  view.setUint16(5 + stage * 4, rawValue, true);
  view.setUint16(7 + stage * 4, rawValue, true);
  payload[31] = payload.subarray(4, 31).reduce((sum, byte) => sum + byte, 0) & 0xff;
  return payload;
}
