import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  InMemoryChallengeSessionStore,
  InMemoryEnrollmentStore,
  type ChallengeSession,
  type Enrollment,
} from "./enrollment-store.js";

describe("InMemoryChallengeSessionStore", () => {
  it("creates a new session successfully", async () => {
    const store = new InMemoryChallengeSessionStore();
    const session: ChallengeSession = {
      nonce: "nonce-123",
      telegramUserId: 123456789,
      action: "verify-human",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      createdAt: new Date().toISOString(),
    };

    await assert.doesNotReject(store.createSession(session));
  });

  it("rejects duplicate nonce creation", async () => {
    const store = new InMemoryChallengeSessionStore();
    const session: ChallengeSession = {
      nonce: "nonce-duplicate",
      telegramUserId: 123456789,
      action: "verify-human",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      createdAt: new Date().toISOString(),
    };

    await store.createSession(session);

    await assert.rejects(
      store.createSession(session),
      /Session nonce already exists: nonce-duplicate/,
    );
  });

  it("consumes (retrieves and deletes) a valid session", async () => {
    const store = new InMemoryChallengeSessionStore();
    const session: ChallengeSession = {
      nonce: "nonce-consume",
      telegramUserId: 987654321,
      action: "verify-human",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      createdAt: new Date().toISOString(),
    };

    await store.createSession(session);

    const consumed = await store.consumeSession("nonce-consume");
    assert.ok(consumed);
    assert.equal(consumed.nonce, "nonce-consume");
    assert.equal(consumed.telegramUserId, 987654321);

    // Second consume should return null (already deleted)
    const secondConsume = await store.consumeSession("nonce-consume");
    assert.equal(secondConsume, null);
  });

  it("returns null when consuming non-existent session", async () => {
    const store = new InMemoryChallengeSessionStore();

    const consumed = await store.consumeSession("nonexistent");
    assert.equal(consumed, null);
  });

  it("returns null when consuming expired session", async () => {
    const store = new InMemoryChallengeSessionStore();
    const session: ChallengeSession = {
      nonce: "nonce-expired",
      telegramUserId: 111222333,
      action: "verify-human",
      expiresAt: Math.floor(Date.now() / 1000) - 1, // Already expired
      createdAt: new Date(Date.now() - 3600000).toISOString(),
    };

    await store.createSession(session);

    const consumed = await store.consumeSession("nonce-expired");
    assert.equal(consumed, null);
  });

  it("expires sessions older than given timestamp", async () => {
    const store = new InMemoryChallengeSessionStore();
    const now = Math.floor(Date.now() / 1000);

    await store.createSession({
      nonce: "old-1",
      telegramUserId: 1,
      action: "action",
      expiresAt: now - 100,
      createdAt: new Date().toISOString(),
    });

    await store.createSession({
      nonce: "old-2",
      telegramUserId: 2,
      action: "action",
      expiresAt: now - 50,
      createdAt: new Date().toISOString(),
    });

    await store.createSession({
      nonce: "fresh",
      telegramUserId: 3,
      action: "action",
      expiresAt: now + 3600,
      createdAt: new Date().toISOString(),
    });

    const expiredCount = await store.expireSessions(now);
    assert.equal(expiredCount, 2);

    // Fresh session should still be consumable
    const fresh = await store.consumeSession("fresh");
    assert.ok(fresh);
  });
});

