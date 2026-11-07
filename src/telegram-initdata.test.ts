import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { validateTelegramInitData, type TelegramInitDataConfig } from "./telegram-initdata.js";

describe("validateTelegramInitData", () => {
  const botToken = "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11";
  const config: TelegramInitDataConfig = { botToken, maxAgeSeconds: 3600 };

  function createValidInitData(authDate: number, userId: number): string {
    const userData = JSON.stringify({
      id: userId,
      first_name: "Test",
      last_name: "User",
      username: "testuser",
      language_code: "en",
    });

    const params = new URLSearchParams({
      auth_date: String(authDate),
      query_id: "test-query-id",
      user: userData,
    });

    // Compute hash per official algorithm
    const dataCheckPairs: string[] = [];
    for (const [key, value] of params.entries()) {
      dataCheckPairs.push(`${key}=${value}`);
    }
    dataCheckPairs.sort();
    const dataCheckString = dataCheckPairs.join("\n");

    const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
    const hash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

    params.set("hash", hash);
    return params.toString();
  }

  it("accepts valid initData within freshness window", () => {
    const now = Math.floor(Date.now() / 1000);
    const initData = createValidInitData(now - 60, 123456789);

    const result = validateTelegramInitData(initData, config);

    assert.ok(result.valid, `Expected valid, got error: ${result.error}`);
    assert.equal(result.user?.id, 123456789);
    assert.equal(result.user?.firstName, "Test");
    assert.equal(result.user?.lastName, "User");
    assert.equal(result.user?.username, "testuser");
    assert.equal(result.user?.languageCode, "en");
    assert.ok(result.authDate instanceof Date);
  });

  it("rejects initData with missing hash", () => {
    const initData = "auth_date=1234567890&user=%7B%22id%22%3A123%7D";
    const result = validateTelegramInitData(initData, config);

    assert.ok(!result.valid);
    assert.equal(result.error, "Missing hash parameter");
  });

  it("rejects initData with missing auth_date", () => {
    const initData = "hash=abc123&user=%7B%22id%22%3A123%7D";
    const result = validateTelegramInitData(initData, config);

    assert.ok(!result.valid);
    assert.equal(result.error, "Missing auth_date parameter");
  });

  it("rejects initData with invalid HMAC signature", () => {
    const now = Math.floor(Date.now() / 1000);
    const initData = createValidInitData(now - 60, 123456789);
    const tampered = initData.replace(/hash=[^&]+/, "hash=0000000000000000000000000000000000000000000000000000000000000000");

    const result = validateTelegramInitData(tampered, config);

    assert.ok(!result.valid);
    assert.equal(result.error, "HMAC signature mismatch");
  });

  it("rejects expired initData (older than maxAgeSeconds)", () => {
    const now = Math.floor(Date.now() / 1000);
    const expired = now - 3601; // 1 second beyond 1 hour
    const initData = createValidInitData(expired, 123456789);

    const result = validateTelegramInitData(initData, config);

    assert.ok(!result.valid);
    assert.ok(result.error?.includes("initData expired"));
  });

  it("rejects initData with future auth_date", () => {
    const now = Math.floor(Date.now() / 1000);
    const future = now + 60;
    const initData = createValidInitData(future, 123456789);

    const result = validateTelegramInitData(initData, config);

    assert.ok(!result.valid);
    assert.equal(result.error, "auth_date is in the future");
  });

  it("rejects initData with missing user parameter", () => {
    const now = Math.floor(Date.now() / 1000);
    const params = new URLSearchParams({
      auth_date: String(now - 60),
      query_id: "test-query-id",
    });

    const dataCheckPairs: string[] = [];
    for (const [key, value] of params.entries()) {
      dataCheckPairs.push(`${key}=${value}`);
    }
    dataCheckPairs.sort();
    const dataCheckString = dataCheckPairs.join("\n");

    const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
    const hash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
    params.set("hash", hash);

    const result = validateTelegramInitData(params.toString(), config);

    assert.ok(!result.valid);
    assert.equal(result.error, "Missing user parameter");
  });

  it("rejects initData with invalid user JSON", () => {
    const now = Math.floor(Date.now() / 1000);
    const params = new URLSearchParams({
      auth_date: String(now - 60),
      user: "{invalid-json",
    });

    const dataCheckPairs: string[] = [];
    for (const [key, value] of params.entries()) {
      dataCheckPairs.push(`${key}=${value}`);
    }
    dataCheckPairs.sort();
    const dataCheckString = dataCheckPairs.join("\n");

    const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
    const hash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
    params.set("hash", hash);

    const result = validateTelegramInitData(params.toString(), config);

    assert.ok(!result.valid);
    assert.equal(result.error, "Invalid user JSON");
  });

  it("rejects user data missing id field", () => {
    const now = Math.floor(Date.now() / 1000);
    const userData = JSON.stringify({
      first_name: "Test",
    });

    const params = new URLSearchParams({
      auth_date: String(now - 60),
      user: userData,
    });

    const dataCheckPairs: string[] = [];
    for (const [key, value] of params.entries()) {
      dataCheckPairs.push(`${key}=${value}`);
    }
    dataCheckPairs.sort();
    const dataCheckString = dataCheckPairs.join("\n");

    const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
    const hash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
    params.set("hash", hash);

    const result = validateTelegramInitData(params.toString(), config);

    assert.ok(!result.valid);
    assert.equal(result.error, "Missing or invalid user.id");
  });

  it("accepts user data with minimal required fields", () => {
    const now = Math.floor(Date.now() / 1000);
    const userData = JSON.stringify({
      id: 987654321,
      first_name: "Minimal",
    });

    const params = new URLSearchParams({
      auth_date: String(now - 60),
      user: userData,
    });

    const dataCheckPairs: string[] = [];
    for (const [key, value] of params.entries()) {
      dataCheckPairs.push(`${key}=${value}`);
    }
    dataCheckPairs.sort();
    const dataCheckString = dataCheckPairs.join("\n");

    const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
    const hash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
    params.set("hash", hash);

    const result = validateTelegramInitData(params.toString(), config);

    assert.ok(result.valid);
    assert.equal(result.user?.id, 987654321);
    assert.equal(result.user?.firstName, "Minimal");
    assert.equal(result.user?.lastName, undefined);
    assert.equal(result.user?.username, undefined);
  });

  it("uses custom maxAgeSeconds when provided", () => {
    const now = Math.floor(Date.now() / 1000);
    const age = 1800; // 30 minutes
    const initData = createValidInitData(now - age, 123456789);

    // Should reject with 1 hour default
    const resultDefault = validateTelegramInitData(initData, config);
    assert.ok(resultDefault.valid);

    // Should reject with 15 minute custom max age
    const resultCustom = validateTelegramInitData(initData, { ...config, maxAgeSeconds: 900 });
    assert.ok(!resultCustom.valid);
    assert.ok(resultCustom.error?.includes("initData expired"));
  });
});
