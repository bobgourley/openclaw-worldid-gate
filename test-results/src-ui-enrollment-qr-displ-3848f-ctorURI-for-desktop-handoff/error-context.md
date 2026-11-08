# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: src/ui/enrollment-qr-display.browser.test.ts >> Enrollment QR Code Display >> should render QR code from connectorURI for desktop handoff
- Location: src/ui/enrollment-qr-display.browser.test.ts:16:3

# Error details

```
Error: private key invalid 3
```

# Test source

```ts
  64  |   /** App ID for IDKit configuration */
  65  |   appId: string;
  66  | 
  67  |   /** RP ID for proof verification */
  68  |   rpId: string;
  69  | 
  70  |   /** 0x-prefixed hex nonce (32 bytes) */
  71  |   nonce: string;
  72  | 
  73  |   /** Unix timestamp (seconds) when challenge was created */
  74  |   createdAt: number;
  75  | 
  76  |   /** Unix timestamp (seconds) when challenge expires */
  77  |   expiresAt: number;
  78  | 
  79  |   /** 65-byte ECDSA signature (0x-prefixed hex) */
  80  |   signature: string;
  81  | 
  82  |   /** Action identifier for uniqueness proof nullifier isolation */
  83  |   action: string;
  84  | 
  85  |   /** Expected signal hash (0x-prefixed hex) for proof validation */
  86  |   signalHash: string;
  87  | 
  88  |   /** World ID environment */
  89  |   environment: string;
  90  | }
  91  | 
  92  | /**
  93  |  * Server-side expected verification context (NEVER exposed to client).
  94  |  * Passed to WorldIdVerificationClient for strict proof validation.
  95  |  */
  96  | export interface ExpectedVerificationContext {
  97  |   action: string;
  98  |   nonce: string;
  99  |   signalHash: string;
  100 | }
  101 | 
  102 | /**
  103 |  * Creates signed World ID v4 uniqueness proof challenges with authentic SDK-based signal hashing.
  104 |  */
  105 | export class WorldIdChallengeAdapter {
  106 |   private readonly config: Required<WorldIdChallengeAdapterConfig>;
  107 | 
  108 |   constructor(config: WorldIdChallengeAdapterConfig) {
  109 |     // Validate required fields
  110 |     if (!config.appId || !config.appId.startsWith('app_')) {
  111 |       throw new Error('Invalid appId: must start with "app_"');
  112 |     }
  113 |     if (!config.rpId || !config.rpId.startsWith('rp_')) {
  114 |       throw new Error('Invalid rpId: must start with "rp_"');
  115 |     }
  116 |     if (!config.signingKeyHex || typeof config.signingKeyHex !== 'string') {
  117 |       throw new Error('signingKeyHex is required');
  118 |     }
  119 | 
  120 |     const keyHex = config.signingKeyHex.startsWith('0x')
  121 |       ? config.signingKeyHex.slice(2)
  122 |       : config.signingKeyHex;
  123 | 
  124 |     if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
  125 |       throw new Error(
  126 |         'Invalid signingKeyHex: expected 32 bytes (64 hex characters)'
  127 |       );
  128 |     }
  129 | 
  130 |     this.config = {
  131 |       appId: config.appId,
  132 |       rpId: config.rpId,
  133 |       signingKeyHex: config.signingKeyHex,
  134 |       challengeTtlSeconds: config.challengeTtlSeconds ?? 300,
  135 |       environment: config.environment ?? 'production',
  136 |     };
  137 |   }
  138 | 
  139 |   /**
  140 |    * Creates a signed RP challenge for a uniqueness proof.
  141 |    *
  142 |    * @param action - Action identifier (arbitrary string, e.g., "enroll-telegram-user-12345")
  143 |    * @param signal - Signal to bind to proof (e.g., Telegram user ID)
  144 |    * @returns Signed challenge for client + expected context for server verification
  145 |    */
  146 |   createChallenge(
  147 |     action: string,
  148 |     signal: string
  149 |   ): {
  150 |     signedChallenge: SignedRpChallenge;
  151 |     expectedContext: ExpectedVerificationContext;
  152 |   } {
  153 |     if (!action || typeof action !== 'string') {
  154 |       throw new Error('action is required and must be a non-empty string');
  155 |     }
  156 |     if (signal === undefined || signal === null || typeof signal !== 'string') {
  157 |       throw new Error('signal is required and must be a string');
  158 |     }
  159 | 
  160 |     // Use official SDK signal hashing (Keccak256 + field reduction)
  161 |     const signalHash = hashSignal(signal);
  162 | 
  163 |     // Sign the RP challenge context with action (uniqueness proof mode)
> 164 |     const rpSignature: RpSignature = signRequest({
      |                                      ^ Error: private key invalid 3
  165 |       signingKeyHex: this.config.signingKeyHex,
  166 |       action,
  167 |       ttl: this.config.challengeTtlSeconds,
  168 |     });
  169 | 
  170 |     const signedChallenge: SignedRpChallenge = {
  171 |       appId: this.config.appId,
  172 |       rpId: this.config.rpId,
  173 |       nonce: rpSignature.nonce,
  174 |       createdAt: rpSignature.createdAt,
  175 |       expiresAt: rpSignature.expiresAt,
  176 |       signature: rpSignature.sig,
  177 |       action,
  178 |       signalHash,
  179 |       environment: this.config.environment,
  180 |     };
  181 | 
  182 |     const expectedContext: ExpectedVerificationContext = {
  183 |       action,
  184 |       nonce: rpSignature.nonce,
  185 |       signalHash,
  186 |     };
  187 | 
  188 |     return { signedChallenge, expectedContext };
  189 |   }
  190 | 
  191 |   /**
  192 |    * Extracts the nonce from a signed challenge for storage/lookup.
  193 |    */
  194 |   extractNonce(signedChallenge: SignedRpChallenge): string {
  195 |     return signedChallenge.nonce;
  196 |   }
  197 | 
  198 |   /**
  199 |    * Validates that a challenge has not expired (client-side or server-side check).
  200 |    * Does NOT verify signature; signature is validated by World App and verification service.
  201 |    */
  202 |   isExpired(signedChallenge: SignedRpChallenge, clockNowSeconds?: number): boolean {
  203 |     const now = clockNowSeconds ?? Math.floor(Date.now() / 1000);
  204 |     return now >= signedChallenge.expiresAt;
  205 |   }
  206 | }
  207 | 
```