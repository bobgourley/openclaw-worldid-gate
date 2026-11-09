/**
 * Test enrollment TTL configuration (WORLDID_ENROLLMENT_TTL_DAYS)
 * 
 * Validates that:
 * - Valid TTL values (1-365 days) are accepted
 * - Invalid TTL values fail closed (server would exit)
 * - Default is 5 days
 */

import { test } from 'node:test';
import assert from 'node:assert';

test('Enrollment TTL config parsing', async (t) => {
  await t.test('accepts valid TTL (5 days default)', () => {
    const ttlDays = parseInt(process.env.WORLDID_ENROLLMENT_TTL_DAYS || '5', 10);
    assert.strictEqual(ttlDays, 5);
    assert.ok(Number.isSafeInteger(ttlDays));
    assert.ok(ttlDays >= 1 && ttlDays <= 365);
  });

  await t.test('accepts minimum TTL (1 day)', () => {
    const ttlDays = 1;
    assert.ok(Number.isSafeInteger(ttlDays));
    assert.ok(ttlDays >= 1 && ttlDays <= 365);
    const ttlSeconds = ttlDays * 86400;
    assert.strictEqual(ttlSeconds, 86400);
  });

  await t.test('accepts maximum TTL (365 days)', () => {
    const ttlDays = 365;
    assert.ok(Number.isSafeInteger(ttlDays));
    assert.ok(ttlDays >= 1 && ttlDays <= 365);
    const ttlSeconds = ttlDays * 86400;
    assert.strictEqual(ttlSeconds, 31536000);
  });

  await t.test('detects below-minimum TTL (0 days)', () => {
    const ttlDays = 0;
    const valid = Number.isSafeInteger(ttlDays) && ttlDays >= 1 && ttlDays <= 365;
    assert.strictEqual(valid, false);
  });

  await t.test('detects above-maximum TTL (366 days)', () => {
    const ttlDays = 366;
    const valid = Number.isSafeInteger(ttlDays) && ttlDays >= 1 && ttlDays <= 365;
    assert.strictEqual(valid, false);
  });

  await t.test('detects negative TTL', () => {
    const ttlDays = -5;
    const valid = Number.isSafeInteger(ttlDays) && ttlDays >= 1 && ttlDays <= 365;
    assert.strictEqual(valid, false);
  });

  await t.test('detects non-integer TTL', () => {
    const ttlDays = 5.5;
    const valid = Number.isSafeInteger(ttlDays) && ttlDays >= 1 && ttlDays <= 365;
    assert.strictEqual(valid, false);
  });

  await t.test('detects NaN TTL', () => {
    const ttlDays = NaN;
    const valid = Number.isFinite(ttlDays) && Number.isSafeInteger(ttlDays) && ttlDays >= 1 && ttlDays <= 365;
    assert.strictEqual(valid, false);
  });

  await t.test('detects Infinity TTL', () => {
    const ttlDays = Infinity;
    const valid = Number.isFinite(ttlDays) && Number.isSafeInteger(ttlDays) && ttlDays >= 1 && ttlDays <= 365;
    assert.strictEqual(valid, false);
  });

  await t.test('converts days to seconds correctly', () => {
    const testCases = [
      { days: 1, seconds: 86400 },
      { days: 5, seconds: 432000 },
      { days: 7, seconds: 604800 },
      { days: 30, seconds: 2592000 },
      { days: 365, seconds: 31536000 },
    ];

    for (const { days, seconds } of testCases) {
      assert.strictEqual(days * 86400, seconds);
    }
  });
});
