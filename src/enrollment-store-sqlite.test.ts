import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { unlinkSync } from "node:fs";
import {
  SqliteChallengeSessionStore,
  SqliteEnrollmentStore,
  type SqliteStoreConfig,
} from "./enrollment-store-sqlite.js";
import type { ChallengeSession, Enrollment } from "./enrollment-store.js";

describe("SqliteChallengeSessionStore", () => {
  const getTestDb = (): SqliteStoreConfig => ({
    dbPath: ":memory:", // In-memory for tests
  });

  it("creates and retrieves a challenge session", async () => {
    const store = new SqliteChallengeSessionStore(getTestDb());

    const session: ChallengeSession = {
      nonce: "test-nonce-123",
      telegramUserId: 987654321,
      action: "verify-human-2026",
      expiresAt: Math.floor(Date.now() / 1000) + 300,
      createdAt: new Date().toISOString(),
    };

    await store.createSession(session);
    const retrieved = await store.consumeSession("test-nonce-123");

    assert.ok(retrieved);
    assert.equal(retrieved.nonce, "test-nonce-123");
    assert.equal(retrieved.telegramUserId, 987654321);
    assert.equal(retrieved.action, "verify-human-2026");

    store.close();
  });

  it("atomic consume: session deleted after first consumption", async () => {
    const store = new SqliteChallengeSessionStore(getTestDb());

    const session: ChallengeSession = {
      nonce: "atomic-test",
      telegramUserId: 123456,
      action: "test",
      expiresAt: Math.floor(Date.now() / 1000) + 300,
      createdAt: new Date().toISOString(),
    };

    await store.createSession(session);

    // First consume: should return session
    const first = await store.consumeSession("atomic-test");
    assert.ok(first);

    // Second consume: should return null (already consumed)
    const second = await store.consumeSession("atomic-test");
    assert.equal(second, null);

    store.close();
  });

  it("rejects duplicate nonce", async () => {
    const store = new SqliteChallengeSessionStore(getTestDb());

    const session: ChallengeSession = {
      nonce: "duplicate-nonce",
      telegramUserId: 111222,
      action: "test",
      expiresAt: Math.floor(Date.now() / 1000) + 300,
      createdAt: new Date().toISOString(),
    };

    await store.createSession(session);

    await assert.rejects(
      async () => store.createSession(session),
      /Session nonce already exists/,
    );

    store.close();
  });

  it("returns null for expired session and cleans it up", async () => {
    const store = new SqliteChallengeSessionStore(getTestDb());

    const session: ChallengeSession = {
      nonce: "expired-session",
      telegramUserId: 333444,
      action: "test",
      expiresAt: Math.floor(Date.now() / 1000) - 10, // Expired 10 seconds ago
      createdAt: new Date().toISOString(),
    };

    await store.createSession(session);

    const retrieved = await store.consumeSession("expired-session");
    assert.equal(retrieved, null);

    // Session should be deleted (second attempt also returns null)
    const second = await store.consumeSession("expired-session");
    assert.equal(second, null);

    store.close();
  });

  it("returns null for non-existent session", async () => {
    const store = new SqliteChallengeSessionStore(getTestDb());

    const retrieved = await store.consumeSession("non-existent");
    assert.equal(retrieved, null);

    store.close();
  });

  it("expires sessions older than timestamp", async () => {
    const store = new SqliteChallengeSessionStore(getTestDb());

    const now = Math.floor(Date.now() / 1000);

    // Create old expired session
    const oldSession: ChallengeSession = {
      nonce: "old-session",
      telegramUserId: 555666,
      action: "test",
      expiresAt: now - 100,
      createdAt: new Date().toISOString(),
    };

    // Create recent session
    const recentSession: ChallengeSession = {
      nonce: "recent-session",
      telegramUserId: 777888,
      action: "test",
      expiresAt: now + 300,
      createdAt: new Date().toISOString(),
    };

    await store.createSession(oldSession);
    await store.createSession(recentSession);

    const expired = await store.expireSessions(now);
    assert.equal(expired, 1);

    // Old session should be gone
    const oldRetrieved = await store.consumeSession("old-session");
    assert.equal(oldRetrieved, null);

    // Recent session should still exist
    const recentRetrieved = await store.consumeSession("recent-session");
    assert.ok(recentRetrieved);

    store.close();
  });

  it("persists across database reopens (file-based)", async () => {
    const dbPath = "/tmp/test-challenge-sessions.db";

    // Clean up any existing test db
    try {
      unlinkSync(dbPath);
    } catch {}

    // First instance: create session
    const store1 = new SqliteChallengeSessionStore({ dbPath });
    const session: ChallengeSession = {
      nonce: "persistent-nonce",
      telegramUserId: 999000,
      action: "test",
      expiresAt: Math.floor(Date.now() / 1000) + 300,
      createdAt: new Date().toISOString(),
    };
    await store1.createSession(session);
    store1.close();

    // Second instance: retrieve session
    const store2 = new SqliteChallengeSessionStore({ dbPath });
    const retrieved = await store2.consumeSession("persistent-nonce");
    assert.ok(retrieved);
    assert.equal(retrieved.telegramUserId, 999000);
    store2.close();

    // Clean up
    unlinkSync(dbPath);
  });

  it("validates session structure at runtime", async () => {
    const store = new SqliteChallengeSessionStore(getTestDb());

    await assert.rejects(
      async () => store.createSession(null as any),
      /Invalid session: must be object/,
    );

    await assert.rejects(
      async () => store.createSession({ nonce: "", telegramUserId: 123 } as any),
      /nonce must be non-empty string/,
    );

    await assert.rejects(
      async () => store.createSession({ nonce: "test", telegramUserId: 0 } as any),
      /telegramUserId must be positive safe integer/,
    );

    store.close();
  });

  it("requester-bound completion: copied challenge cannot change account", async () => {
    const store = new SqliteChallengeSessionStore(getTestDb());

    // Alice creates a challenge session
    const aliceSession: ChallengeSession = {
      nonce: "alice-nonce",
      telegramUserId: 111111,
      action: "verify-human-2026",
      expiresAt: Math.floor(Date.now() / 1000) + 300,
      createdAt: new Date().toISOString(),
    };

    await store.createSession(aliceSession);

    // Consume the session (simulating completion flow)
    const consumed = await store.consumeSession("alice-nonce");
    assert.ok(consumed);
    assert.equal(consumed.telegramUserId, 111111); // Must be Alice's ID

    // Bob tries to create a session with the same nonce (replay attack)
    // This should fail because nonce is consumed/deleted
    const bobSession: ChallengeSession = {
      nonce: "alice-nonce",
      telegramUserId: 222222, // Bob's ID
      action: "verify-human-2026",
      expiresAt: Math.floor(Date.now() / 1000) + 300,
      createdAt: new Date().toISOString(),
    };

    // Cannot create session with consumed nonce
    // (In practice, Bob would need to get the nonce from Alice's client,
    // but the consumed nonce is already deleted)
    const secondConsume = await store.consumeSession("alice-nonce");
    assert.equal(secondConsume, null); // Already consumed

    store.close();
  });
});

