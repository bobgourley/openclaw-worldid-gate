/**
 * Admission gate tests
 * 
 * These tests prove that rejected senders cause:
 * - ZERO LLM calls
 * - ZERO conversation history reads/writes
 * - ZERO tool executions
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AdmissionGate } from './admission-gate.js';
import { WorldIdVerifierStub } from './verifier-stub.js';
import { InMemoryEnrollmentStore } from './enrollment-store.js';
import { FakeClock } from './clock.js';
import {
  createTelegramUpdate,
  createBotUpdate,
  createChannelPostUpdate,
  createWorldIdProof,
  createInvalidWorldIdProof,
  createExpiredWorldIdProof,
} from './fixtures.js';
import type { GateConfig, TelegramUpdate } from './types.js';

const TEST_CONFIG: GateConfig = {
  rpId: 'rp_test123',
  action: 'openclaw-gate-test',
  verifyEndpoint: 'https://developer.world.org/api/v4/verify',
  requireProofOfHuman: true,
  enrollmentTtlSeconds: 86400 * 30,
  allowTestMode: true,
};

function createGate(clock?: FakeClock): {
  gate: AdmissionGate;
  verifier: WorldIdVerifierStub;
  store: InMemoryEnrollmentStore;
  clock?: FakeClock;
} {
  const verifier = new WorldIdVerifierStub();
  const store = new InMemoryEnrollmentStore();
  const gate = new AdmissionGate(TEST_CONFIG, verifier, store, clock);
  return { gate, verifier, store, clock };
}

describe('AdmissionGate', () => {
  describe('fail-closed admission', () => {
    it('rejects unknown user with ZERO downstream calls', async () => {
      const { gate } = createGate();
      const update = createTelegramUpdate({ userId: 12345 });

      const result = await gate.checkAdmission({
        telegramUpdate: update,
        timestamp: Date.now(),
      });

      assert.equal(result.allowed, false);
      assert.equal(result.reason, 'No enrollment found for Telegram user ID');
      assert.equal(result.telegramUserId, 12345);

      const metrics = gate.getMetrics();
      assert.equal(metrics.llmCallCount, 0, 'LLM calls must be zero');
      assert.equal(metrics.historyReadCount, 0, 'History reads must be zero');
      assert.equal(metrics.historyWriteCount, 0, 'History writes must be zero');
      assert.equal(metrics.toolExecutionCount, 0, 'Tool executions must be zero');
    });

    it('rejects bot messages with ZERO downstream calls', async () => {
      const { gate } = createGate();
      const update = createBotUpdate(99999);

      const result = await gate.checkAdmission({
        telegramUpdate: update,
        timestamp: Date.now(),
      });

      assert.equal(result.allowed, false);
      assert.equal(result.reason, 'No authenticated Telegram user ID in update');

      const metrics = gate.getMetrics();
      assert.equal(metrics.llmCallCount, 0);
      assert.equal(metrics.historyReadCount, 0);
      assert.equal(metrics.historyWriteCount, 0);
      assert.equal(metrics.toolExecutionCount, 0);
    });

    it('rejects channel posts with ZERO downstream calls', async () => {
      const { gate } = createGate();
      const update = createChannelPostUpdate(88888, 'Channel message');

      const result = await gate.checkAdmission({
        telegramUpdate: update,
        timestamp: Date.now(),
      });

      assert.equal(result.allowed, false);
      assert.equal(result.reason, 'No authenticated Telegram user ID in update');

      const metrics = gate.getMetrics();
      assert.equal(metrics.llmCallCount, 0);
      assert.equal(metrics.historyReadCount, 0);
      assert.equal(metrics.historyWriteCount, 0);
      assert.equal(metrics.toolExecutionCount, 0);
    });

    it('ignores forwarded message author, uses sender', async () => {
      const { gate } = createGate();
      const update = createTelegramUpdate({
        userId: 11111,
        forwardedFrom: 22222,
      });

      const result = await gate.checkAdmission({
        telegramUpdate: update,
        timestamp: Date.now(),
      });

      assert.equal(result.allowed, false);
      assert.equal(result.telegramUserId, 11111);

      const metrics = gate.getMetrics();
      assert.equal(metrics.llmCallCount, 0);
      assert.equal(metrics.historyReadCount, 0);
      assert.equal(metrics.historyWriteCount, 0);
      assert.equal(metrics.toolExecutionCount, 0);
    });
  });

  describe('enrollment validation', () => {
    it('rejects revoked enrollment with ZERO downstream calls', async () => {
      const { gate, verifier, store } = createGate();
      const userId = 33333;
      const nullifier = '0xvalid123';

      verifier.addValidNullifier(nullifier);
      const proof = createWorldIdProof({ nullifier, action: TEST_CONFIG.action });
      await gate.enroll(userId, proof);
      await store.revoke(userId);

      const update = createTelegramUpdate({ userId });
      const result = await gate.checkAdmission({
        telegramUpdate: update,
        timestamp: Date.now(),
      });

      assert.equal(result.allowed, false);
      assert.equal(result.reason, 'Enrollment has been revoked');

      const metrics = gate.getMetrics();
      assert.equal(metrics.llmCallCount, 0);
      assert.equal(metrics.historyReadCount, 0);
      assert.equal(metrics.historyWriteCount, 0);
      assert.equal(metrics.toolExecutionCount, 0);
    });

    it('rejects expired enrollment with ZERO downstream calls', async () => {
      const clock = new FakeClock(1000000);
      const { gate, verifier } = createGate(clock);
      const userId = 44444;
      const nullifier = '0xvalid456';

      verifier.addValidNullifier(nullifier);
      const proof = createWorldIdProof({ nullifier, action: TEST_CONFIG.action });
      await gate.enroll(userId, proof, 10);

      clock.advance(11);

      const update = createTelegramUpdate({ userId });
      const result = await gate.checkAdmission({
        telegramUpdate: update,
        timestamp: Date.now(),
      });

      assert.equal(result.allowed, false);
      assert.equal(result.reason, 'Enrollment has expired');

      const metrics = gate.getMetrics();
      assert.equal(metrics.llmCallCount, 0);
      assert.equal(metrics.historyReadCount, 0);
      assert.equal(metrics.historyWriteCount, 0);
      assert.equal(metrics.toolExecutionCount, 0);
    });

    it('rejects action mismatch with ZERO downstream calls', async () => {
      const { gate, verifier } = createGate();
      const userId = 55555;
      const nullifier = '0xvalid789';

      verifier.addValidNullifier(nullifier);
      const proof = createWorldIdProof({ nullifier, action: 'different-action' });
      await gate.enroll(userId, proof);

      const update = createTelegramUpdate({ userId });
      const result = await gate.checkAdmission({
        telegramUpdate: update,
        timestamp: Date.now(),
      });

      assert.equal(result.allowed, false);
      assert.equal(result.reason, 'Enrollment action mismatch');

      const metrics = gate.getMetrics();
      assert.equal(metrics.llmCallCount, 0);
      assert.equal(metrics.historyReadCount, 0);
      assert.equal(metrics.historyWriteCount, 0);
      assert.equal(metrics.toolExecutionCount, 0);
    });
  });

  describe('World ID verification', () => {
    it('rejects malformed proof with ZERO downstream calls', async () => {
      const { gate } = createGate();
      const userId = 66666;
      const proof = createInvalidWorldIdProof();

      const enrollResult = await gate.enroll(userId, proof);

      assert.equal(enrollResult.success, false);
      assert.match(enrollResult.error ?? '', /verification failed/i);

      const update = createTelegramUpdate({ userId });
      const admitResult = await gate.checkAdmission({
        telegramUpdate: update,
        timestamp: Date.now(),
      });

      assert.equal(admitResult.allowed, false);

      const metrics = gate.getMetrics();
      assert.equal(metrics.llmCallCount, 0);
      assert.equal(metrics.historyReadCount, 0);
      assert.equal(metrics.historyWriteCount, 0);
      assert.equal(metrics.toolExecutionCount, 0);
    });

    it('rejects expired proof with ZERO downstream calls', async () => {
      const { gate, verifier } = createGate();
      const userId = 77777;
      const proof = createExpiredWorldIdProof(TEST_CONFIG.action);

      verifier.addValidNullifier(proof.responses[0].nullifier);

      const enrollResult = await gate.enroll(userId, proof);

      assert.equal(enrollResult.success, false);
      assert.match(enrollResult.error ?? '', /(expired|verification failed)/i);

      const metrics = gate.getMetrics();
      assert.equal(metrics.llmCallCount, 0);
      assert.equal(metrics.historyReadCount, 0);
      assert.equal(metrics.historyWriteCount, 0);
      assert.equal(metrics.toolExecutionCount, 0);
    });

    it('rejects verification service outage with ZERO downstream calls', async () => {
      const { gate, verifier } = createGate();
      const userId = 88888;
      const nullifier = '0xoutage123';

      verifier.setSimulateOutage(true);
      const proof = createWorldIdProof({ nullifier, action: TEST_CONFIG.action });

      const enrollResult = await gate.enroll(userId, proof);

      assert.equal(enrollResult.success, false);
      assert.match(enrollResult.error ?? '', /verification service error/i);

      const metrics = gate.getMetrics();
      assert.equal(metrics.llmCallCount, 0);
      assert.equal(metrics.historyReadCount, 0);
      assert.equal(metrics.historyWriteCount, 0);
      assert.equal(metrics.toolExecutionCount, 0);
    });
  });

  describe('successful admission', () => {
    it('admits valid enrolled user and allows downstream calls', async () => {
      const { gate, verifier } = createGate();
      const userId = 99999;
      const nullifier = '0xgood123';

      verifier.addValidNullifier(nullifier);
      const proof = createWorldIdProof({ nullifier, action: TEST_CONFIG.action });
      const enrollResult = await gate.enroll(userId, proof);

      assert.equal(enrollResult.success, true);
      assert.ok(enrollResult.enrollment);

      const update = createTelegramUpdate({ userId });
      const admitResult = await gate.checkAdmission({
        telegramUpdate: update,
        timestamp: Date.now(),
      });

      assert.equal(admitResult.allowed, true);
      assert.equal(admitResult.reason, 'Valid enrollment');
      assert.equal(admitResult.telegramUserId, userId);

      let metrics = gate.getMetrics();
      assert.equal(metrics.llmCallCount, 0);
      assert.equal(metrics.historyReadCount, 0);
      assert.equal(metrics.historyWriteCount, 0);
      assert.equal(metrics.toolExecutionCount, 0);

      gate.simulateLlmCall();
      gate.simulateHistoryRead();
      gate.simulateHistoryWrite();
      gate.simulateToolExecution();

      metrics = gate.getMetrics();
      assert.equal(metrics.llmCallCount, 1);
      assert.equal(metrics.historyReadCount, 1);
      assert.equal(metrics.historyWriteCount, 1);
      assert.equal(metrics.toolExecutionCount, 1);
    });
  });

  describe('duplicate enrollment prevention', () => {
    it('rejects duplicate enrollment attempt', async () => {
      const { gate, verifier } = createGate();
      const userId = 10101;
      const nullifier1 = '0xfirst123';
      const nullifier2 = '0xsecond456';

      verifier.addValidNullifier(nullifier1);
      verifier.addValidNullifier(nullifier2);

      const proof1 = createWorldIdProof({ nullifier: nullifier1, action: TEST_CONFIG.action });
      const enrollResult1 = await gate.enroll(userId, proof1);
      assert.equal(enrollResult1.success, true);

      const proof2 = createWorldIdProof({ nullifier: nullifier2, action: TEST_CONFIG.action });
      const enrollResult2 = await gate.enroll(userId, proof2);
      assert.equal(enrollResult2.success, false);
      assert.match(enrollResult2.error ?? '', /already enrolled/i);
    });
  });

  describe('malformed inputs and trust boundary', () => {
    it('rejects malformed admission request (null)', async () => {
      const { gate } = createGate();
      const result = await gate.checkAdmission(null as any);
      assert.equal(result.allowed, false);
      assert.match(result.reason, /malformed/i);
    });

    it('rejects malformed admission request (missing update)', async () => {
      const { gate } = createGate();
      const result = await gate.checkAdmission({ timestamp: Date.now() } as any);
      assert.equal(result.allowed, false);
      assert.match(result.reason, /malformed/i);
    });

    it('rejects negative user ID', async () => {
      const { gate } = createGate();
      const malformedUpdate = {
        update_id: 1,
        message: {
          message_id: 1,
          from: { id: -12345, is_bot: false, first_name: 'Test' },
          date: Math.floor(Date.now() / 1000),
          chat: { id: -12345, type: 'private' as const },
          text: 'hello',
        },
      };
      const result = await gate.checkAdmission({
        telegramUpdate: malformedUpdate,
        timestamp: Date.now(),
      });
      assert.equal(result.allowed, false);
      assert.match(result.reason, /invalid.*positive/i);
    });

    it('rejects zero user ID', async () => {
      const { gate } = createGate();
      const malformedUpdate = {
        update_id: 1,
        message: {
          message_id: 1,
          from: { id: 0, is_bot: false, first_name: 'Test' },
          date: Math.floor(Date.now() / 1000),
          chat: { id: 0, type: 'private' as const },
          text: 'hello',
        },
      };
      const result = await gate.checkAdmission({
        telegramUpdate: malformedUpdate,
        timestamp: Date.now(),
      });
      assert.equal(result.allowed, false);
      assert.match(result.reason, /invalid.*positive/i);
    });

    it('rejects enrollment with negative user ID', async () => {
      const { gate, verifier } = createGate();
      const nullifier = '0xnegative123';
      verifier.addValidNullifier(nullifier);
      const proof = createWorldIdProof({ nullifier, action: TEST_CONFIG.action });
      const result = await gate.enroll(-12345, proof);
      assert.equal(result.success, false);
      assert.match(result.error ?? '', /invalid.*positive/i);
    });

    it('rejects enrollment with zero user ID', async () => {
      const { gate, verifier } = createGate();
      const nullifier = '0xzero123';
      verifier.addValidNullifier(nullifier);
      const proof = createWorldIdProof({ nullifier, action: TEST_CONFIG.action });
      const result = await gate.enroll(0, proof);
      assert.equal(result.success, false);
      assert.match(result.error ?? '', /invalid.*positive/i);
    });

    it('rejects edited message update type', async () => {
      const { gate } = createGate();
      const editedUpdate: TelegramUpdate = {
        update_id: 1,
        edited_message: {
          message_id: 1,
          from: { id: 12345, is_bot: false, first_name: 'Test' },
          date: Math.floor(Date.now() / 1000),
          chat: { id: 12345, type: 'private' },
          text: 'edited',
        },
      };
      const result = await gate.checkAdmission({
        telegramUpdate: editedUpdate,
        timestamp: Date.now(),
      });
      assert.equal(result.allowed, false);
      assert.equal(result.reason, 'No enrollment found for Telegram user ID');
    });

    it('rejects sender_chat (anonymous channel admin)', async () => {
      const { gate } = createGate();
      const senderChatUpdate: TelegramUpdate = {
        update_id: 1,
        message: {
          message_id: 1,
          sender_chat: { id: -100123, type: 'channel', title: 'Channel' },
          date: Math.floor(Date.now() / 1000),
          chat: { id: -100123, type: 'channel', title: 'Channel' },
          text: 'anonymous',
        },
      };
      const result = await gate.checkAdmission({
        telegramUpdate: senderChatUpdate,
        timestamp: Date.now(),
      });
      assert.equal(result.allowed, false);
      assert.match(result.reason, /no authenticated.*user id/i);
    });
  });
});
