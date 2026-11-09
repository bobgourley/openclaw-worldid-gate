/**
 * TEST-ONLY orchestration harness
 * 
 * This is a SYNTHETIC TEST HARNESS demonstrating gate/processor wiring
 * with synthetic fixtures only. This is NOT production orchestration.
 * 
 * These tests prove zero-call guarantee through actual method calls
 * on the same wiring path, not disconnected spies. They do NOT prove:
 * - Production runtime orchestration
 * - Real Telegram transport authentication
 * - Concurrent request handling
 * - Production error recovery
 * 
 * Limitations:
 * - Synthetic fixtures only (not authenticated Telegram updates)
 * - Test-only message processor (not real agent/LLM/tools)
 * - In-memory stores (no durable state, no transaction isolation)
 * - No production OpenClaw integration
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AdmissionGate } from './admission-gate.js';
import { WorldIdVerifierStub } from './verifier-stub.js';
import { InMemoryEnrollmentStore } from './enrollment-store.js';
import { FakeClock } from './clock.js';
import { createTelegramUpdate, createWorldIdProof } from './fixtures.js';
import type { GateConfig, TelegramUpdate } from './types.js';

const TEST_CONFIG: GateConfig = {
  rpId: 'rp_test123',
  action: 'openclaw-gate-test',
  verifyEndpoint: 'https://developer.world.org/api/v4/verify',
  requireProofOfHuman: true,
  enrollmentTtlSeconds: 86400 * 30,
  allowTestMode: true,
};

/**
 * TEST-ONLY message processor that tracks calls
 * 
 * This simulates downstream operations (LLM, history, tools)
 * for testing purposes only. Not a production processor.
 */
export class TestMessageProcessor {
  llmCallCount = 0;
  historyReadCount = 0;
  historyWriteCount = 0;
  toolExecutionCount = 0;

  async process(_update: TelegramUpdate): Promise<void> {
    this.llmCallCount++;
    this.historyReadCount++;
    this.historyWriteCount++;
    this.toolExecutionCount++;
  }

  reset(): void {
    this.llmCallCount = 0;
    this.historyReadCount = 0;
    this.historyWriteCount = 0;
    this.toolExecutionCount = 0;
  }
}

/**
 * TEST-ONLY orchestrator demonstrating gate/processor wiring
 * 
 * This is a SYNTHETIC HARNESS for testing, not production orchestration.
 * It shows that rejected updates never reach the processor on this path.
 * 
 * Production requires:
 * - Authenticated Telegram transport adapter
 * - Real agent processor with LLM, history, tools
 * - Error handling, logging, monitoring
 * - Integration with OpenClaw gateway (mechanism unknown)
 */
export class TestOrchestrator {
  constructor(
    private readonly gate: AdmissionGate,
    private readonly processor: TestMessageProcessor
  ) {}

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    const admissionResult = await this.gate.checkAdmission({
      telegramUpdate: update,
      timestamp: Date.now(),
    });

    if (!admissionResult.allowed) {
      return;
    }

    await this.processor.process(update);
  }
}

