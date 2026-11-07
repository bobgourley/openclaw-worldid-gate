/**
 * Production Telegram Mini App `initData` validator.
 *
 * Official reference:
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 * Validates data-check-string integrity with HMAC-SHA-256 using secret_key derived
 * from bot_token and constant "WebAppData", then checks auth_date freshness.
 *
 * @module telegram-initdata
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Configuration for initData validation.
 */
export interface TelegramInitDataConfig {
  /** Bot token from @BotFather (never exposed to frontend) */
  botToken: string;
  /** Maximum age of initData in seconds (default: 3600 = 1 hour) */
  maxAgeSeconds?: number;
  /** Current time for deterministic testing (defaults to Date.now()) */
  currentTime?: Date;
}

/**
 * Validated Telegram user data extracted from initData.
 */
export interface ValidatedTelegramUser {
  /** Numeric Telegram user ID */
  id: number;
  /** User first name */
  firstName: string;
  /** User last name (optional) */
  lastName?: string;
  /** Username (optional, without @) */
  username?: string;
  /** Language code (e.g., 'en') */
  languageCode?: string;
}

/**
 * Validation result with typed user data.
 */
export interface InitDataValidationResult {
  valid: boolean;
  user?: ValidatedTelegramUser;
  authDate?: Date;
  error?: string;
}

/**
 * Validate Telegram Mini App initData according to official algorithm.
 *
 * Algorithm per https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app:
 * 1. Parse initData query string
 * 2. Construct data-check-string from sorted fields (excluding 'hash')
 * 3. Derive secret_key = HMAC_SHA256("WebAppData", bot_token)  [note: key is first arg]
 * 4. Compute expected_hash = HMAC_SHA256(data_check_string, secret_key)
 * 5. Compare expected_hash with provided hash using timing-safe comparison
 * 6. Verify auth_date is within maxAgeSeconds threshold (must be positive finite integer)
 *
 * @param initData - Raw initData string from Telegram.WebApp.initData
 * @param config - Validation configuration with bot token and max age
 * @returns Validation result with user data or error
 */
export function validateTelegramInitData(
  initData: string,
  config: TelegramInitDataConfig,
): InitDataValidationResult {
  const maxAgeSeconds = config.maxAgeSeconds ?? 3600;

  // Validate maxAgeSeconds bounds
  if (!Number.isFinite(maxAgeSeconds) || maxAgeSeconds <= 0 || maxAgeSeconds > 86400 * 365) {
    return {
      valid: false,
      error: "Invalid maxAgeSeconds: must be positive finite number <= 1 year",
    };
  }

  try {
    // Reject duplicate query keys to prevent parameter pollution attacks
    const keysSeen = new Set<string>();
    const rawPairs = initData.split("&");
    for (const pair of rawPairs) {
      const key = pair.split("=")[0];
      if (keysSeen.has(key)) {
        return {
          valid: false,
          error: `Duplicate query key rejected: '${key}'`,
        };
      }
      keysSeen.add(key);
    }

    // Parse query string into key-value pairs
    const params = new URLSearchParams(initData);
    const receivedHash = params.get("hash");

    if (!receivedHash) {
      return { valid: false, error: "Missing hash parameter" };
    }

    // Extract and validate auth_date (must be positive safe integer)
    const authDateStr = params.get("auth_date");
    if (!authDateStr) {
      return { valid: false, error: "Missing auth_date parameter" };
    }

    // Strict integer parsing: no leading/trailing junk, must be valid decimal
    if (!/^\d+$/.test(authDateStr)) {
      return { valid: false, error: "Invalid auth_date format: not a decimal integer" };
    }

    const authDateSeconds = parseInt(authDateStr, 10);
    if (!Number.isSafeInteger(authDateSeconds) || authDateSeconds <= 0) {
      return {
        valid: false,
        error: "Invalid auth_date: must be positive safe integer",
      };
    }

    const authDate = new Date(authDateSeconds * 1000);
    const now = config.currentTime ? config.currentTime.getTime() : Date.now();
    const ageSeconds = (now - authDate.getTime()) / 1000;

    if (ageSeconds < 0) {
      return { valid: false, error: "auth_date is in the future" };
    }

    if (ageSeconds > maxAgeSeconds) {
      return {
        valid: false,
        error: `initData expired (age: ${Math.floor(ageSeconds)}s, max: ${maxAgeSeconds}s)`,
      };
    }

    // Construct data-check-string from sorted fields (excluding hash)
    const dataCheckPairs: string[] = [];
    params.delete("hash"); // Remove hash from params for data-check-string

    for (const [key, value] of params.entries()) {
      dataCheckPairs.push(`${key}=${value}`);
    }

    dataCheckPairs.sort();
    const dataCheckString = dataCheckPairs.join("\n");

    // Derive secret_key = HMAC_SHA256(bot_token, "WebAppData")
    const secretKey = createHmac("sha256", "WebAppData").update(config.botToken).digest();

    // Compute expected_hash = HMAC_SHA256(data_check_string, secret_key)
    const expectedHash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

    // Validate hash is hex string of correct length (64 hex chars = 32 bytes)
    if (!/^[0-9a-f]{64}$/i.test(receivedHash)) {
      return {
        valid: false,
        error: "Invalid hash format: must be 64 hex characters",
      };
    }

    // Timing-safe comparison
    const receivedHashBuffer = Buffer.from(receivedHash, "hex");
    const expectedHashBuffer = Buffer.from(expectedHash, "hex");

    if (
      receivedHashBuffer.length !== expectedHashBuffer.length ||
      !timingSafeEqual(receivedHashBuffer, expectedHashBuffer)
    ) {
      return { valid: false, error: "HMAC signature mismatch" };
    }

    // Extract and parse user data
    const userStr = params.get("user");
    if (!userStr) {
      return { valid: false, error: "Missing user parameter" };
    }

    let userData: any;
    try {
      userData = JSON.parse(userStr);
    } catch {
      return { valid: false, error: "Invalid user JSON" };
    }

    // Validate user.id is positive safe integer (Telegram user IDs are positive integers)
    if (
      typeof userData.id !== "number" ||
      !Number.isSafeInteger(userData.id) ||
      userData.id <= 0
    ) {
      return {
        valid: false,
        error: "Missing or invalid user.id: must be positive safe integer",
      };
    }

    if (typeof userData.first_name !== "string" || userData.first_name.length === 0) {
      return {
        valid: false,
        error: "Missing or invalid user.first_name: must be non-empty string",
      };
    }

    // Only extract essential fields (id, firstName). Username/lastName are mutable display names,
    // not suitable for security decisions or long-term storage.
    const user: ValidatedTelegramUser = {
      id: userData.id,
      firstName: userData.first_name,
      lastName: typeof userData.last_name === "string" ? userData.last_name : undefined,
      username: typeof userData.username === "string" ? userData.username : undefined,
      languageCode: typeof userData.language_code === "string" ? userData.language_code : undefined,
    };

    return { valid: true, user, authDate };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : "Unknown validation error",
    };
  }
}
