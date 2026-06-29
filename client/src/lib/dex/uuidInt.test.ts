/**
 * Unit tests for the the venue uuid_int composite encoder.
 *
 * The bit layout (high → low) is:
 *   [255:252]  4 bits   executor_id
 *   [251:124]  128 bits uuid
 *   [123:12]   112 bits group_order_id
 *   [11:0]     12 bits  leg_id
 *
 * Round-trip tests across the boundary values verify the masks/shifts.
 */
import { describe, expect, it } from "vitest";
import {
  decodeUuidInt,
  encodeStandalone,
  encodeVlSibling,
  generateUuid4,
  makeRandomUuid,
  uuidStringToBigInt,
} from "./uuidInt";

describe("uuidInt encoder", () => {
  it("encodes a standalone order with executor 0 and zero uuid as zero", () => {
    expect(encodeStandalone(0n, 0)).toBe(0n);
  });

  it("packs executor_id into the top 4 bits", () => {
    const packed = encodeStandalone(0n, 0xa);
    expect(packed).toBe(0xan << 252n);
    expect(decodeUuidInt(packed).executorId).toBe(0xa);
  });

  it("packs the uuid into bits [251:124] and group_id into bits [123:12]", () => {
    const uuid = (1n << 128n) - 1n; // max 128-bit value
    const packed = encodeStandalone(uuid, 0);
    // For standalone orders, group_id = uuid >> 16
    const expectedGroup = uuid >> 16n;
    const expected = (uuid << 124n) | (expectedGroup << 12n);
    expect(packed).toBe(expected);
    const decoded = decodeUuidInt(packed);
    expect(decoded.uuid).toBe(uuid);
    expect(decoded.executorId).toBe(0);
    expect(decoded.groupOrderId).toBe(expectedGroup);
    expect(decoded.legId).toBe(0);
  });

  it("round-trips a typical standalone order with non-zero group", () => {
    const uuid = 0x1234567890abcdef1122334455667788n;
    const executorId = 3;
    const packed = encodeStandalone(uuid, executorId);
    const decoded = decodeUuidInt(packed);
    expect(decoded.executorId).toBe(executorId);
    expect(decoded.uuid).toBe(uuid);
    expect(decoded.groupOrderId).toBe(uuid >> 16n);
    expect(decoded.legId).toBe(0);
  });

  it("matches the canonical vector from the the venue spec", () => {
    // From docs: order_id "00000000-0000-4000-8000-000000000001"
    //          → uuid_int "6427948336465191935941739505432058208337171677044006212075520"
    const orderId = "00000000-0000-4000-8000-000000000001";
    const uuid = uuidStringToBigInt(orderId);
    const packed = encodeStandalone(uuid, 0);
    expect(packed.toString()).toBe(
      "6427948336465191935941739505432058208337171677044006212075520",
    );
  });

  it("rejects executorId out of range", () => {
    expect(() => encodeStandalone(0n, 16)).toThrow();
    expect(() => encodeStandalone(0n, -1)).toThrow();
  });

  it("rejects uuid larger than 128 bits", () => {
    expect(() => encodeStandalone(1n << 128n, 0)).toThrow();
  });

  it("packs a VL sibling with all four fields", () => {
    const groupUuid = 0xdeadbeefn;
    const executorId = 5;
    const groupOrderId = 0x1abcn;
    const legId = 7;
    const packed = encodeVlSibling({ groupUuid, executorId, groupOrderId, legId });
    const decoded = decodeUuidInt(packed);
    expect(decoded.executorId).toBe(executorId);
    expect(decoded.uuid).toBe(groupUuid);
    expect(decoded.groupOrderId).toBe(groupOrderId);
    expect(decoded.legId).toBe(legId);
  });

  it("rejects leg_id larger than 12 bits", () => {
    expect(() =>
      encodeVlSibling({
        groupUuid: 0n,
        executorId: 0,
        groupOrderId: 0n,
        legId: 4096,
      }),
    ).toThrow();
  });

  it("rejects group_order_id larger than 112 bits", () => {
    expect(() =>
      encodeVlSibling({
        groupUuid: 0n,
        executorId: 0,
        groupOrderId: 1n << 112n,
        legId: 0,
      }),
    ).toThrow();
  });

  it("encodes the maximum-valued packed integer correctly", () => {
    const packed = encodeVlSibling({
      groupUuid: (1n << 128n) - 1n,
      executorId: 0xf,
      groupOrderId: (1n << 112n) - 1n,
      legId: 0xfff,
    });
    // 0xf << 252 | (2^128-1) << 124 | (2^112-1) << 12 | 0xfff
    const expected =
      (0xfn << 252n) |
      (((1n << 128n) - 1n) << 124n) |
      (((1n << 112n) - 1n) << 12n) |
      0xfffn;
    expect(packed).toBe(expected);
    expect(packed).toBe((1n << 256n) - 1n);
  });

  it("makeRandomUuid returns a value within the 128-bit range", () => {
    for (let i = 0; i < 32; i++) {
      const u = makeRandomUuid();
      expect(u).toBeGreaterThanOrEqual(0n);
      expect(u).toBeLessThan(1n << 128n);
    }
  });

  it("makeRandomUuid produces non-repeating values across calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 16; i++) seen.add(makeRandomUuid().toString());
    expect(seen.size).toBe(16);
  });

  it("uuidStringToBigInt parses canonical UUID4 strings", () => {
    expect(uuidStringToBigInt("00000000-0000-0000-0000-000000000001")).toBe(1n);
    expect(uuidStringToBigInt("00000000-0000-0000-0000-000000000010")).toBe(0x10n);
    expect(uuidStringToBigInt("ffffffff-ffff-ffff-ffff-ffffffffffff")).toBe(
      (1n << 128n) - 1n,
    );
  });

  it("uuidStringToBigInt rejects malformed input", () => {
    expect(() => uuidStringToBigInt("not-a-uuid")).toThrow();
    expect(() => uuidStringToBigInt("00000000")).toThrow();
  });

  it("generateUuid4 produces parseable UUID strings", () => {
    for (let i = 0; i < 8; i++) {
      const s = generateUuid4();
      expect(s).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      // Round-trip
      expect(uuidStringToBigInt(s)).toBeGreaterThanOrEqual(0n);
    }
  });
});
