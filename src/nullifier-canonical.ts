/**
 * Nullifier canonicalization for World ID 4.0 replay protection.
 * 
 * Prevents replay attacks through format variations (0x01 vs 0x1 vs decimal 1).
 * Enforces 256-bit bounds and normalizes to one exact form.
 * 
 * Canonical format: 0x-prefixed, lowercase, zero-padded to 64 hex characters
 * Example: 0x0000000000000000000000000000000000000000000000000000000000000001
 */

/**
 * Canonicalize a nullifier to prevent replay through format variations.
 * 
 * Accepts:
 * - Hex with 0x prefix: "0x1", "0x01", "0xABC" (any length, any case)
 * 
 * SECURITY: Bare decimal strings are REJECTED to prevent aliasing:
 * - "10" decimal (value 10) vs "0x10" hex (value 16) would create different keys
 * - World ID 4.0 nullifiers are always 0x-prefixed hex per API docs
 * 
 * Returns: Canonical 0x-prefixed, lowercase, 64-char hex string
 * 
 * Throws on:
 * - Bare decimal strings (must be 0x-prefixed to prevent aliasing)
 * - Negative values
 * - Non-integer (floats, NaN, Infinity)
 * - Overflow (> 256 bits)
 * - Invalid format (objects, arrays, empty strings)
 * - Malformed hex
 */
export function canonicalizeNullifier(input: unknown): string {
  // Type guard: must be string
  if (typeof input !== 'string') {
    throw new Error(`Nullifier must be string, got ${typeof input}`);
  }

  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new Error('Nullifier cannot be empty');
  }

  let bigIntValue: bigint;

  // Check for negative sign first (before parsing)
  if (trimmed.startsWith('-')) {
    throw new Error('Nullifier cannot be negative');
  }

  try {
    if (trimmed.startsWith('0x') || trimmed.startsWith('0X')) {
      // Hex format - ONLY accepted format per World ID 4.0
      const hexPart = trimmed.slice(2);
      if (hexPart.length === 0) {
        throw new Error('Hex nullifier missing digits after 0x');
      }
      if (!/^[0-9a-fA-F]+$/.test(hexPart)) {
        throw new Error('Hex nullifier contains invalid characters');
      }
      bigIntValue = BigInt(trimmed);
    } else {
      // SECURITY: Reject bare decimal to prevent aliasing
      // "10" (decimal 10) vs "0x10" (hex 16) would create replay vectors
      throw new Error('Nullifier must be 0x-prefixed hex string to prevent aliasing (bare decimal rejected)');
    }
  } catch (error) {
    if (error instanceof Error && (error.message.includes('invalid characters') || error.message.includes('negative') || error.message.includes('aliasing'))) {
      throw error;
    }
    throw new Error(`Invalid nullifier format: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Paranoid re-check (should be unreachable after parsing)
  if (bigIntValue < 0n) {
    throw new Error('Nullifier cannot be negative');
  }

  const MAX_256_BIT = (1n << 256n) - 1n;
  if (bigIntValue > MAX_256_BIT) {
    throw new Error('Nullifier exceeds 256-bit maximum');
  }

  // Convert to canonical form: 0x-prefixed, lowercase, zero-padded to 64 chars
  const hexString = bigIntValue.toString(16).toLowerCase();
  const padded = hexString.padStart(64, '0');
  
  return `0x${padded}`;
}

/**
 * Canonicalize a session nullifier tuple [nullifier, action].
 * Both elements are canonicalized as 256-bit hex strings.
 */
export function canonicalizeSessionNullifierTuple(tuple: unknown): [string, string] {
  if (!Array.isArray(tuple)) {
    throw new Error('Session nullifier must be array');
  }

  if (tuple.length !== 2) {
    throw new Error(`Session nullifier must have exactly 2 elements, got ${tuple.length}`);
  }

  const [nullifier, action] = tuple;

  return [
    canonicalizeNullifier(nullifier),
    canonicalizeNullifier(action),
  ];
}

/**
 * Test if two nullifiers are equivalent (after canonicalization).
 */
export function nullifiersEqual(a: unknown, b: unknown): boolean {
  try {
    return canonicalizeNullifier(a) === canonicalizeNullifier(b);
  } catch {
    return false;
  }
}
