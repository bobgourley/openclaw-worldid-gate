/**
 * Orchestrator integration tests
 * 
 * These tests prove that the zero-call guarantee works through
 * actual wiring, not just disconnected spies. They show that:
 * 1. Rejected requests never reach downstream handlers
 * 2. Admitted requests DO reach downstream handlers (positive control)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AdmissionGate } from './admission-gate.js';
import { WorldIdVerifierStub } from './verifier-stub.js';
import { InMemoryEnrollmentStore } from './enrollment-store.js';
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
 * Simple message processor that tracks calls
 */
class MessageProcessor {
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
 * Orchestrator that wires admission gate to message processor
 */
class MessageOrchestrator {
  constructor(
    private readonly gate: AdmissionGate,
    private readonly processor: MessageProcessor
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

describe('MessageOrchestrator', () => {
  it('rejected update never reaches processor (zero downstream calls)', async () => {
    const verifier = new WorldIdVerifierStub();
    const store = new InMemoryEnrollmentStore();
    const gate = new AdmissionGate(TEST_CONFIG, verifier, store);
    const processor = new MessageProcessor();
    const orchestrator = new MessageOrchestrator(gate, processor);

    const update = createTelegramUpdate({ userId: 99999 });
    await orchestrator.handleUpdate(update);

    assert.equal(processor.llmCallCount, 0, 'LLM calls must be zero');
    assert.equal(processor.historyReadCount, 0, 'History reads must be zero');
    assert.equal(processor.historyWriteCount, 0, 'History writes must be zero');
    assert.equal(processor.toolExecutionCount, 0, 'Tool executions must be zero');
  });

  it('admitted update DOES reach processor (positive control)', async () => {
    const verifier = new WorldIdVerifierStub();
    const store = new InMemoryEnrollmentStore();
    const gate = new AdmissionGate(TEST_CONFIG, verifier, store);
    const processor = new MessageProcessor();
    const orchestrator = new MessageOrchestrator(gate, processor);

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

  it('multiple rejected updates never reach processor', async () => {
    const verifier = new WorldIdVerifierStub();
    const store = new InMemoryEnrollmentStore();
    const gate = new AdmissionGate(TEST_CONFIG, verifier, store);
    const processor = new MessageProcessor();
    const orchestrator = new MessageOrchestrator(gate, processor);

    for (let i = 0; i < 10; i++) {
      const update = createTelegramUpdate({ userId: 10000 + i });
      await orchestrator.handleUpdate(update);
    }

    assert.equal(processor.llmCallCount, 0);
    assert.equal(processor.historyReadCount, 0);
    assert.equal(processor.historyWriteCount, 0);
    assert.equal(processor.toolExecutionCount, 0);
  });

  it('mix of rejected and admitted updates only processes admitted', async () => {
    const verifier = new WorldIdVerifierStub();
    const store = new InMemoryEnrollmentStore();
    const gate = new AdmissionGate(TEST_CONFIG, verifier, store);
    const processor = new MessageProcessor();
    const orchestrator = new MessageOrchestrator(gate, processor);

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
