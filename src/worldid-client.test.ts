import { strict as assert } from "node:assert";
import { describe, it, mock } from "node:test";
import {
  WorldIdVerificationClient,
  type WorldIdClientConfig,
  type WorldIdV4VerifyRequest,
  type WorldIdVerifyResponse,
} from "./worldid-client.js";

describe("WorldIdVerificationClient", () => {
  const productionConfig: WorldIdClientConfig = {
    rpId: "rp_test_prod_123",
    environment: "production",
    timeoutMs: 5000,
  };

  const stagingConfig: WorldIdClientConfig = {
    rpId: "rp_test_staging_456",
    environment: "staging",
    timeoutMs: 5000,
  };

  it("rejects invalid rpId (missing rp_ prefix)", () => {
    assert.throws(
      () => new WorldIdVerificationClient({ ...productionConfig, rpId: "invalid_123" }),
      /Invalid rpId: must start with 'rp_'/,
    );
  });

  it("rejects invalid environment", () => {
    assert.throws(
      () => new WorldIdVerificationClient({ ...productionConfig, environment: "invalid" as any }),
      /Invalid environment: must be 'production' or 'staging'/,
    );
  });

  it("constructs production client with valid config", () => {
    const client = new WorldIdVerificationClient(productionConfig);
    assert.ok(client);
  });

  it("constructs staging client with valid config", () => {
    const client = new WorldIdVerificationClient(stagingConfig);
    assert.ok(client);
  });

  describe("verify", () => {
    it("rejects request with environment mismatch", async () => {
      const client = new WorldIdVerificationClient(productionConfig);

      const request: WorldIdV4VerifyRequest = {
        protocol_version: "4.0",
        nonce: "0xabc123",
        action: "test-action",
        environment: "staging",
        responses: [
          {
            identifier: "proof_of_human",
            issuer_schema_id: 1,
            nullifier: "0x123abc",
            expires_at_min: 1756166400,
            proof: ["0x111", "0x222", "0x333", "0x444", "0x555"],
            signal_hash: "0x0",
          },
        ],
      };

      const result = await client.verify(request);

      assert.ok(!result.success);
      assert.ok(result.error?.includes("Environment mismatch"));
    });

    it("rejects request with unsupported protocol_version", async () => {
      const client = new WorldIdVerificationClient(productionConfig);

      const request: WorldIdV4VerifyRequest = {
        protocol_version: "3.0" as any,
        nonce: "0xabc123",
        action: "test-action",
        environment: "production",
        responses: [],
      };

      const result = await client.verify(request);

      assert.ok(!result.success);
      assert.ok(result.error?.includes("Unsupported protocol_version"));
    });

    it("rejects request with no responses", async () => {
      const client = new WorldIdVerificationClient(productionConfig);

      const request: WorldIdV4VerifyRequest = {
        protocol_version: "4.0",
        nonce: "0xabc123",
        action: "test-action",
        environment: "production",
        responses: [],
      };

      const result = await client.verify(request);

      assert.ok(!result.success);
      assert.equal(result.error, "No responses in proof request");
    });

    it("calls production endpoint for production environment", async () => {
      const client = new WorldIdVerificationClient(productionConfig);

      const mockResponse: WorldIdVerifyResponse = {
        success: true,
        environment: "production",
        results: [
          {
            identifier: "proof_of_human",
            valid: true,
            issuer_schema_id: 1,
          },
        ],
      };

      const fetchMock = mock.fn<typeof globalThis.fetch>(async (input, init) => {
        assert.equal(
          input,
          `https://developer.world.org/api/v4/verify/${productionConfig.rpId}`,
        );
        assert.equal(init?.method, "POST");
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
              nullifier: "0x123abc",
              expires_at_min: 1756166400,
              proof: ["0x111", "0x222", "0x333", "0x444", "0x555"],
              signal_hash: "0x0",
            },
          ],
        };

        const result = await client.verify(request);

        assert.ok(result.success);
        assert.equal(result.nullifier, "0x123abc");
        assert.equal(result.expiresAtMin, 1756166400);
        assert.equal(result.issuerSchemaId, 1);
        assert.equal(result.environment, "production");
        assert.equal(fetchMock.mock.callCount(), 1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("calls staging endpoint for staging environment", async () => {
      const client = new WorldIdVerificationClient(stagingConfig);

      const mockResponse: WorldIdVerifyResponse = {
        success: true,
        environment: "staging",
        results: [
          {
            identifier: "proof_of_human",
            valid: true,
            issuer_schema_id: 1,
          },
        ],
      };

      const fetchMock = mock.fn<typeof globalThis.fetch>(async (input, init) => {
        assert.equal(
          input,
          `https://staging-developer.worldcoin.org/api/v4/verify/${stagingConfig.rpId}`,
        );
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
          nonce: "0xstaging",
          action: "staging-test",
          environment: "staging",
          responses: [
            {
              identifier: "proof_of_human",
              issuer_schema_id: 1,
              nullifier: "0xstaging",
              expires_at_min: 1756166400,
              proof: ["0x111", "0x222", "0x333", "0x444", "0x555"],
              signal_hash: "0x0",
            },
          ],
        };

        const result = await client.verify(request);

        assert.ok(result.success);
        assert.equal(fetchMock.mock.callCount(), 1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("handles Developer Portal API error response", async () => {
      const client = new WorldIdVerificationClient(productionConfig);

      const fetchMock = mock.fn<typeof globalThis.fetch>(async () => {
        return new Response("Invalid proof format", {
          status: 400,
          statusText: "Bad Request",
        });
      });

      const originalFetch = globalThis.fetch;
      try {
        (globalThis as any).fetch = fetchMock;

        const request: WorldIdV4VerifyRequest = {
          protocol_version: "4.0",
          nonce: "0xbad",
          action: "test",
          environment: "production",
          responses: [
            {
              identifier: "proof_of_human",
              issuer_schema_id: 1,
              nullifier: "0xbad",
              expires_at_min: 1756166400,
              proof: ["0x111"],
              signal_hash: "0x0",
            },
          ],
        };

        const result = await client.verify(request);

        assert.ok(!result.success);
        assert.ok(result.error?.includes("Developer Portal returned 400"));
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("handles network timeout", async () => {
      const client = new WorldIdVerificationClient({ ...productionConfig, timeoutMs: 100 });

      const fetchMock = mock.fn<typeof globalThis.fetch>(async (input, init) => {
        // Simulate a real fetch that respects abort signal
        return new Promise((resolve, reject) => {
          const timeoutId = setTimeout(() => {
            resolve(new Response("{}"));
          }, 200);

          init?.signal?.addEventListener("abort", () => {
            clearTimeout(timeoutId);
            reject(new DOMException("The operation was aborted", "AbortError"));
          });
        });
      });

      const originalFetch = globalThis.fetch;
      try {
        (globalThis as any).fetch = fetchMock;

        const request: WorldIdV4VerifyRequest = {
          protocol_version: "4.0",
          nonce: "0xtimeout",
          action: "test",
          environment: "production",
          responses: [
            {
              identifier: "proof_of_human",
              issuer_schema_id: 1,
              nullifier: "0xtimeout",
              expires_at_min: 1756166400,
              proof: ["0x111"],
              signal_hash: "0x0",
            },
          ],
        };

        const result = await client.verify(request);

        assert.ok(!result.success);
        assert.ok(result.error?.includes("timeout"));
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("rejects verification response with environment mismatch", async () => {
      const client = new WorldIdVerificationClient(productionConfig);

      const mockResponse: WorldIdVerifyResponse = {
        success: true,
        environment: "staging",
        results: [],
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
          nonce: "0xmismatch",
          action: "test",
          environment: "production",
          responses: [
            {
              identifier: "proof_of_human",
              issuer_schema_id: 1,
              nullifier: "0xmismatch",
              expires_at_min: 1756166400,
              proof: ["0x111"],
              signal_hash: "0x0",
            },
          ],
        };

        const result = await client.verify(request);

        assert.ok(!result.success);
        assert.ok(result.error?.includes("Response environment mismatch"));
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
