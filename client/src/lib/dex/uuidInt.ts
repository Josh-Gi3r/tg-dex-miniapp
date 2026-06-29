/**
 * ─── the venue uuid_int Composite Encoder ─────────────────────────────────────────
 *
 * the venue packs four pieces of context into a single uint256 that gets signed
 * inside Order/Intent/CancelOrder payloads. The bit layout (high → low):
 *
 *   [255:252]  4 bits   executor_id
 *   [251:124]  128 bits standalone uuid OR group UUID for VL legs
 *   [123:12]   112 bits group_order_id (== 0 for standalone orders)
 *   [11:0]     12 bits  leg_id (== 0 for standalone orders)
 *
 * Reference: the venue API spec, "Composite uuid_int encoding".
 */

const BIT_EXECUTOR = 252n;
const BIT_UUID = 124n;
const BIT_GROUP = 12n;

const MASK_EXECUTOR = (1n << 4n) - 1n;          // 4 bits
const MASK_UUID = (1n << 128n) - 1n;            // 128 bits
const MASK_GROUP = (1n << 112n) - 1n;           // 112 bits
const MASK_LEG = (1n << 12n) - 1n;              // 12 bits

/**
 * Encodes a standalone (non-VL) limit order.
 *
 * Per the venue spec ("Standalone Limit Orders"):
 *   leg_id   = 0
 *   group_id = first 112 bits of the UUID  (i.e. uuid >> 16)
 *
 * Reference encoding from the spec:
 *   const raw = uuidStringToBigInt(orderId);
 *   const group = raw >> 16n;
 *   return ((BigInt(executorId) << 252n) | (raw << 124n) | (group << 12n))
 *
 * @param uuid       128-bit UUID (use uuidStringToBigInt for UUID4 strings)
 * @param executorId The executor_id returned by GET /health (typically 0..15)
 */
export function encodeStandalone(uuid: bigint, executorId: number): bigint {
  if (executorId < 0 || executorId > 0xf) {
    throw new Error(`executorId must fit in 4 bits, got ${executorId}`);
  }
  if (uuid < 0n || uuid > MASK_UUID) {
    throw new Error("uuid must fit in 128 bits");
  }
  const groupId = uuid >> 16n; // top 112 bits of the UUID
  return (
    (BigInt(executorId) << BIT_EXECUTOR) |
    (uuid << BIT_UUID) |
    (groupId << BIT_GROUP)
  );
}

/**
 * Converts a UUID4 string ("xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx") to its
 * 128-bit BigInt representation, suitable for `encodeStandalone(uuid, ...)`.
 */
export function uuidStringToBigInt(uuid: string): bigint {
  const hex = uuid.replace(/-/g, "");
  if (hex.length !== 32 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(`Invalid UUID string: ${uuid}`);
  }
  return BigInt(`0x${hex}`);
}

/** Generates a fresh UUID4 string. Mirrors crypto.randomUUID() when available. */
export function generateUuid4(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Node fallback (used in tests when randomUUID isn't exposed): build manually.
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 1
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Encodes a sibling leg of a VL (visible-liquidity) batch. The same
 * group UUID is shared across all legs; leg_id distinguishes them.
 */
export function encodeVlSibling(params: {
  groupUuid: bigint;
  executorId: number;
  groupOrderId: bigint;
  legId: number;
}): bigint {
  const { groupUuid, executorId, groupOrderId, legId } = params;
  if (executorId < 0 || executorId > 0xf) {
    throw new Error(`executorId must fit in 4 bits, got ${executorId}`);
  }
  if (groupUuid < 0n || groupUuid > MASK_UUID) {
    throw new Error("groupUuid must fit in 128 bits");
  }
  if (groupOrderId < 0n || groupOrderId > MASK_GROUP) {
    throw new Error("groupOrderId must fit in 112 bits");
  }
  if (legId < 0 || legId > Number(MASK_LEG)) {
    throw new Error(`legId must fit in 12 bits, got ${legId}`);
  }
  return (
    (BigInt(executorId) << BIT_EXECUTOR) |
    (groupUuid << BIT_UUID) |
    (groupOrderId << BIT_GROUP) |
    BigInt(legId)
  );
}

/**
 * Decodes a uuid_int back into its four fields. Useful for cancellation
 * flows where the API returned a packed value and we need to extract
 * executor_id/leg_id for the CancelOrder typed-data signature.
 */
export function decodeUuidInt(packed: bigint): {
  executorId: number;
  uuid: bigint;
  groupOrderId: bigint;
  legId: number;
} {
  return {
    executorId: Number((packed >> BIT_EXECUTOR) & MASK_EXECUTOR),
    uuid: (packed >> BIT_UUID) & MASK_UUID,
    groupOrderId: (packed >> BIT_GROUP) & MASK_GROUP,
    legId: Number(packed & MASK_LEG),
  };
}

/**
 * Generates a cryptographically random 128-bit uuid suitable for the
 * `uuid` field of encodeStandalone / encodeVlSibling.
 */
export function makeRandomUuid(): bigint {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    // Node fallback (used in tests)
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = 0n;
  for (const b of bytes) out = (out << 8n) | BigInt(b);
  return out;
}
