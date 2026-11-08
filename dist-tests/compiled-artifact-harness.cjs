/**
 * Compiled Artifact Test Harness
 * 
 * Tests actual dist/ compiled code, not src/.
 * Self-contained, no credentials required.
 * 
 * Usage:
 *   node dist-tests/compiled-artifact-harness.js
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { EnrollmentService } = require('../dist/enrollment-service-production.js');
const { WorldIdChallengeAdapter } = require('../dist/worldid-challenge-adapter.js');
const { createHmac } = require('crypto');

const TEST_SIGNING_KEY = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
const TEST_APP_ID = 'app_test_compiled';
const TEST_RP_ID = 'rp_test_compiled';
const TEST_BOT_TOKEN = 'test_bot_compiled';
const TEST_ACTION = 'test-compiled';

class FakeClock {
  constructor(initialSeconds = Math.floor(Date.now() / 1000)) {
    this.currentSeconds = initialSeconds;
  }
  
  nowSeconds() {
    return this.currentSeconds;
  }
  
  nowISO() {
    return new Date(this.currentSeconds * 1000).toISOString();
  }
  
  advance(seconds) {
    this.currentSeconds += seconds;
  }
}

class MockWorldIdClient {
  constructor() {
    this.responses = new Map();
  }
  
  setResponse(nonce, result) {
    this.responses.set(nonce, result);
  }
  
  async verify(idkitResult, expectedContext) {
    const mockResult = this.responses.get(idkitResult.nonce);
    if (!mockResult) {
      return { success: false, error: 'Mock: No response configured' };
    }
    return mockResult;
  }
}

function createValidInitData(userId, botToken) {
  const authDate = Math.floor(Date.now() / 1000);
  const user = JSON.stringify({ id: userId, first_name: 'Test', username: `user${userId}` });
  
  const params = {
    user,
    auth_date: String(authDate),
  };
  
  const dataCheckString = Object.keys(params)
    .sort()
    .map(key => `${key}=${params[key]}`)
    .join('\n');
  
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  
  return `user=${encodeURIComponent(user)}&auth_date=${authDate}&hash=${hash}`;
}

function createIDKitResult(nonce, action, signalHash) {
  return {
    nonce,
    action,
    signal_hash: signalHash,
    proof: 'mock_proof',
    merkle_root: 'mock_root',
  };
}

// Test suite
const tests = [];
const results = {
  passed: 0,
  failed: 0,
  errors: [],
};

function test(name, fn) {
  tests.push({ name, fn });
}

async function runTests() {
  console.log('=== Compiled Artifact Test Harness ===\n');
  console.log('Testing: dist/enrollment-service-production.js\n');
  
  for (const { name, fn } of tests) {
    const testDbPath = `/tmp/test-compiled-${Date.now()}-${Math.random().toString(36).substring(7)}.db`;
    
    try {
      await fn(testDbPath);
      console.log(`✓ ${name}`);
      results.passed++;
    } catch (error) {
      console.error(`✗ ${name}`);
      console.error(`  Error: ${error.message}`);
      if (error.stack) {
        console.error(`  ${error.stack.split('\n').slice(1, 3).join('\n  ')}`);
      }
      results.failed++;
      results.errors.push({ test: name, error: error.message });
    } finally {
      try {
        if (fs.existsSync(testDbPath)) {
          fs.unlinkSync(testDbPath);
        }
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  }
  
  console.log(`\n=== Results ===`);
  console.log(`Passed: ${results.passed}`);
  console.log(`Failed: ${results.failed}`);
  
  if (results.failed > 0) {
    console.log(`\nFailed Tests:`);
    results.errors.forEach(({ test, error }) => {
      console.log(`  - ${test}: ${error}`);
    });
    process.exit(1);
  } else {
    console.log(`\n✓ All compiled artifact tests passed`);
    process.exit(0);
  }
}

// Test: V1 to V2 migration with actual v1 DB
test('V1 to V2 migration with backfill', (testDbPath) => {
  // Create v1 schema manually
  const db = new Database(testDbPath);
  
  db.exec(`
    CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT);
    INSERT INTO schema_version VALUES (1, '2026-11-01T12:00:00Z');
  `);
  
  db.exec(`
    CREATE TABLE enrollments (
      telegram_user_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      nullifier TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0,
      revoked_at TEXT,
      revoked_at_seconds INTEGER,
      revoked_generation INTEGER,
      PRIMARY KEY (telegram_user_id, action)
    );
  `);
  
  db.exec(`
    CREATE TABLE generation_counter (id INTEGER PRIMARY KEY, next_generation INTEGER);
    INSERT INTO generation_counter VALUES (1, 1);
  `);
  
  // Insert test enrollment
  db.exec(`
    INSERT INTO enrollments (telegram_user_id, action, nullifier, expires_at, created_at, revoked)
    VALUES (12345, 'test-compiled', '0xtest_nullifier_v1', ${Math.floor(Date.now() / 1000) + 86400}, '2026-11-01T12:00:00Z', 0);
  `);
  
  db.close();
  
  // Open with v2 service (triggers migration)
  const fakeClock = new FakeClock();
  const adapter = new WorldIdChallengeAdapter({
    appId: TEST_APP_ID,
    rpId: TEST_RP_ID,
    signingKeyHex: TEST_SIGNING_KEY,
    environment: 'staging',
  });
  const mockClient = new MockWorldIdClient();
  
  const service = new EnrollmentService({
    dbPath: testDbPath,
    challengeAdapter: adapter,
    verificationClient: mockClient,
    telegramBotToken: TEST_BOT_TOKEN,
    action: TEST_ACTION,
    clock: fakeClock,
  });
  
  // Verify v2 tables exist
  const dbCheck = new Database(testDbPath);
  
  const tables = dbCheck.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name IN ('nullifier_claims', 'generation_fences')
  `).all();
  
  if (tables.length !== 2) {
    throw new Error(`Expected 2 v2 tables, got ${tables.length}`);
  }
  
  // Verify backfill
  const claim = dbCheck.prepare(`
    SELECT * FROM nullifier_claims WHERE action = 'test-compiled'
  `).get();
  
  if (!claim) {
    throw new Error('Nullifier claim not backfilled');
  }
  
  if (claim.telegram_user_id !== 12345) {
    throw new Error(`Wrong user: ${claim.telegram_user_id}`);
  }
  
  // Verify version
  const version = dbCheck.prepare(`SELECT MAX(version) as v FROM schema_version`).get();
  if (version.v !== 2) {
    throw new Error(`Version should be 2, got ${version.v}`);
  }
  
  dbCheck.close();
  service.close();
});

// Test: Generation fences backfill from revoked
test('Generation fences backfill from revoked enrollments', (testDbPath) => {
  const db = new Database(testDbPath);
  
  db.exec(`
    CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT);
    INSERT INTO schema_version VALUES (1, '2026-11-01T12:00:00Z');
  `);
  
  db.exec(`
    CREATE TABLE enrollments (
      telegram_user_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      nullifier TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0,
      revoked_at TEXT,
      revoked_at_seconds INTEGER,
      revoked_generation INTEGER,
      PRIMARY KEY (telegram_user_id, action)
    );
  `);
  
  db.exec(`
    CREATE TABLE generation_counter (id INTEGER PRIMARY KEY, next_generation INTEGER);
    INSERT INTO generation_counter VALUES (1, 10);
  `);
  
  const revokedAt = Math.floor(Date.now() / 1000);
  db.exec(`
    INSERT INTO enrollments (telegram_user_id, action, nullifier, expires_at, created_at, revoked, revoked_at, revoked_at_seconds, revoked_generation)
    VALUES (555, 'test-compiled', '0xrevoked', ${revokedAt + 86400}, '2026-11-01T12:00:00Z', 1, '2026-11-01T13:00:00Z', ${revokedAt}, 5);
  `);
  
  db.close();
  
  const fakeClock = new FakeClock();
  const adapter = new WorldIdChallengeAdapter({
    appId: TEST_APP_ID,
    rpId: TEST_RP_ID,
    signingKeyHex: TEST_SIGNING_KEY,
    environment: 'staging',
  });
  const mockClient = new MockWorldIdClient();
  
  const service = new EnrollmentService({
    dbPath: testDbPath,
    challengeAdapter: adapter,
    verificationClient: mockClient,
    telegramBotToken: TEST_BOT_TOKEN,
    action: TEST_ACTION,
    clock: fakeClock,
  });
  
  const dbCheck = new Database(testDbPath);
  const fence = dbCheck.prepare(`
    SELECT * FROM generation_fences WHERE telegram_user_id = 555 AND action = 'test-compiled'
  `).get();
  
  if (!fence) {
    throw new Error('Generation fence not backfilled');
  }
  
  if (fence.fence_generation !== 5) {
    throw new Error(`Wrong fence generation: ${fence.fence_generation}`);
  }
  
  dbCheck.close();
  service.close();
});

// Test: Partial migration restart detection
test('Detects partial migration restart', (testDbPath) => {
  const db = new Database(testDbPath);
  
  db.exec(`
    CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT);
    INSERT INTO schema_version VALUES (1, '2026-11-01T12:00:00Z');
  `);
  
  db.exec(`
    CREATE TABLE enrollments (
      telegram_user_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      nullifier TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (telegram_user_id, action)
    );
  `);
  
  db.exec(`
    CREATE TABLE generation_counter (id INTEGER PRIMARY KEY, next_generation INTEGER);
    INSERT INTO generation_counter VALUES (1, 1);
  `);
  
  // Simulate partial migration: v2 tables exist with data, version=1
  db.exec(`
    CREATE TABLE nullifier_claims (
      nullifier TEXT NOT NULL,
      action TEXT NOT NULL,
      telegram_user_id INTEGER NOT NULL,
      claimed_at INTEGER NOT NULL,
      claimed_at_iso TEXT NOT NULL,
      PRIMARY KEY (nullifier, action)
    );
  `);
  
  db.exec(`
    INSERT INTO nullifier_claims VALUES ('0xtest', 'test-compiled', 123, ${Math.floor(Date.now() / 1000)}, '2026-11-01T12:00:00Z');
  `);
  
  db.close();
  
  const fakeClock = new FakeClock();
  const adapter = new WorldIdChallengeAdapter({
    appId: TEST_APP_ID,
    rpId: TEST_RP_ID,
    signingKeyHex: TEST_SIGNING_KEY,
    environment: 'staging',
  });
  const mockClient = new MockWorldIdClient();
  
  let threwExpectedError = false;
  try {
    new EnrollmentService({
      dbPath: testDbPath,
      challengeAdapter: adapter,
      verificationClient: mockClient,
      telegramBotToken: TEST_BOT_TOKEN,
      action: TEST_ACTION,
      clock: fakeClock,
    });
  } catch (error) {
    if (error.message.includes('MIGRATION RESTART DETECTED')) {
      threwExpectedError = true;
    } else {
      throw error;
    }
  }
  
  if (!threwExpectedError) {
    throw new Error('Should have detected partial migration');
  }
});

// Test: Immutable nullifier ownership after revocation
test('Prevents revoked-owner nullifier takeover (compiled)', async (testDbPath) => {
  const fakeClock = new FakeClock();
  const adapter = new WorldIdChallengeAdapter({
    appId: TEST_APP_ID,
    rpId: TEST_RP_ID,
    signingKeyHex: TEST_SIGNING_KEY,
    environment: 'staging',
  });
  const mockClient = new MockWorldIdClient();
  
  const service = new EnrollmentService({
    dbPath: testDbPath,
    challengeAdapter: adapter,
    verificationClient: mockClient,
    telegramBotToken: TEST_BOT_TOKEN,
    action: TEST_ACTION,
    clock: fakeClock,
  });
  
  const sharedNullifier = '0ximmutable_compiled';
  
  // User A enrolls
  const initDataA = createValidInitData(100, TEST_BOT_TOKEN);
  const challengeA = await service.createChallenge(initDataA);
  mockClient.setResponse(challengeA.signedChallenge.nonce, {
    success: true,
    nullifier: sharedNullifier,
    issuerSchemaId: 1,
    expiresAtMin: fakeClock.nowSeconds() + 86400,
  });
  
  await service.completeEnrollment({
    initData: initDataA,
    idkitResult: createIDKitResult(challengeA.signedChallenge.nonce, TEST_ACTION, challengeA.signedChallenge.signalHash),
  });
  
  // User A revokes
  await service.revokeEnrollment(100);
  
  // User B attempts takeover
  fakeClock.advance(10);
  const initDataB = createValidInitData(200, TEST_BOT_TOKEN);
  const challengeB = await service.createChallenge(initDataB);
  mockClient.setResponse(challengeB.signedChallenge.nonce, {
    success: true,
    nullifier: sharedNullifier,
    issuerSchemaId: 1,
    expiresAtMin: fakeClock.nowSeconds() + 86400,
  });
  
  const resultB = await service.completeEnrollment({
    initData: initDataB,
    idkitResult: createIDKitResult(challengeB.signedChallenge.nonce, TEST_ACTION, challengeB.signedChallenge.signalHash),
  });
  
  if (resultB.success !== false) {
    throw new Error('Should have prevented takeover');
  }
  
  if (!resultB.error || !resultB.error.match(/different account|immutable/i)) {
    throw new Error(`Wrong error: ${resultB.error}`);
  }
  
  service.close();
});

// Test: directEnroll production restriction
test('directEnroll blocked in production environment', async (testDbPath) => {
  const originalEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  
  try {
    const fakeClock = new FakeClock();
    const adapter = new WorldIdChallengeAdapter({
      appId: TEST_APP_ID,
      rpId: TEST_RP_ID,
      signingKeyHex: TEST_SIGNING_KEY,
      environment: 'staging',
    });
    const mockClient = new MockWorldIdClient();
    
    const service = new EnrollmentService({
      dbPath: testDbPath,
      challengeAdapter: adapter,
      verificationClient: mockClient,
      telegramBotToken: TEST_BOT_TOKEN,
      action: TEST_ACTION,
      clock: fakeClock,
    });
    
    let threwExpectedError = false;
    try {
      await service.directEnroll({
        telegramUserId: 999,
        nullifier: '0xtest',
        credential: { credential_type: 'orb' },
      });
    } catch (error) {
      if (error.message.match(/test-only.*production/i)) {
        threwExpectedError = true;
      } else {
        throw error;
      }
    }
    
    if (!threwExpectedError) {
      throw new Error('Should have blocked directEnroll in production');
    }
    
    service.close();
  } finally {
    process.env.NODE_ENV = originalEnv;
  }
});

// Run all tests
runTests().catch(error => {
  console.error('Test harness error:', error);
  process.exit(1);
});
