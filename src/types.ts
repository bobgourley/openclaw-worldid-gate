/**
 * World ID proof verification types
 * Reference: https://docs.world.org/api-reference/developer-portal/verify
 */

export interface WorldIdProof {
  protocol_version: '4.0';
  nonce: string;
  action: string;
  responses: WorldIdResponse[];
  environment?: 'production' | 'staging' | 'sandbox';
}

export interface WorldIdResponse {
  identifier: 'proof_of_human' | 'selfie' | 'orb';
  issuer_schema_id: number;
  nullifier: string;
  expires_at_min: number;
  proof: string[];
  signal_hash?: string;
  sybil_score?: number;
}

export interface WorldIdVerifyResult {
  success: boolean;
  results?: Array<{
    identifier: string;
    success: boolean;
    nullifier?: string;
    code?: string;
    detail?: string;
  }>;
  code?: string;
  detail?: string;
}

/**
 * Telegram update types (synthetic for testing)
 * These are NOT authenticated live Telegram API updates
 */

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  sender_chat?: TelegramChat;
  date: number;
  chat: TelegramChat;
  text?: string;
  forward_from?: TelegramUser;
  forward_from_chat?: TelegramChat;
  reply_to_message?: TelegramMessage;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
}

/**
 * Enrollment and admission types
 */

export interface Enrollment {
  telegramUserId: number;
  worldIdNullifier: string;
  enrolledAt: number;
  expiresAt: number;
  action: string;
  revoked?: boolean;
}

export interface AdmissionRequest {
  telegramUpdate: TelegramUpdate;
  timestamp: number;
}

export interface AdmissionResult {
  allowed: boolean;
  reason: string;
  telegramUserId?: number;
  enrollment?: Enrollment;
}

/**
 * Gate configuration
 */

export interface GateConfig {
  rpId: string;
  action: string;
  verifyEndpoint: string;
  requireProofOfHuman: boolean;
  enrollmentTtlSeconds: number;
  allowTestMode: boolean;
}

/**
 * Verification provider interface
 */

export interface WorldIdVerifier {
  verify(proof: WorldIdProof): Promise<WorldIdVerifyResult>;
}

/**
 * Enrollment store interface
 */

export interface EnrollmentStore {
  get(telegramUserId: number): Promise<Enrollment | null>;
  set(enrollment: Enrollment): Promise<void>;
  revoke(telegramUserId: number): Promise<void>;
}

/**
 * Observability hooks for testing
 */

export interface GateMetrics {
  llmCallCount: number;
  historyReadCount: number;
  historyWriteCount: number;
  toolExecutionCount: number;
}
