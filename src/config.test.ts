/**
 * Config validation tests
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { validateConfig, CONFIG_BOUNDS, assertValidConfig } from './config.js';
import type { GateConfig } from './types.js';

describe('Config validation', () => {
  const validConfig: GateConfig = {
    rpId: 'rp_test123',
    action: 'test-action',
    verifyEndpoint: 'https://developer.world.org/api/v4/verify',
    requireProofOfHuman: true,
    enrollmentTtlSeconds: CONFIG_BOUNDS.enrollmentTtl.default,
    allowTestMode: true,
  };

  it('should accept valid configuration', () => {
    const errors = validateConfig(validConfig);
    assert.strictEqual(errors.length, 0, `Expected no errors but got: ${errors.join(', ')}`);
  });

  it('should reject missing rpId', () => {
    const config = { ...validConfig, rpId: '' };
    const errors = validateConfig(config);
    assert.ok(errors.some((e) => e.includes('rpId')));
  });

  it('should reject rpId without rp_ prefix', () => {
    const config = { ...validConfig, rpId: 'invalid_prefix' };
    const errors = validateConfig(config);
    assert.ok(errors.some((e) => e.includes('rpId') && e.includes('rp_')));
  });

  it('should reject unconfigured rpId placeholder', () => {
    const config = { ...validConfig, rpId: 'rp_REPLACE_WITH_YOUR_RP_ID' };
    const errors = validateConfig(config);
    assert.ok(errors.some((e) => e.includes('not been configured')));
  });

  it('should reject missing action', () => {
    const config = { ...validConfig, action: '' };
    const errors = validateConfig(config);
    assert.ok(errors.some((e) => e.includes('action')));
  });

  it('should reject whitespace-only action', () => {
    const config = { ...validConfig, action: '   ' };
    const errors = validateConfig(config);
    assert.ok(errors.some((e) => e.includes('action') && e.includes('empty')));
  });

  it('should reject non-HTTPS verifyEndpoint', () => {
    const config = { ...validConfig, verifyEndpoint: 'http://insecure.example' };
    const errors = validateConfig(config);
    assert.ok(errors.some((e) => e.includes('HTTPS')));
  });

  it('should reject missing verifyEndpoint', () => {
    const config = { ...validConfig, verifyEndpoint: '' };
    const errors = validateConfig(config);
    assert.ok(errors.some((e) => e.includes('verifyEndpoint')));
  });

  it('should reject malformed URL verifyEndpoint', () => {
    const config = { ...validConfig, verifyEndpoint: 'not-a-url' };
    const errors = validateConfig(config);
    assert.ok(errors.some((e) => e.includes('not a valid URL')));
  });

  it('should reject verifyEndpoint with userinfo/credentials', () => {
    const config = { ...validConfig, verifyEndpoint: 'https://user:pass@example.com/api' };
    const errors = validateConfig(config);
    assert.ok(errors.some((e) => e.includes('userinfo') || e.includes('credentials')));
  });

  it('should accept valid HTTPS URL with path', () => {
    const config = { ...validConfig, verifyEndpoint: 'https://developer.world.org/api/v4/verify' };
    const errors = validateConfig(config);
    assert.strictEqual(errors.length, 0);
  });

  it('should accept valid HTTPS URL with port', () => {
    const config = { ...validConfig, verifyEndpoint: 'https://example.com:8443/api' };
    const errors = validateConfig(config);
    assert.strictEqual(errors.length, 0);
  });

  it('should reject non-boolean requireProofOfHuman', () => {
    const config = { ...validConfig, requireProofOfHuman: 'yes' as any };
    const errors = validateConfig(config);
    assert.ok(errors.some((e) => e.includes('requireProofOfHuman') && e.includes('boolean')));
  });

  it('should reject negative enrollmentTtlSeconds', () => {
    const config = { ...validConfig, enrollmentTtlSeconds: -100 };
    const errors = validateConfig(config);
    assert.ok(errors.some((e) => e.includes('positive')));
  });

  it('should reject zero enrollmentTtlSeconds', () => {
    const config = { ...validConfig, enrollmentTtlSeconds: 0 };
    const errors = validateConfig(config);
    assert.ok(errors.some((e) => e.includes('positive')));
  });

  it('should reject enrollmentTtlSeconds below minimum bound', () => {
    const config = { ...validConfig, enrollmentTtlSeconds: 30 }; // Below 60s minimum
    const errors = validateConfig(config);
    assert.ok(
      errors.some((e) => e.includes('at least') && e.includes(String(CONFIG_BOUNDS.enrollmentTtl.minimum)))
    );
  });

  it('should accept enrollmentTtlSeconds at exact minimum bound', () => {
    const config = { ...validConfig, enrollmentTtlSeconds: CONFIG_BOUNDS.enrollmentTtl.minimum };
    const errors = validateConfig(config);
    assert.strictEqual(errors.length, 0, `Expected no errors but got: ${errors.join(', ')}`);
  });

  it('should accept enrollmentTtlSeconds at exact maximum bound', () => {
    const config = { ...validConfig, enrollmentTtlSeconds: CONFIG_BOUNDS.enrollmentTtl.maximum };
    const errors = validateConfig(config);
    assert.strictEqual(errors.length, 0, `Expected no errors but got: ${errors.join(', ')}`);
  });

  it('should reject enrollmentTtlSeconds above maximum bound', () => {
    const config = { ...validConfig, enrollmentTtlSeconds: CONFIG_BOUNDS.enrollmentTtl.maximum + 1 };
    const errors = validateConfig(config);
    assert.ok(
      errors.some((e) => e.includes('at most') && e.includes(String(CONFIG_BOUNDS.enrollmentTtl.maximum)))
    );
  });

  it('should reject Infinity enrollmentTtlSeconds', () => {
    const config = { ...validConfig, enrollmentTtlSeconds: Infinity };
    const errors = validateConfig(config);
    assert.ok(errors.some((e) => e.includes('finite')));
  });

  it('should reject NaN enrollmentTtlSeconds', () => {
    const config = { ...validConfig, enrollmentTtlSeconds: NaN };
    const errors = validateConfig(config);
    assert.ok(errors.some((e) => e.includes('finite')));
  });

  it('should reject non-safe-integer enrollmentTtlSeconds', () => {
    const config = { ...validConfig, enrollmentTtlSeconds: Number.MAX_SAFE_INTEGER + 1 };
    const errors = validateConfig(config);
    assert.ok(errors.some((e) => e.includes('safe integer')));
  });

  it('should reject non-number enrollmentTtlSeconds', () => {
    const config = { ...validConfig, enrollmentTtlSeconds: '86400' as any };
    const errors = validateConfig(config);
    assert.ok(errors.some((e) => e.includes('must be a number')));
  });

  it('should reject non-boolean allowTestMode', () => {
    const config = { ...validConfig, allowTestMode: 'true' as any };
    const errors = validateConfig(config);
    assert.ok(errors.some((e) => e.includes('allowTestMode') && e.includes('boolean')));
  });

  it('should accept default TTL of 30 days (2592000 seconds)', () => {
    const config = { ...validConfig, enrollmentTtlSeconds: 2592000 };
    const errors = validateConfig(config);
    assert.strictEqual(errors.length, 0, `Expected no errors but got: ${errors.join(', ')}`);
  });

  it('assertValidConfig should throw on invalid config', () => {
    const config = { ...validConfig, rpId: 'invalid' };
    assert.throws(
      () => assertValidConfig(config),
      (err: any) => err.message.includes('Configuration validation failed')
    );
  });

  it('assertValidConfig should not throw on valid config', () => {
    assert.doesNotThrow(() => assertValidConfig(validConfig));
  });

  it('should accumulate multiple errors', () => {
    const config = {
      ...validConfig,
      rpId: 'invalid',
      action: '',
      verifyEndpoint: 'http://insecure',
      enrollmentTtlSeconds: -1,
    };
    const errors = validateConfig(config);
    assert.ok(errors.length >= 4, `Expected at least 4 errors but got ${errors.length}`);
  });
});

import { parseMemberTagGroups } from './config.js';

describe('parseMemberTagGroups', () => {

  it('should default to OPENCLAW_ALLOWED_GROUP when MEMBER_TAG_GROUPS unset', () => {
    const result = parseMemberTagGroups(undefined, '-123456');
    assert.deepStrictEqual(result, ['-123456']);
  });

  it('should throw when both MEMBER_TAG_GROUPS and OPENCLAW_ALLOWED_GROUP unset', () => {
    assert.throws(
      () => parseMemberTagGroups(undefined, undefined),
      (err: any) => err.message.includes('MEMBER_TAG_GROUPS or OPENCLAW_ALLOWED_GROUP must be set')
    );
  });

  it('should parse single group', () => {
    const result = parseMemberTagGroups('-123456', '-999999');
    assert.deepStrictEqual(result, ['-123456']);
  });

  it('should parse multiple groups', () => {
    const result = parseMemberTagGroups('-123456,-789012,-345678', '-999999');
    assert.deepStrictEqual(result, ['-123456', '-789012', '-345678']);
  });

  it('should handle whitespace around entries', () => {
    const result = parseMemberTagGroups(' -123456 , -789012 , -345678 ', '-999999');
    assert.deepStrictEqual(result, ['-123456', '-789012', '-345678']);
  });

  it('should reject empty MEMBER_TAG_GROUPS', () => {
    assert.throws(
      () => parseMemberTagGroups('', '-123456'),
      (err: any) => err.message.includes('cannot be empty')
    );
  });

  it('should reject non-integer entries', () => {
    assert.throws(
      () => parseMemberTagGroups('-123456,abc,-789012', '-999999'),
      (err: any) => err.message.includes('not a valid integer')
    );
  });

  it('should reject positive integers', () => {
    assert.throws(
      () => parseMemberTagGroups('-123456,123456', '-999999'),
      (err: any) => err.message.includes('must be negative')
    );
  });

  it('should reject zero', () => {
    assert.throws(
      () => parseMemberTagGroups('-123456,0', '-999999'),
      (err: any) => err.message.includes('must be negative')
    );
  });

  it('should reject duplicate entries', () => {
    assert.throws(
      () => parseMemberTagGroups('-123456,-789012,-123456', '-999999'),
      (err: any) => err.message.includes('duplicate entry')
    );
  });

  it('should filter empty entries from split', () => {
    const result = parseMemberTagGroups('-123456,,-789012', '-999999');
    assert.deepStrictEqual(result, ['-123456', '-789012']);
  });

  it('should reject floating point numbers', () => {
    assert.throws(
      () => parseMemberTagGroups('-123456.5', '-999999'),
      (err: any) => err.message.includes('not a valid integer')
    );
  });
});
