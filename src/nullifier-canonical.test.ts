/**
 * Nullifier canonicalization tests.
 * 
 * Verifies canonical identity for replay protection.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeNullifier, canonicalizeSessionNullifierTuple, nullifiersEqual } from './nullifier-canonical.js';

describe('Nullifier Canonicalization', () => {
  describe('canonicalizeNullifier', () => {
    it('canonicalizes hex with 0x prefix', () => {
      assert.equal(
        canonicalizeNullifier('0x1'),
        '0x0000000000000000000000000000000000000000000000000000000000000001'
      );
    });

    it('canonicalizes hex without leading zeros', () => {
      assert.equal(
        canonicalizeNullifier('0xABC'),
        '0x0000000000000000000000000000000000000000000000000000000000000abc'
      );
    });

    it('canonicalizes uppercase hex to lowercase', () => {
      assert.equal(
        canonicalizeNullifier('0xABCDEF'),
        '0x0000000000000000000000000000000000000000000000000000000000abcdef'
      );
    });

    it('accepts already canonical form', () => {
      const canonical = '0x0000000000000000000000000000000000000000000000000000000000000001';
      assert.equal(canonicalizeNullifier(canonical), canonical);
    });

    it('rejects bare decimal string (prevents aliasing)', () => {
      // SECURITY: "10" decimal vs "0x10" hex creates aliasing
      assert.throws(
        () => canonicalizeNullifier('1'),
        /must be 0x-prefixed.*aliasing/
      );
      
      assert.throws(
        () => canonicalizeNullifier('255'),
        /must be 0x-prefixed.*aliasing/
      );
    });

    it('equivalent 0x-prefixed representations normalize to same value', () => {
      const a = canonicalizeNullifier('0x01');
      const b = canonicalizeNullifier('0x1');
      const c = canonicalizeNullifier('0X1'); // uppercase 0X also valid
      
      assert.equal(a, b);
      assert.equal(b, c);
      assert.equal(a, '0x0000000000000000000000000000000000000000000000000000000000000001');
    });

    it('SECURITY: rejects decimal "10" to prevent alias with 0x10 (hex 16)', () => {
      // "10" as decimal = 10
      // "0x10" as hex = 16
      // Both must NOT be accepted or they create replay aliasing
      assert.throws(
        () => canonicalizeNullifier('10'),
        /must be 0x-prefixed.*aliasing/
      );
      
      // Only 0x-prefixed form accepted
      const canonical = canonicalizeNullifier('0x10');
      assert.equal(canonical, '0x0000000000000000000000000000000000000000000000000000000000000010');
      // This is hex 16, not decimal 10
      assert.equal(BigInt(canonical), 16n);
    });

    it('handles 256-bit maximum', () => {
      const max256 = '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
      assert.equal(canonicalizeNullifier(max256), max256);
    });

    it('rejects overflow beyond 256 bits', () => {
      const overflow = '0x10000000000000000000000000000000000000000000000000000000000000000';
      assert.throws(
        () => canonicalizeNullifier(overflow),
        /exceeds 256-bit maximum/
      );
    });

    it('rejects negative values', () => {
      assert.throws(
        () => canonicalizeNullifier('-1'),
        /cannot be negative/
      );
    });

    it('rejects non-string input', () => {
      assert.throws(
        () => canonicalizeNullifier(123 as any),
        /must be string/
      );
      
      assert.throws(
        () => canonicalizeNullifier({} as any),
        /must be string/
      );

      assert.throws(
        () => canonicalizeNullifier(null as any),
        /must be string/
      );
    });

    it('rejects empty string', () => {
      assert.throws(
        () => canonicalizeNullifier(''),
        /cannot be empty/
      );
    });

    it('rejects malformed hex', () => {
      assert.throws(
        () => canonicalizeNullifier('0x'),
        /missing digits/
      );

      assert.throws(
        () => canonicalizeNullifier('0xGHI'),
        /invalid characters/
      );
    });

    it('rejects string with non-hex characters after 0x', () => {
      assert.throws(
        () => canonicalizeNullifier('0x123g'), // 'g' not hex
        /invalid characters/
      );

      assert.throws(
        () => canonicalizeNullifier('0xtest'), // 't', 'e', 's' not all hex
        /invalid characters/
      );
    });

    it('trims whitespace', () => {
      assert.equal(
        canonicalizeNullifier('  0x1  '),
        '0x0000000000000000000000000000000000000000000000000000000000000001'
      );
    });
  });

  describe('canonicalizeSessionNullifierTuple', () => {
    it('canonicalizes both elements of tuple', () => {
      const result = canonicalizeSessionNullifierTuple(['0x1', '0xABC']);
      assert.deepEqual(result, [
        '0x0000000000000000000000000000000000000000000000000000000000000001',
        '0x0000000000000000000000000000000000000000000000000000000000000abc',
      ]);
    });

    it('rejects bare decimal in tuple (aliasing prevention)', () => {
      assert.throws(
        () => canonicalizeSessionNullifierTuple(['1', '0x2']),
        /must be 0x-prefixed.*aliasing/
      );
    });

    it('rejects non-array', () => {
      assert.throws(
        () => canonicalizeSessionNullifierTuple('not an array' as any),
        /must be array/
      );
    });

    it('rejects wrong length', () => {
      assert.throws(
        () => canonicalizeSessionNullifierTuple(['0x1'] as any),
        /exactly 2 elements/
      );

      assert.throws(
        () => canonicalizeSessionNullifierTuple(['0x1', '0x2', '0x3'] as any),
        /exactly 2 elements/
      );
    });

    it('rejects invalid nullifier in tuple', () => {
      assert.throws(
        () => canonicalizeSessionNullifierTuple(['0x1', '-1']),
        /cannot be negative/
      );
    });
  });

  describe('nullifiersEqual', () => {
    it('returns true for equivalent representations', () => {
      assert.equal(nullifiersEqual('0x1', '0x01'), true);
      assert.equal(nullifiersEqual('0xABC', '0xabc'), true);
    });

    it('returns false for different values', () => {
      assert.equal(nullifiersEqual('0x1', '0x2'), false);
    });

    it('returns false for invalid inputs', () => {
      assert.equal(nullifiersEqual('invalid', '0x1'), false);
      assert.equal(nullifiersEqual('0x1', 'invalid'), false);
    });
  });

  describe('Replay protection through canonicalization', () => {
    it('prevents replay via unpadded hex (0x1 vs 0x01)', () => {
      const nullifier1 = canonicalizeNullifier('0x1');
      const nullifier2 = canonicalizeNullifier('0x01');
      
      assert.equal(nullifier1, nullifier2, 'Same canonical form prevents bypass');
    });

    it('prevents replay via case variation (0xABC vs 0xabc)', () => {
      const nullifier1 = canonicalizeNullifier('0xABC');
      const nullifier2 = canonicalizeNullifier('0xabc');
      
      assert.equal(nullifier1, nullifier2, 'Case normalization prevents bypass');
    });

    it('prevents replay via decimal vs hex aliasing (SECURITY)', () => {
      // SECURITY: bare decimal must be rejected to prevent aliasing
      // '1' decimal would normalize to 0x1, but '10' decimal vs '0x10' hex differ
      // Rejecting all bare decimals prevents the attack vector
      assert.throws(
        () => canonicalizeNullifier('1'),
        /must be 0x-prefixed.*aliasing/
      );
      
      // Only 0x-prefixed hex accepted
      const nullifier = canonicalizeNullifier('0x1');
      assert.equal(nullifier, '0x0000000000000000000000000000000000000000000000000000000000000001');
    });

    it('session tuple canonicalization prevents replay aliases', () => {
      const tuple1 = canonicalizeSessionNullifierTuple(['0x1', '0xABC']);
      const tuple2 = canonicalizeSessionNullifierTuple(['0x01', '0xabc']);
      
      assert.deepEqual(tuple1, tuple2, 'Tuple canonicalization prevents bypass');
    });
  });

  describe('Legacy migration collision prevention', () => {
    it('does not mutate stored canonical nullifiers', () => {
      const stored = '0x0000000000000000000000000000000000000000000000000000000000000001';
      const result = canonicalizeNullifier(stored);
      
      assert.equal(result, stored, 'Already canonical form unchanged');
    });

    it('different representations would have collided without canonicalization', () => {
      // Without canonicalization, these would all be different keys
      const variants = [
        '0x1',
        '0x01',
        '0x001',
        '0X1', // uppercase X
        '0x0000000000000000000000000000000000000000000000000000000000000001',
      ];

      const canonicalized = variants.map(v => canonicalizeNullifier(v));
      const unique = new Set(canonicalized);

      assert.equal(unique.size, 1, 'All variants canonicalize to same value');
      assert.equal(
        canonicalized[0],
        '0x0000000000000000000000000000000000000000000000000000000000000001'
      );
    });
  });
});
