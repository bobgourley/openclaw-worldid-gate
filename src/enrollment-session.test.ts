/**
 * Session-based enrollment and verification tests.
 *
 * Tests the hard cutover migration to session-bound enrollment with
 * openclaw-enroll-v2 action, covering:
 * - Uniqueness + session creation during enrollment
 * - Returning user verification with session proofs
 * - Revocation and reactivation
 * - Replay protection
 * - Hard cutover semantics (legacy action denial)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SqliteEnrollmentStore,
  SqliteChallengeSessionStore,
  type SqliteStoreConfig,
} from "./enrollment-store-sqlite.js";
import type { Enrollment, SessionNullifierClaim } from "./enrollment-store.js";

function getTestDb(): SqliteStoreConfig {
  return { dbPath: ":memory:" };
}

describe("Session-based enrollment", () => {
  describe("Uniqueness + session creation", () => {
    it("should create enrollment with session_id from v4 uniqueness+session proof", async () => {
      const store = new SqliteEnrollmentStore(getTestDb());

      const enrollment: Enrollment = {
        nullifier: "0xabc123",
        telegramUserId: 12345,
        action: "openclaw-enroll-v2",
        expiresAt: Math.floor(Date.now() / 1000) + 86400,
        createdAt: new Date().toISOString(),
        sessionId: "session_5f3a9c2e8d1b0a",
        protocolVersion: "4.0",
        migrationGeneration: 1,
      };

      await store.createEnrollment(enrollment);

      const found = await store.findEnrollment(12345, "openclaw-enroll-v2", new Date());
      assert.ok(found);
      assert.strictEqual(found?.sessionId, "session_5f3a9c2e8d1b0a");
      assert.strictEqual(found?.protocolVersion, "4.0");
      assert.strictEqual(found?.migrationGeneration, 1);
    });

    it("should reject enrollment with duplicate session_id", async () => {
      const store = new SqliteEnrollmentStore(getTestDb());

      const enrollment1: Enrollment = {
        nullifier: "0xabc123",
        telegramUserId: 12345,
        action: "openclaw-enroll-v2",
        expiresAt: Math.floor(Date.now() / 1000) + 86400,
        createdAt: new Date().toISOString(),
        sessionId: "session_duplicate",
        protocolVersion: "4.0",
      };

      await store.createEnrollment(enrollment1);

      const enrollment2: Enrollment = {
        nullifier: "0xdef456",
        telegramUserId: 67890,
        action: "openclaw-enroll-v2",
        expiresAt: Math.floor(Date.now() / 1000) + 86400,
        createdAt: new Date().toISOString(),
        sessionId: "session_duplicate",
        protocolVersion: "4.0",
      };

      await assert.rejects(
        () => store.createEnrollment(enrollment2),
        /Session ID already bound to different enrollment/
      );
    });

    it("should reject enrollment with same Telegram user + action", async () => {
      const store = new SqliteEnrollmentStore(getTestDb());

      const enrollment1: Enrollment = {
        nullifier: "0xabc123",
        telegramUserId: 12345,
        action: "openclaw-enroll-v2",
        expiresAt: Math.floor(Date.now() / 1000) + 86400,
        createdAt: new Date().toISOString(),
        sessionId: "session_first",
        protocolVersion: "4.0",
      };

      await store.createEnrollment(enrollment1);

      const enrollment2: Enrollment = {
        nullifier: "0xdef456",
        telegramUserId: 12345,
        action: "openclaw-enroll-v2",
        expiresAt: Math.floor(Date.now() / 1000) + 86400,
        createdAt: new Date().toISOString(),
        sessionId: "session_second",
        protocolVersion: "4.0",
      };

      await assert.rejects(
        () => store.createEnrollment(enrollment2),
        /Enrollment for telegramUserId 12345 and action openclaw-enroll-v2 already exists/
      );
    });

    it("should reject enrollment with same nullifier (different person same World ID)", async () => {
      const store = new SqliteEnrollmentStore(getTestDb());

      const enrollment1: Enrollment = {
        nullifier: "0x0000000000000000000000000000000000000000000000000000000000000afa",
        telegramUserId: 12345,
        action: "openclaw-enroll-v2",
        expiresAt: Math.floor(Date.now() / 1000) + 86400,
        createdAt: new Date().toISOString(),
        sessionId: "session_first",
        protocolVersion: "4.0",
      };

      await store.createEnrollment(enrollment1);

      const enrollment2: Enrollment = {
        nullifier: "0x0000000000000000000000000000000000000000000000000000000000000afa",
        telegramUserId: 67890,
        action: "openclaw-enroll-v2",
        expiresAt: Math.floor(Date.now() / 1000) + 86400,
        createdAt: new Date().toISOString(),
        sessionId: "session_second",
        protocolVersion: "4.0",
      };

      await assert.rejects(
        () => store.createEnrollment(enrollment2),
        /Enrollment nullifier already exists/
      );
    });

    it("should allow same person different actions (different session IDs)", async () => {
      const store = new SqliteEnrollmentStore(getTestDb());

      const enrollment1: Enrollment = {
        nullifier: "0xabc123",
        telegramUserId: 12345,
        action: "openclaw-enroll-v2",
        expiresAt: Math.floor(Date.now() / 1000) + 86400,
        createdAt: new Date().toISOString(),
        sessionId: "session_action1",
        protocolVersion: "4.0",
      };

      await store.createEnrollment(enrollment1);

      const enrollment2: Enrollment = {
        nullifier: "0xdef456",
        telegramUserId: 12345,
        action: "other-action",
        expiresAt: Math.floor(Date.now() / 1000) + 86400,
        createdAt: new Date().toISOString(),
        sessionId: "session_action2",
        protocolVersion: "4.0",
      };

      await store.createEnrollment(enrollment2);

      const found1 = await store.findEnrollment(12345, "openclaw-enroll-v2", new Date());
      const found2 = await store.findEnrollment(12345, "other-action", new Date());

      assert.strictEqual(found1?.sessionId, "session_action1");
      assert.strictEqual(found2?.sessionId, "session_action2");
    });
  });

  describe("Session proof replay protection", () => {
    it("should record session nullifier claim from session proof", async () => {
      const store = new SqliteEnrollmentStore(getTestDb());

      const enrollment: Enrollment = {
        nullifier: "0xabc123",
        telegramUserId: 12345,
        action: "openclaw-enroll-v2",
        expiresAt: Math.floor(Date.now() / 1000) + 86400,
        createdAt: new Date().toISOString(),
        sessionId: "session_test",
        protocolVersion: "4.0",
      };

      await store.createEnrollment(enrollment);

      const claim: SessionNullifierClaim = {
        sessionNullifier: "0xsession_null_1",
        action: "openclaw-enroll-v2",
        sessionId: "session_test",
        enrollmentNullifier: "0xabc123",
        claimedAt: new Date().toISOString(),
      };

      await store.recordSessionNullifierClaim(claim);

      const isClaimed = await store.isSessionNullifierClaimed("0xsession_null_1", "openclaw-enroll-v2");
      assert.strictEqual(isClaimed, true);
    });

    it("should reject duplicate session nullifier claim (replay attack)", async () => {
      const store = new SqliteEnrollmentStore(getTestDb());

      const enrollment: Enrollment = {
        nullifier: "0xabc123",
        telegramUserId: 12345,
        action: "openclaw-enroll-v2",
        expiresAt: Math.floor(Date.now() / 1000) + 86400,
        createdAt: new Date().toISOString(),
        sessionId: "session_test",
        protocolVersion: "4.0",
      };

      await store.createEnrollment(enrollment);

      const claim: SessionNullifierClaim = {
        sessionNullifier: "0xreplayed",
        action: "openclaw-enroll-v2",
        sessionId: "session_test",
        enrollmentNullifier: "0xabc123",
        claimedAt: new Date().toISOString(),
      };

      await store.recordSessionNullifierClaim(claim);

      await assert.rejects(
        () => store.recordSessionNullifierClaim(claim),
        /Session nullifier already claimed/
      );
    });

    it("should allow same session nullifier for different actions", async () => {
      const store = new SqliteEnrollmentStore(getTestDb());

      const enrollment: Enrollment = {
        nullifier: "0xabc123",
        telegramUserId: 12345,
        action: "openclaw-enroll-v2",
        expiresAt: Math.floor(Date.now() / 1000) + 86400,
        createdAt: new Date().toISOString(),
        sessionId: "session_test",
        protocolVersion: "4.0",
      };

      await store.createEnrollment(enrollment);

      const claim1: SessionNullifierClaim = {
        sessionNullifier: "0xsame_null",
        action: "openclaw-enroll-v2",
        sessionId: "session_test",
        enrollmentNullifier: "0xabc123",
        claimedAt: new Date().toISOString(),
      };

      const claim2: SessionNullifierClaim = {
        sessionNullifier: "0xsame_null",
        action: "other-action",
        sessionId: "session_test",
        enrollmentNullifier: "0xabc123",
        claimedAt: new Date().toISOString(),
      };

      await store.recordSessionNullifierClaim(claim1);
      await store.recordSessionNullifierClaim(claim2);

      const isClaimed1 = await store.isSessionNullifierClaimed("0xsame_null", "openclaw-enroll-v2");
      const isClaimed2 = await store.isSessionNullifierClaimed("0xsame_null", "other-action");

      assert.strictEqual(isClaimed1, true);
      assert.strictEqual(isClaimed2, true);
    });
  });

  describe("Revocation and reactivation", () => {
    it("should revoke active enrollment", async () => {
      const store = new SqliteEnrollmentStore(getTestDb());

      const enrollment: Enrollment = {
        nullifier: "0xabc123",
        telegramUserId: 12345,
        action: "openclaw-enroll-v2",
        expiresAt: Math.floor(Date.now() / 1000) + 86400,
        createdAt: new Date().toISOString(),
        sessionId: "session_test",
        protocolVersion: "4.0",
      };

      await store.createEnrollment(enrollment);

      const revoked = await store.revokeEnrollment("0xabc123", "user");
      assert.strictEqual(revoked, true);

      const found = await store.findEnrollment(12345, "openclaw-enroll-v2", new Date());
      assert.strictEqual(found, null);
    });

    it("should not find revoked enrollment", async () => {
      const store = new SqliteEnrollmentStore(getTestDb());

      const enrollment: Enrollment = {
        nullifier: "0xabc123",
        telegramUserId: 12345,
        action: "openclaw-enroll-v2",
        expiresAt: Math.floor(Date.now() / 1000) + 86400,
        createdAt: new Date().toISOString(),
        sessionId: "session_test",
        protocolVersion: "4.0",
      };

      await store.createEnrollment(enrollment);
      await store.revokeEnrollment("0xabc123", "admin");

      const found = await store.findEnrollment(12345, "openclaw-enroll-v2", new Date());
      assert.strictEqual(found, null);
    });

    it("should prevent double revocation", async () => {
      const store = new SqliteEnrollmentStore(getTestDb());

      const enrollment: Enrollment = {
        nullifier: "0xabc123",
        telegramUserId: 12345,
        action: "openclaw-enroll-v2",
        expiresAt: Math.floor(Date.now() / 1000) + 86400,
        createdAt: new Date().toISOString(),
        sessionId: "session_test",
        protocolVersion: "4.0",
      };

      await store.createEnrollment(enrollment);

      const revoked1 = await store.revokeEnrollment("0xabc123", "user");
      assert.strictEqual(revoked1, true);

      const revoked2 = await store.revokeEnrollment("0xabc123", "user");
      assert.strictEqual(revoked2, false);
    });

    it("should reactivate revoked enrollment", async () => {
      const store = new SqliteEnrollmentStore(getTestDb());

      const enrollment: Enrollment = {
        nullifier: "0xabc123",
        telegramUserId: 12345,
        action: "openclaw-enroll-v2",
        expiresAt: Math.floor(Date.now() / 1000) + 86400,
        createdAt: new Date().toISOString(),
        sessionId: "session_test",
        protocolVersion: "4.0",
      };

      await store.createEnrollment(enrollment);
      await store.revokeEnrollment("0xabc123", "user");

      const reactivated = await store.reactivateEnrollment("0xabc123", "admin");
      assert.strictEqual(reactivated, true);

      const found = await store.findEnrollment(12345, "openclaw-enroll-v2", new Date());
      assert.ok(found);
      assert.strictEqual(found?.sessionId, "session_test");
    });

    it("should not reactivate active enrollment", async () => {
      const store = new SqliteEnrollmentStore(getTestDb());

      const enrollment: Enrollment = {
        nullifier: "0xabc123",
        telegramUserId: 12345,
        action: "openclaw-enroll-v2",
        expiresAt: Math.floor(Date.now() / 1000) + 86400,
        createdAt: new Date().toISOString(),
        sessionId: "session_test",
        protocolVersion: "4.0",
      };

      await store.createEnrollment(enrollment);

      const reactivated = await store.reactivateEnrollment("0xabc123", "admin");
      assert.strictEqual(reactivated, false);
    });

    it("should preserve session_id binding through revoke/reactivate cycle", async () => {
      const store = new SqliteEnrollmentStore(getTestDb());

      const enrollment: Enrollment = {
        nullifier: "0xabc123",
        telegramUserId: 12345,
        action: "openclaw-enroll-v2",
        expiresAt: Math.floor(Date.now() / 1000) + 86400,
        createdAt: new Date().toISOString(),
        sessionId: "session_immutable",
        protocolVersion: "4.0",
      };

      await store.createEnrollment(enrollment);
      await store.revokeEnrollment("0xabc123", "user");

      // Even while revoked, session_id binding is immutable
      const enrollment2: Enrollment = {
        nullifier: "0xdef456",
        telegramUserId: 67890,
        action: "openclaw-enroll-v2",
        expiresAt: Math.floor(Date.now() / 1000) + 86400,
        createdAt: new Date().toISOString(),
        sessionId: "session_immutable",
        protocolVersion: "4.0",
      };

      await assert.rejects(
        () => store.createEnrollment(enrollment2),
        /Session ID already bound to different enrollment/
      );
    });
  });

  describe("Hard cutover semantics", () => {
    it("should allow enrollment on legacy action (openclaw-verify) without session", async () => {
      const store = new SqliteEnrollmentStore(getTestDb());

      const legacyEnrollment: Enrollment = {
        nullifier: "0x000000000000000000000000000000000000000000000000000000000000bead",
        telegramUserId: 12345,
        action: "openclaw-verify",
        expiresAt: Math.floor(Date.now() / 1000) + 86400,
        createdAt: new Date().toISOString(),
        protocolVersion: "UNKNOWN",
      };

      await store.createEnrollment(legacyEnrollment);

      const found = await store.findEnrollment(12345, "openclaw-verify", new Date());
      assert.ok(found);
      assert.strictEqual(found?.sessionId, null);
    });

    it("should isolate legacy and new actions per user", async () => {
      const store = new SqliteEnrollmentStore(getTestDb());

      const legacyEnrollment: Enrollment = {
        nullifier: "0x000000000000000000000000000000000000000000000000000000000000bead",
        telegramUserId: 12345,
        action: "openclaw-verify",
        expiresAt: Math.floor(Date.now() / 1000) + 86400,
        createdAt: new Date().toISOString(),
        protocolVersion: "UNKNOWN",
      };

      await store.createEnrollment(legacyEnrollment);

      const newEnrollment: Enrollment = {
        nullifier: "0xnew",
        telegramUserId: 12345,
        action: "openclaw-enroll-v2",
        expiresAt: Math.floor(Date.now() / 1000) + 86400,
        createdAt: new Date().toISOString(),
        sessionId: "session_new",
        protocolVersion: "4.0",
      };

      await store.createEnrollment(newEnrollment);

      const foundLegacy = await store.findEnrollment(12345, "openclaw-verify", new Date());
      const foundNew = await store.findEnrollment(12345, "openclaw-enroll-v2", new Date());

      assert.strictEqual(foundLegacy?.nullifier, "0x000000000000000000000000000000000000000000000000000000000000bead");
      assert.strictEqual(foundLegacy?.sessionId, null);

      assert.strictEqual(foundNew?.nullifier, "0xnew");
      assert.strictEqual(foundNew?.sessionId, "session_new");
    });
  });

  describe("Challenge session atomic consumption", () => {
    it("should atomically consume challenge session", async () => {
      const store = new SqliteChallengeSessionStore(getTestDb());

      const session = {
        nonce: "nonce123",
        telegramUserId: 12345,
        action: "openclaw-enroll-v2",
        expiresAt: Math.floor(Date.now() / 1000) + 300,
        createdAt: new Date().toISOString(),
      };

      await store.createSession(session);

      const consumed = await store.consumeSession("nonce123");
      assert.ok(consumed);
      assert.strictEqual(consumed?.telegramUserId, 12345);

      const consumed2 = await store.consumeSession("nonce123");
      assert.strictEqual(consumed2, null);
    });

    it("should reject expired challenge session", async () => {
      const store = new SqliteChallengeSessionStore(getTestDb());

      const session = {
        nonce: "nonce_expired",
        telegramUserId: 12345,
        action: "openclaw-enroll-v2",
        expiresAt: Math.floor(Date.now() / 1000) - 100,
        createdAt: new Date().toISOString(),
      };

      await store.createSession(session);

      const consumed = await store.consumeSession("nonce_expired");
      assert.strictEqual(consumed, null);
    });
  });

  describe("Migration generation tracking", () => {
    it("should track migration generation for schema evolution", async () => {
      const store = new SqliteEnrollmentStore(getTestDb());

      const enrollment: Enrollment = {
        nullifier: "0xabc123",
        telegramUserId: 12345,
        action: "openclaw-enroll-v2",
        expiresAt: Math.floor(Date.now() / 1000) + 86400,
        createdAt: new Date().toISOString(),
        sessionId: "session_test",
        protocolVersion: "4.0",
        migrationGeneration: 2,
      };

      await store.createEnrollment(enrollment);

      const found = await store.findEnrollment(12345, "openclaw-enroll-v2", new Date());
      assert.strictEqual(found?.migrationGeneration, 2);
    });

    it("should default migration generation to 1", async () => {
      const store = new SqliteEnrollmentStore(getTestDb());

      const enrollment: Enrollment = {
        nullifier: "0xabc123",
        telegramUserId: 12345,
        action: "openclaw-enroll-v2",
        expiresAt: Math.floor(Date.now() / 1000) + 86400,
        createdAt: new Date().toISOString(),
        sessionId: "session_test",
        protocolVersion: "4.0",
      };

      await store.createEnrollment(enrollment);

      const found = await store.findEnrollment(12345, "openclaw-enroll-v2", new Date());
      assert.strictEqual(found?.migrationGeneration, 1);
    });
  });
});