describe("InMemoryEnrollmentStore", () => {
  it("creates a new enrollment successfully", async () => {
    const store = new InMemoryEnrollmentStore();
    const enrollment: Enrollment = {
      nullifier: "0xabc123",
      telegramUserId: 123456789,
      action: "verify-human",
      expiresAt: Math.floor(Date.now() / 1000) + 86400,
      createdAt: new Date().toISOString(),
    };

    await assert.doesNotReject(store.createEnrollment(enrollment));
  });

  it("rejects duplicate nullifier creation", async () => {
    const store = new InMemoryEnrollmentStore();
    const enrollment: Enrollment = {
      nullifier: "0x0000000000000000000000000000000000000000000000000000000000de1111",
      telegramUserId: 123,
      action: "action",
      expiresAt: Math.floor(Date.now() / 1000) + 86400,
      createdAt: new Date().toISOString(),
    };

    await store.createEnrollment(enrollment);

    await assert.rejects(
      store.createEnrollment({ ...enrollment, telegramUserId: 456 }),
      /Enrollment nullifier already exists: 0xdup/,
    );
  });

  it("rejects duplicate (telegramUserId, action) creation", async () => {
    const store = new InMemoryEnrollmentStore();
    const enrollment: Enrollment = {
      nullifier: "0x00000000000000000000000000000000000000000000000000000000000f1257",
      telegramUserId: 999,
      action: "verify-human",
      expiresAt: Math.floor(Date.now() / 1000) + 86400,
      createdAt: new Date().toISOString(),
    };

    await store.createEnrollment(enrollment);

    await assert.rejects(
      store.createEnrollment({
        ...enrollment,
        nullifier: "0x000000000000000000000000000000000000000000000000000000000052ec0d",
      }),
      /Enrollment for telegramUserId 999 and action verify-human already exists/,
    );
  });

  it("finds active enrollment by telegramUserId and action", async () => {
    const store = new InMemoryEnrollmentStore();
    const now = new Date();
    const enrollment: Enrollment = {
      nullifier: "0x000000000000000000000000000000000000000000000000000000000000f1de",
      telegramUserId: 777,
      action: "verify-human",
      expiresAt: Math.floor(now.getTime() / 1000) + 86400,
      createdAt: now.toISOString(),
    };

    await store.createEnrollment(enrollment);

    const found = await store.findEnrollment(777, "verify-human", now);
    assert.ok(found);
    assert.equal(found.nullifier, "0x000000000000000000000000000000000000000000000000000000000000f1de");
    assert.equal(found.telegramUserId, 777);
  });

  it("returns null when finding non-existent enrollment", async () => {
    const store = new InMemoryEnrollmentStore();

    const found = await store.findEnrollment(9999, "nonexistent", new Date());
    assert.equal(found, null);
  });

  it("returns null when finding expired enrollment", async () => {
    const store = new InMemoryEnrollmentStore();
    const past = new Date(Date.now() - 86400000);
    const enrollment: Enrollment = {
      nullifier: "0x0000000000000000000000000000000000000000000000000000000000exp1ed",
      telegramUserId: 888,
      action: "verify-human",
      expiresAt: Math.floor(past.getTime() / 1000),
      createdAt: past.toISOString(),
    };

    await store.createEnrollment(enrollment);

    const now = new Date();
    const found = await store.findEnrollment(888, "verify-human", now);
    assert.equal(found, null);
  });

  it("deletes enrollment by nullifier", async () => {
    const store = new InMemoryEnrollmentStore();
    const enrollment: Enrollment = {
      nullifier: "0x000000000000000000000000000000000000000000000000000000000de1e7e",
      telegramUserId: 555,
      action: "action",
      expiresAt: Math.floor(Date.now() / 1000) + 86400,
      createdAt: new Date().toISOString(),
    };

    await store.createEnrollment(enrollment);

    const deleted = await store.deleteEnrollment("0x000000000000000000000000000000000000000000000000000000000de1e7e");
    assert.ok(deleted);

    const found = await store.findEnrollment(555, "action", new Date());
    assert.equal(found, null);
  });

  it("returns false when deleting non-existent enrollment", async () => {
    const store = new InMemoryEnrollmentStore();

    const deleted = await store.deleteEnrollment("0x00000000000000000000000000000000000000000000000000000000000000ee");
    assert.ok(!deleted);
  });

  it("expires enrollments older than given timestamp", async () => {
    const store = new InMemoryEnrollmentStore();
    const now = Math.floor(Date.now() / 1000);

    await store.createEnrollment({
      nullifier: "0x0000000000000000000000000000000000000000000000000000000000001d01",
      telegramUserId: 1,
      action: "action",
      expiresAt: now - 100,
      createdAt: new Date().toISOString(),
    });

    await store.createEnrollment({
      nullifier: "0x0000000000000000000000000000000000000000000000000000000000001d02",
      telegramUserId: 2,
      action: "action",
      expiresAt: now - 50,
      createdAt: new Date().toISOString(),
    });

    await store.createEnrollment({
      nullifier: "0x000000000000000000000000000000000000000000000000000000000000f5e5",
      telegramUserId: 3,
      action: "action",
      expiresAt: now + 86400,
      createdAt: new Date().toISOString(),
    });

    const expiredCount = await store.expireEnrollments(now);
    assert.equal(expiredCount, 2);

    // Fresh enrollment should still be findable
    const fresh = await store.findEnrollment(3, "action", new Date());
    assert.ok(fresh);
  });

  it("allows different actions for same telegram user", async () => {
    const store = new InMemoryEnrollmentStore();
    const userId = 321;

    await store.createEnrollment({
      nullifier: "0x000000000000000000000000000000000000000000000000000000000ac71001",
      telegramUserId: userId,
      action: "action-one",
      expiresAt: Math.floor(Date.now() / 1000) + 86400,
      createdAt: new Date().toISOString(),
    });

    await store.createEnrollment({
      nullifier: "0x000000000000000000000000000000000000000000000000000000000ac71002",
      telegramUserId: userId,
      action: "action-two",
      expiresAt: Math.floor(Date.now() / 1000) + 86400,
      createdAt: new Date().toISOString(),
    });

    const found1 = await store.findEnrollment(userId, "action-one", new Date());
    const found2 = await store.findEnrollment(userId, "action-two", new Date());

    assert.ok(found1);
    assert.ok(found2);
    assert.equal(found1.nullifier, "0x000000000000000000000000000000000000000000000000000000000ac71001");
    assert.equal(found2.nullifier, "0x000000000000000000000000000000000000000000000000000000000ac71002");
  });
});