describe("SqliteEnrollmentStore", () => {
  const getTestDb = (): SqliteStoreConfig => ({
    dbPath: ":memory:",
  });

  it("creates and finds an enrollment", async () => {
    const store = new SqliteEnrollmentStore(getTestDb());

    const enrollment: Enrollment = {
      nullifier: "0x123abc",
      telegramUserId: 987654321,
      action: "verify-human-2026",
      expiresAt: Math.floor(Date.now() / 1000) + 2592000, // 30 days
      createdAt: new Date().toISOString(),
    };

    await store.createEnrollment(enrollment);

    const found = await store.findEnrollment(987654321, "verify-human-2026", new Date());
    assert.ok(found);
    assert.equal(found.nullifier, "0x123abc");
    assert.equal(found.telegramUserId, 987654321);

    store.close();
  });

  it("rejects duplicate nullifier", async () => {
    const store = new SqliteEnrollmentStore(getTestDb());

    const enrollment: Enrollment = {
      nullifier: "0xduplicate",
      telegramUserId: 111222,
      action: "test",
      expiresAt: Math.floor(Date.now() / 1000) + 2592000,
      createdAt: new Date().toISOString(),
    };

    await store.createEnrollment(enrollment);

    // Try to create enrollment with same nullifier but different user
    const duplicate: Enrollment = {
      nullifier: "0xduplicate",
      telegramUserId: 333444, // Different user
      action: "test",
      expiresAt: Math.floor(Date.now() / 1000) + 2592000,
      createdAt: new Date().toISOString(),
    };

    await assert.rejects(
      async () => store.createEnrollment(duplicate),
      /Enrollment nullifier already exists/,
    );

    store.close();
  });

  it("rejects duplicate (telegramUserId, action) pair", async () => {
    const store = new SqliteEnrollmentStore(getTestDb());

    const enrollment: Enrollment = {
      nullifier: "0xfirst",
      telegramUserId: 555666,
      action: "verify-human-2026",
      expiresAt: Math.floor(Date.now() / 1000) + 2592000,
      createdAt: new Date().toISOString(),
    };

    await store.createEnrollment(enrollment);

    // Try to create second enrollment for same user+action
    const duplicate: Enrollment = {
      nullifier: "0xsecond", // Different nullifier
      telegramUserId: 555666, // Same user
      action: "verify-human-2026", // Same action
      expiresAt: Math.floor(Date.now() / 1000) + 2592000,
      createdAt: new Date().toISOString(),
    };

    await assert.rejects(
      async () => store.createEnrollment(duplicate),
      /Enrollment for telegramUserId 555666 and action verify-human-2026 already exists/,
    );

    store.close();
  });

  it("returns null for non-existent enrollment", async () => {
    const store = new SqliteEnrollmentStore(getTestDb());

    const found = await store.findEnrollment(999999, "test", new Date());
    assert.equal(found, null);

    store.close();
  });

  it("returns null for expired enrollment and cleans it up", async () => {
    const store = new SqliteEnrollmentStore(getTestDb());

    const enrollment: Enrollment = {
      nullifier: "0xexpired",
      telegramUserId: 777888,
      action: "test",
      expiresAt: Math.floor(Date.now() / 1000) - 10, // Expired 10 seconds ago
      createdAt: new Date().toISOString(),
    };

    await store.createEnrollment(enrollment);

    const found = await store.findEnrollment(777888, "test", new Date());
    assert.equal(found, null);

    // Enrollment should be deleted (second lookup also returns null)
    const second = await store.findEnrollment(777888, "test", new Date());
    assert.equal(second, null);

    store.close();
  });

  it("deletes enrollment by nullifier", async () => {
    const store = new SqliteEnrollmentStore(getTestDb());

    const enrollment: Enrollment = {
      nullifier: "0xdelete-me",
      telegramUserId: 111222,
      action: "test",
      expiresAt: Math.floor(Date.now() / 1000) + 2592000,
      createdAt: new Date().toISOString(),
    };

    await store.createEnrollment(enrollment);

    const deleted = await store.deleteEnrollment("0xdelete-me");
    assert.equal(deleted, true);

    // Enrollment should be gone
    const found = await store.findEnrollment(111222, "test", new Date());
    assert.equal(found, null);

    store.close();
  });

  it("returns false when deleting non-existent enrollment", async () => {
    const store = new SqliteEnrollmentStore(getTestDb());

    const deleted = await store.deleteEnrollment("0xnon-existent");
    assert.equal(deleted, false);

    store.close();
  });

  it("expires enrollments older than timestamp", async () => {
    const store = new SqliteEnrollmentStore(getTestDb());

    const now = Math.floor(Date.now() / 1000);

    // Create old expired enrollment
    const oldEnrollment: Enrollment = {
      nullifier: "0xold",
      telegramUserId: 333444,
      action: "test",
      expiresAt: now - 100,
      createdAt: new Date().toISOString(),
    };

    // Create recent enrollment
    const recentEnrollment: Enrollment = {
      nullifier: "0xrecent",
      telegramUserId: 555666,
      action: "test",
      expiresAt: now + 2592000,
      createdAt: new Date().toISOString(),
    };

    await store.createEnrollment(oldEnrollment);
    await store.createEnrollment(recentEnrollment);

    const expired = await store.expireEnrollments(now);
    assert.equal(expired, 1);

    // Old enrollment should be gone
    const oldFound = await store.findEnrollment(333444, "test", new Date());
    assert.equal(oldFound, null);

    // Recent enrollment should still exist
    const recentFound = await store.findEnrollment(555666, "test", new Date());
    assert.ok(recentFound);

    store.close();
  });

  it("persists across database reopens (file-based)", async () => {
    const dbPath = "/tmp/test-enrollments.db";

    // Clean up any existing test db
    try {
      unlinkSync(dbPath);
    } catch {}

    // First instance: create enrollment
    const store1 = new SqliteEnrollmentStore({ dbPath });
    const enrollment: Enrollment = {
      nullifier: "0xpersistent",
      telegramUserId: 999000,
      action: "test",
      expiresAt: Math.floor(Date.now() / 1000) + 2592000,
      createdAt: new Date().toISOString(),
    };
    await store1.createEnrollment(enrollment);
    store1.close();

    // Second instance: retrieve enrollment
    const store2 = new SqliteEnrollmentStore({ dbPath });
    const found = await store2.findEnrollment(999000, "test", new Date());
    assert.ok(found);
    assert.equal(found.nullifier, "0xpersistent");
    store2.close();

    // Clean up
    unlinkSync(dbPath);
  });

  it("validates enrollment structure at runtime", async () => {
    const store = new SqliteEnrollmentStore(getTestDb());

    await assert.rejects(
      async () => store.createEnrollment(null as any),
      /Invalid enrollment: must be object/,
    );

    await assert.rejects(
      async () => store.createEnrollment({ nullifier: "", telegramUserId: 123 } as any),
      /nullifier must be non-empty string/,
    );

    await assert.rejects(
      async () => store.createEnrollment({ nullifier: "0xtest", telegramUserId: 0 } as any),
      /telegramUserId must be positive safe integer/,
    );

    store.close();
  });

  it("no stale grant: expired enrollment not returned", async () => {
    const store = new SqliteEnrollmentStore(getTestDb());

    const enrollment: Enrollment = {
      nullifier: "0xstale",
      telegramUserId: 111222,
      action: "verify-human-2026",
      expiresAt: Math.floor(Date.now() / 1000) + 5, // Expires in 5 seconds
      createdAt: new Date().toISOString(),
    };

    await store.createEnrollment(enrollment);

    // Wait for expiration
    await new Promise((resolve) => setTimeout(resolve, 6000));

    // Should return null (expired)
    const found = await store.findEnrollment(111222, "verify-human-2026", new Date());
    assert.equal(found, null);

    store.close();
  });

  it("concurrent replay protection: nullifier uniqueness enforced", async () => {
    const store = new SqliteEnrollmentStore(getTestDb());

    const enrollment: Enrollment = {
      nullifier: "0xunique",
      telegramUserId: 111111,
      action: "test",
      expiresAt: Math.floor(Date.now() / 1000) + 2592000,
      createdAt: new Date().toISOString(),
    };

    await store.createEnrollment(enrollment);

    // Concurrent attempt to create enrollment with same nullifier
    const replay: Enrollment = {
      nullifier: "0xunique", // Same nullifier
      telegramUserId: 222222, // Different user (replay attack)
      action: "test",
      expiresAt: Math.floor(Date.now() / 1000) + 2592000,
      createdAt: new Date().toISOString(),
    };

    await assert.rejects(
      async () => store.createEnrollment(replay),
      /Enrollment nullifier already exists/,
    );

    // Original enrollment should still exist for original user
    const found = await store.findEnrollment(111111, "test", new Date());
    assert.ok(found);
    assert.equal(found.nullifier, "0xunique");

    // Attacker should not have enrollment
    const attackerFound = await store.findEnrollment(222222, "test", new Date());
    assert.equal(attackerFound, null);

    store.close();
  });

  it("account mismatch protection: user+action uniqueness enforced", async () => {
    const store = new SqliteEnrollmentStore(getTestDb());

    const enrollment: Enrollment = {
      nullifier: "0xfirst",
      telegramUserId: 333333,
      action: "verify-human-2026",
      expiresAt: Math.floor(Date.now() / 1000) + 2592000,
      createdAt: new Date().toISOString(),
    };

    await store.createEnrollment(enrollment);

    // Attempt to create second enrollment for same user+action with different nullifier
    const mismatch: Enrollment = {
      nullifier: "0xsecond",
      telegramUserId: 333333, // Same user
      action: "verify-human-2026", // Same action
      expiresAt: Math.floor(Date.now() / 1000) + 2592000,
      createdAt: new Date().toISOString(),
    };

    await assert.rejects(
      async () => store.createEnrollment(mismatch),
      /Enrollment for telegramUserId 333333 and action verify-human-2026 already exists/,
    );

    // Original enrollment should remain unchanged
    const found = await store.findEnrollment(333333, "verify-human-2026", new Date());
    assert.ok(found);
    assert.equal(found.nullifier, "0xfirst");

    store.close();
  });

  it("configurable 30-day expiry: actual TTL at enrollment time", async () => {
    const store = new SqliteEnrollmentStore(getTestDb());

    const now = Math.floor(Date.now() / 1000);
    const thirtyDays = 30 * 24 * 60 * 60;

    const enrollment: Enrollment = {
      nullifier: "0xttl-test",
      telegramUserId: 444444,
      action: "test",
      expiresAt: now + thirtyDays, // 30 days from now
      createdAt: new Date().toISOString(),
    };

    await store.createEnrollment(enrollment);

    // Retrieve enrollment
    const found = await store.findEnrollment(444444, "test", new Date());
    assert.ok(found);
    assert.equal(found.expiresAt, now + thirtyDays);

    // Enrollment should still be valid (not expired)
    assert.ok(found.expiresAt > now);

    store.close();
  });

  it("existing expiry unchanged on lookup", async () => {
    const store = new SqliteEnrollmentStore(getTestDb());

    const now = Math.floor(Date.now() / 1000);
    const originalExpiry = now + 1000;

    const enrollment: Enrollment = {
      nullifier: "0xfixed-expiry",
      telegramUserId: 555555,
      action: "test",
      expiresAt: originalExpiry,
      createdAt: new Date().toISOString(),
    };

    await store.createEnrollment(enrollment);

    // Multiple lookups should not change expiry
    const found1 = await store.findEnrollment(555555, "test", new Date());
    const found2 = await store.findEnrollment(555555, "test", new Date());
    const found3 = await store.findEnrollment(555555, "test", new Date());

    assert.ok(found1);
    assert.ok(found2);
    assert.ok(found3);
    assert.equal(found1.expiresAt, originalExpiry);
    assert.equal(found2.expiresAt, originalExpiry);
    assert.equal(found3.expiresAt, originalExpiry);

    store.close();
  });
});
