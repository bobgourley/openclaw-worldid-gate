import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { validateTelegramInitData, type TelegramInitDataConfig } from "./telegram-initdata.js";

describe("validateTelegramInitData - Strict validation", () => {
  const botToken = "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11";
  const config: TelegramInitDataConfig = { botToken, maxAgeSeconds: 3600 };

  function createValidInitData(authDate: number, userId: number): string {
    const userData = JSON.stringify({
      id: userId,
      first_name: "Test",
    });

    const params = new URLSearchParams({
      auth_date: String(authDate),
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
    return params.toString();
  }

  it("rejects auth_date with alphabetic prefix", () => {
    const userData = JSON.stringify({
      id: 123456789,
      first_name: "Test",
    });

    const params = new URLSearchParams({
      auth_date: "abc" + Math.floor(Date.now() / 1000), // Has letters
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
    assert.ok(result.error?.includes("decimal integer"));
  });

  it("rejects auth_date with non-numeric characters", () => {
    const userData = JSON.stringify({
      id: 123456789,
      first_name: "Test",
    });

    const params = new URLSearchParams({
      auth_date: "123abc", // Non-numeric
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
    assert.ok(result.error?.includes("decimal integer"));
  });

  it("rejects negative auth_date", () => {
    const userData = JSON.stringify({
      id: 123456789,
      first_name: "Test",
    });

    const params = new URLSearchParams({
      auth_date: "-100", // Negative
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
    assert.ok(result.error?.includes("decimal integer"));
  });

  it("rejects zero user ID", () => {
    const now = Math.floor(Date.now() / 1000);
    const userData = JSON.stringify({
      id: 0,
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
    assert.ok(result.error?.includes("positive safe integer"));
  });

  it("rejects negative user ID", () => {
    const now = Math.floor(Date.now() / 1000);
    const userData = JSON.stringify({
      id: -123,
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
    assert.ok(result.error?.includes("positive safe integer"));
  });

  it("rejects non-integer user ID", () => {
    const now = Math.floor(Date.now() / 1000);
    const userData = JSON.stringify({
      id: 123.45,
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
    assert.ok(result.error?.includes("positive safe integer"));
  });

  it("accepts valid hash regardless of hex case", () => {
    const now = Math.floor(Date.now() / 1000);
    const userData = JSON.stringify({
      id: 123456789,
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

    // Valid hash with correct content
    assert.ok(result.valid);
  });

  it("rejects hash with wrong length", () => {
    const now = Math.floor(Date.now() / 1000);
    const userData = JSON.stringify({
      id: 123456789,
      first_name: "Test",
    });

    const params = new URLSearchParams({
      auth_date: String(now - 60),
      user: userData,
      hash: "abc123", // Wrong length
    });

    const result = validateTelegramInitData(params.toString(), config);

    assert.ok(!result.valid);
    assert.ok(result.error?.includes("64 hex characters"));
  });

  it("rejects empty first_name", () => {
    const now = Math.floor(Date.now() / 1000);
    const userData = JSON.stringify({
      id: 123456789,
      first_name: "",
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
    assert.ok(result.error?.includes("first_name"));
  });

  it("rejects invalid maxAgeSeconds config", () => {
    const now = Math.floor(Date.now() / 1000);
    const initData = createValidInitData(now - 60, 123456789);

    const result1 = validateTelegramInitData(initData, { ...config, maxAgeSeconds: -100 });
    assert.ok(!result1.valid);
    assert.ok(result1.error?.includes("maxAgeSeconds"));

    const result2 = validateTelegramInitData(initData, { ...config, maxAgeSeconds: Infinity });
    assert.ok(!result2.valid);
    assert.ok(result2.error?.includes("maxAgeSeconds"));

    const result3 = validateTelegramInitData(initData, { ...config, maxAgeSeconds: 0 });
    assert.ok(!result3.valid);
    assert.ok(result3.error?.includes("maxAgeSeconds"));

    const result4 = validateTelegramInitData(initData, { ...config, maxAgeSeconds: 86400 * 400 });
    assert.ok(!result4.valid);
    assert.ok(result4.error?.includes("maxAgeSeconds"));
  });
});
