import assert from "node:assert/strict";
import test from "node:test";
import { VAXEE_COMMAND, VAXEE_REPORT_SIZE, vaxeeDpi, vaxeePollingCode, vaxeePollingRate, vaxeeReply, vaxeeRequest } from "./index.ts";

test("VAXEE DPI request and reply use the Control Center byte positions", () => {
  const request = vaxeeRequest(VAXEE_COMMAND.dpiValue, 3, [2, 0x88, 0x13], true);
  assert.equal(request.length, VAXEE_REPORT_SIZE);
  assert.deepEqual([...request.slice(0, 7)], [0xa5, 4, 2, 3, 2, 0x88, 0x13]);
  const response = new Uint8Array(VAXEE_REPORT_SIZE);
  response.set([0xa5, 4, 3, 1, 3, 2, 0x88, 0x13]);
  assert.equal(vaxeeDpi(vaxeeReply(response, VAXEE_COMMAND.dpiValue, 3)), 5000);
});

test("VAXEE rejects truncated, mismatched, and invalid reports", () => {
  const reply = new Uint8Array([0xa5, 4, 3, 1, 1, 2]);
  assert.throws(() => vaxeeReply(reply, 4, 3));
  assert.throws(() => vaxeeReply(reply, 7, 1));
  assert.throws(() => vaxeeRequest(4, 1, [256]));
  assert.equal(vaxeePollingRate(vaxeePollingCode(4000)), 4000);
  assert.throws(() => vaxeePollingCode(125));
});