describe('TestOrchestrator (synthetic wiring harness)', () => {
  describe('unknown user rejection', () => {
    it('unknown user never reaches processor (zero downstream calls)', async () => {
      const verifier = new WorldIdVerifierStub();
      const store = new InMemoryEnrollmentStore();
      const gate = new AdmissionGate(TEST_CONFIG, verifier, store);
      const processor = new TestMessageProcessor();
      const orchestrator = new TestOrchestrator(gate, processor);

      const update = createTelegramUpdate({ userId: 99999 });
      await orchestrator.handleUpdate(update);

      assert.equal(processor.llmCallCount, 0, 'LLM calls must be zero');
      assert.equal(processor.historyReadCount, 0, 'History reads must be zero');
      assert.equal(processor.historyWriteCount, 0, 'History writes must be zero');
      assert.equal(processor.toolExecutionCount, 0, 'Tool executions must be zero');
    });
  });

  describe('revoked enrollment rejection', () => {
    it('revoked user never reaches processor (zero downstream calls)', async () => {
      const verifier = new WorldIdVerifierStub();
      const store = new InMemoryEnrollmentStore();
      const gate = new AdmissionGate(TEST_CONFIG, verifier, store);
      const processor = new TestMessageProcessor();
      const orchestrator = new TestOrchestrator(gate, processor);

      const userId = 55555;
      const nullifier = '0xrevoked123';
      verifier.addValidNullifier(nullifier);
      const proof = createWorldIdProof({ nullifier, action: TEST_CONFIG.action });
      await gate.enroll(userId, proof);
      await store.revoke(userId);

      const update = createTelegramUpdate({ userId });
      await orchestrator.handleUpdate(update);

      assert.equal(processor.llmCallCount, 0);
      assert.equal(processor.historyReadCount, 0);
      assert.equal(processor.historyWriteCount, 0);
      assert.equal(processor.toolExecutionCount, 0);
    });
  });

  describe('expired enrollment rejection', () => {
    it('expired user never reaches processor (zero downstream calls)', async () => {
      const clock = new FakeClock(1000000);
      const verifier = new WorldIdVerifierStub();
      const store = new InMemoryEnrollmentStore();
      const gate = new AdmissionGate(TEST_CONFIG, verifier, store, clock);
      const processor = new TestMessageProcessor();
      const orchestrator = new TestOrchestrator(gate, processor);

      const userId = 66666;
      const nullifier = '0xexpired123';
      verifier.addValidNullifier(nullifier);
      const proof = createWorldIdProof({ nullifier, action: TEST_CONFIG.action });
      await gate.enroll(userId, proof, 10);

      clock.advance(11);

      const update = createTelegramUpdate({ userId });
      await orchestrator.handleUpdate(update);

      assert.equal(processor.llmCallCount, 0);
      assert.equal(processor.historyReadCount, 0);
      assert.equal(processor.historyWriteCount, 0);
      assert.equal(processor.toolExecutionCount, 0);
    });
  });

  describe('malformed sender rejection', () => {
    it('negative user ID never reaches processor (zero downstream calls)', async () => {
      const verifier = new WorldIdVerifierStub();
      const store = new InMemoryEnrollmentStore();
      const gate = new AdmissionGate(TEST_CONFIG, verifier, store);
      const processor = new TestMessageProcessor();
      const orchestrator = new TestOrchestrator(gate, processor);

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

      await orchestrator.handleUpdate(malformedUpdate);

      assert.equal(processor.llmCallCount, 0);
      assert.equal(processor.historyReadCount, 0);
      assert.equal(processor.historyWriteCount, 0);
      assert.equal(processor.toolExecutionCount, 0);
    });

    it('bot sender never reaches processor (zero downstream calls)', async () => {
      const verifier = new WorldIdVerifierStub();
      const store = new InMemoryEnrollmentStore();
      const gate = new AdmissionGate(TEST_CONFIG, verifier, store);
      const processor = new TestMessageProcessor();
      const orchestrator = new TestOrchestrator(gate, processor);

      const botUpdate = {
        update_id: 1,
        message: {
          message_id: 1,
          from: { id: 12345, is_bot: true, first_name: 'Bot' },
          date: Math.floor(Date.now() / 1000),
          chat: { id: 12345, type: 'private' as const },
          text: 'hello',
        },
      };

      await orchestrator.handleUpdate(botUpdate);

      assert.equal(processor.llmCallCount, 0);
      assert.equal(processor.historyReadCount, 0);
      assert.equal(processor.historyWriteCount, 0);
      assert.equal(processor.toolExecutionCount, 0);
    });
  });

  describe('unsupported update type rejection', () => {
    it('sender_chat never reaches processor (zero downstream calls)', async () => {
      const verifier = new WorldIdVerifierStub();
      const store = new InMemoryEnrollmentStore();
      const gate = new AdmissionGate(TEST_CONFIG, verifier, store);
      const processor = new TestMessageProcessor();
      const orchestrator = new TestOrchestrator(gate, processor);

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

      await orchestrator.handleUpdate(senderChatUpdate);

      assert.equal(processor.llmCallCount, 0);
      assert.equal(processor.historyReadCount, 0);
      assert.equal(processor.historyWriteCount, 0);
      assert.equal(processor.toolExecutionCount, 0);
    });
  });

  describe('store exception handling', () => {
    it('enrollment store error never reaches processor (zero downstream calls)', async () => {
      const verifier = new WorldIdVerifierStub();
      const failingStore = {
        async get(_userId: number) {
          throw new Error('Database connection failed');
        },
        async set(_enrollment: any) {},
        async revoke(_userId: number) {},
      };
      const gate = new AdmissionGate(TEST_CONFIG, verifier, failingStore);
      const processor = new TestMessageProcessor();
      const orchestrator = new TestOrchestrator(gate, processor);

      const update = createTelegramUpdate({ userId: 12345 });

      let threwError = false;
      try {
        await orchestrator.handleUpdate(update);
      } catch (error) {
        threwError = true;
      }

      assert.equal(threwError, true, 'Store error should propagate');
      assert.equal(processor.llmCallCount, 0);
      assert.equal(processor.historyReadCount, 0);
      assert.equal(processor.historyWriteCount, 0);
      assert.equal(processor.toolExecutionCount, 0);
    });
  });

  describe('positive control (admitted user)', () => {
    it('valid enrolled user DOES reach processor', async () => {
      const verifier = new WorldIdVerifierStub();
      const store = new InMemoryEnrollmentStore();
      const gate = new AdmissionGate(TEST_CONFIG, verifier, store);
      const processor = new TestMessageProcessor();
      const orchestrator = new TestOrchestrator(gate, processor);

      const userId = 88888;
      const nullifier = '0xgood123';
      verifier.addValidNullifier(nullifier);
      const proof = createWorldIdProof({ nullifier, action: TEST_CONFIG.action });
      await gate.enroll(userId, proof);

      const update = createTelegramUpdate({ userId });
      await orchestrator.handleUpdate(update);

      assert.equal(processor.llmCallCount, 1, 'LLM should be called once');
      assert.equal(processor.historyReadCount, 1, 'History read should be called once');
      assert.equal(processor.historyWriteCount, 1, 'History write should be called once');
      assert.equal(processor.toolExecutionCount, 1, 'Tool should be executed once');
    });

    it('multiple valid users all reach processor', async () => {
      const verifier = new WorldIdVerifierStub();
      const store = new InMemoryEnrollmentStore();
      const gate = new AdmissionGate(TEST_CONFIG, verifier, store);
      const processor = new TestMessageProcessor();
      const orchestrator = new TestOrchestrator(gate, processor);

      for (let i = 0; i < 3; i++) {
        const userId = 20000 + i;
        const nullifier = `0xvalid${i}`;
        verifier.addValidNullifier(nullifier);
        const proof = createWorldIdProof({ nullifier, action: TEST_CONFIG.action });
        await gate.enroll(userId, proof);
      }

      for (let i = 0; i < 3; i++) {
        const update = createTelegramUpdate({ userId: 20000 + i });
        await orchestrator.handleUpdate(update);
      }

      assert.equal(processor.llmCallCount, 3);
      assert.equal(processor.historyReadCount, 3);
      assert.equal(processor.historyWriteCount, 3);
      assert.equal(processor.toolExecutionCount, 3);
    });
  });

  describe('mixed admitted and rejected', () => {
    it('only admitted users reach processor', async () => {
      const verifier = new WorldIdVerifierStub();
      const store = new InMemoryEnrollmentStore();
      const gate = new AdmissionGate(TEST_CONFIG, verifier, store);
      const processor = new TestMessageProcessor();
      const orchestrator = new TestOrchestrator(gate, processor);

      const enrolledUserId = 77777;
      const nullifier = '0xmixed123';
      verifier.addValidNullifier(nullifier);
      const proof = createWorldIdProof({ nullifier, action: TEST_CONFIG.action });
      await gate.enroll(enrolledUserId, proof);

      await orchestrator.handleUpdate(createTelegramUpdate({ userId: 11111 }));
      await orchestrator.handleUpdate(createTelegramUpdate({ userId: enrolledUserId }));
      await orchestrator.handleUpdate(createTelegramUpdate({ userId: 22222 }));
      await orchestrator.handleUpdate(createTelegramUpdate({ userId: enrolledUserId }));
      await orchestrator.handleUpdate(createTelegramUpdate({ userId: 33333 }));

      assert.equal(processor.llmCallCount, 2, 'Only 2 admitted users should reach LLM');
      assert.equal(processor.historyReadCount, 2);
      assert.equal(processor.historyWriteCount, 2);
      assert.equal(processor.toolExecutionCount, 2);
    });
  });
});
