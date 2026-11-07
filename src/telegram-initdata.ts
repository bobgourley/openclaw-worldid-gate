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
 * 3. Derive secret_key = HMAC_SHA256(bot_token, "WebAppData")
 * 4. Compute expected_hash = HMAC_SHA256(data_check_string, secret_key)
 * 5. Compare expected_hash with provided hash using timing-safe comparison
 * 6. Verify auth_date is within maxAgeSeconds threshold
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

  try {
    // Parse query string into key-value pairs
    const params = new URLSearchParams(initData);
    const receivedHash = params.get("hash");

    if (!receivedHash) {
      return { valid: false, error: "Missing hash parameter" };
    }

    // Extract and validate auth_date
    const authDateStr = params.get("auth_date");
    if (!authDateStr) {
      return { valid: false, error: "Missing auth_date parameter" };
    }

    const authDateSeconds = parseInt(authDateStr, 10);
    if (isNaN(authDateSeconds)) {
      return { valid: false, error: "Invalid auth_date format" };
    }

    const authDate = new Date(authDateSeconds * 1000);
    const now = Date.now();
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

    if (typeof userData.id !== "number") {
      return { valid: false, error: "Missing or invalid user.id" };
    }

    if (typeof userData.first_name !== "string") {
      return { valid: false, error: "Missing or invalid user.first_name" };
    }

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
