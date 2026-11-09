import { strict as assert } from "node:assert";
import { describe, it, mock } from "node:test";
import {
  WorldIdVerificationClient,
  type WorldIdClientConfig,
  type WorldIdV4VerifyRequest,
  type WorldIdVerifyResponse,
} from "./worldid-client.js";

describe("WorldIdVerificationClient - Strict validation", () => {
  const config: WorldIdClientConfig = {
    rpId: "rp_test_123",
    environment: "production",
    timeoutMs: 5000,
  };

  it("rejects response with missing nullifier in request", async () => {
    const client = new WorldIdVerificationClient(config);

    const mockResponse: WorldIdVerifyResponse = {
      success: true,
      environment: "production",
    };

    const fetchMock = mock.fn<typeof globalThis.fetch>(async () => {
      return new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const originalFetch = globalThis.fetch;
    try {
      (globalThis as any).fetch = fetchMock;

      const request: WorldIdV4VerifyRequest = {
        protocol_version: "4.0",
        nonce: "0xtest",
        action: "test",
        environment: "production",
        responses: [
          {
            identifier: "proof_of_human",
            issuer_schema_id: 1,
            nullifier: null as any, // Invalid: missing nullifier
            expires_at_min: 1756166400,
            proof: ["0x111"],
            signal_hash: "0x0",
          },
        ],
      };

      const expectedContext = {
        action: "test",
        nonce: "0xtest",
      };

      const result = await client.verify(request, expectedContext);

      assert.ok(!result.success);
      assert.ok(result.error?.includes("nullifier"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects response with missing issuer_schema_id in request", async () => {
    const client = new WorldIdVerificationClient(config);

    const mockResponse: WorldIdVerifyResponse = {
      success: true,
      environment: "production",
    };

    const fetchMock = mock.fn<typeof globalThis.fetch>(async () => {
      return new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const originalFetch = globalThis.fetch;
    try {
      (globalThis as any).fetch = fetchMock;

      const request: WorldIdV4VerifyRequest = {
        protocol_version: "4.0",
        nonce: "0xtest",
        action: "test",
        environment: "production",
        responses: [
          {
            identifier: "proof_of_human",
            issuer_schema_id: null as any, // Invalid: missing schema
            nullifier: "0xvalid",
            expires_at_min: 1756166400,
            proof: ["0x111"],
            signal_hash: "0x0",
          },
        ],
      };

      const expectedContext = {
        action: "test",
        nonce: "0xtest",
      };

      const result = await client.verify(request, expectedContext);

      assert.ok(!result.success);
      assert.ok(result.error?.includes("issuer_schema_id"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects response with invalid JSON", async () => {
    const client = new WorldIdVerificationClient(config);

    const fetchMock = mock.fn<typeof globalThis.fetch>(async () => {
      return new Response("not valid json{", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const originalFetch = globalThis.fetch;
    try {
      (globalThis as any).fetch = fetchMock;

      const request: WorldIdV4VerifyRequest = {
        protocol_version: "4.0",
        nonce: "0xtest",
        action: "test",
        environment: "production",
        responses: [
          {
            identifier: "proof_of_human",
            issuer_schema_id: 1,
            nullifier: "0xtest",
            expires_at_min: 1756166400,
            proof: ["0x111"],
            signal_hash: "0x0",
          },
        ],
      };

      const expectedContext = {
        action: "test",
        nonce: "0xtest",
      };

      const result = await client.verify(request, expectedContext);

      assert.ok(!result.success);
      assert.ok(result.error?.includes("Invalid JSON in verification response"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns credential details from REQUEST after successful verification", async () => {
    const client = new WorldIdVerificationClient(config);

    // Response only has success and environment (per official docs)
    const mockResponse: WorldIdVerifyResponse = {
      success: true,
      environment: "production",
    };

    const fetchMock = mock.fn<typeof globalThis.fetch>(async () => {
      return new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const originalFetch = globalThis.fetch;
    try {
      (globalThis as any).fetch = fetchMock;

      const request: WorldIdV4VerifyRequest = {
        protocol_version: "4.0",
        nonce: "0xabc123",
        action: "test-action",
        environment: "production",
        responses: [
          {
            identifier: "proof_of_human",
            issuer_schema_id: 1,
            nullifier: "0xnullifier_from_request",
            expires_at_min: 1756166400,
            proof: ["0x111", "0x222"],
            signal_hash: "0x0",
          },
        ],
      };

      const expectedContext = {
        action: "test-action",
        nonce: "0xabc123",
      };

      const result = await client.verify(request, expectedContext);

      assert.ok(result.success);
      // Credential details come from REQUEST, not response
      assert.equal(result.nullifier, "0xnullifier_from_request");
      assert.equal(result.expiresAtMin, 1756166400);
      assert.equal(result.issuerSchemaId, 1);
      assert.equal(result.identifier, "proof_of_human");
      assert.equal(result.environment, "production");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
