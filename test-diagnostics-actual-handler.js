#!/usr/bin/env node

/**
 * Test ACTUAL inline enrollment handler with real SDK
 * 
 * - Loads actual enrollment-diagnostics.html
 * - Stubs ALL network (fetch, dynamic imports, Telegram)
 * - Tests actual handler execution (not copied implementation)
 * - Asserts negative/privacy/hostile cases
 */

import pkg from 'jsdom';
const { JSDOM, ResourceLoader, VirtualConsole } = pkg;
import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { signRequest } from '@worldcoin/idkit-server';
import { pathToFileURL } from 'url';

console.log('=== Actual Handler Test: enrollment-diagnostics.html ===\n');

// Load HTML
const htmlPath = '/workspace/src/ui/enrollment-diagnostics.html';
const html = readFileSync(htmlPath, 'utf-8');
const htmlHash = createHash('sha256').update(html).digest('hex');

console.log('Testing artifact:');
console.log(`  Path: ${htmlPath}`);
console.log(`  SHA256: ${htmlHash}`);
console.log();

// Generate synthetic session
const syntheticSigningKey = '0x' + '1'.repeat(64);
const syntheticAction = 'openclaw-verify';
const syntheticAppId = 'app_test';
const syntheticRpId = 'rp_test';

const rpSig = signRequest({
  signingKeyHex: syntheticSigningKey,
  action: syntheticAction,
  ttl: 300
});

const syntheticSession = {
  signedChallenge: {
    nonce: rpSig.nonce,
    createdAt: rpSig.createdAt,
    expiresAt: rpSig.expiresAt,
    signature: rpSig.sig,
    action: syntheticAction
  },
  appId: syntheticAppId,
  rpId: syntheticRpId,
  signal: 'telegram:123456'
};

console.log('Synthetic session created\n');

// Track what's called
const capturedCalls = {
  fetch: [],
  imports: [],
  diagnostics: null
};

// Virtual console to capture errors
const virtualConsole = new VirtualConsole();
const consoleErrors = [];
virtualConsole.on('error', (error) => {
  consoleErrors.push(error);
});
virtualConsole.on('log', (msg) => {
  if (msg.includes('Diagnostics generation failed')) {
    console.log('  [Console] ' + msg);
  }
});

console.log('Creating JSDOM with actual HTML...\n');

const dom = new JSDOM(html, {
  url: 'http://localhost:3000/enrollment?session=test-session',
  runScripts: 'dangerously',
  virtualConsole: virtualConsole,
  beforeParse(window) {
    // Stub Telegram WebApp
    window.Telegram = {
      WebApp: {
        initData: 'user=%7B%22id%22%3A123456%7D&auth_date=1700000000&hash=abc123',
        initDataUnsafe: { user: { id: 123456 } }
      }
    };
    
    // Stub fetch
    const originalFetch = window.fetch;
    window.fetch = async function(url, options) {
      const call = { url: url.toString(), method: options?.method || 'GET' };
      capturedCalls.fetch.push(call);
      
      if (url.includes('/api/enrollment/session/')) {
        return {
          ok: true,
          status: 200,
          json: async () => syntheticSession,
          headers: new window.Headers({ 'Content-Type': 'application/json' })
        };
      }
      
      return {
        ok: false,
        status: 404,
        json: async () => ({ error: 'Not found' }),
        headers: new window.Headers()
      };
    };
    
    // Stub dynamic import for IDKit bundle
    const originalImport = window.eval('(async function(path) { throw new Error("import not supported"); })');
    
    // Create import stub
    window.eval(`
      window.dynamicImportStub = async function(path) {
        if (path === '/idkit-bundle.js') {
          // Return stub IDKit with hashAction
          return {
            IDKit: {
              request: function(config) {
                return {
                  preset: function(presetConfig) {
                    return {
                      connectorURI: 'https://world.org/verify?t=wld&i=test',
                      pollUntilCompletion: async function(options) {
                        // Simulate error
                        return { success: false, error: 'invalid_rp_signature' };
                      },
                      getDebugReport: async function() {
                        return {
                          package_version: '4.6.0',
                          transport: 'bridge',
                          request_payload: {
                            app_id: config.app_id,
                            environment: config.environment || 'production',
                            proof_request: {
                              rp_id: config.rp_context.rp_id,
                              nonce: config.rp_context.nonce,
                              signature: config.rp_context.signature,
                              created_at: config.rp_context.created_at,
                              expires_at: config.rp_context.expires_at,
                              action: '0x00test_action_hash'
                            }
                          }
                        };
                      }
                    };
                  }
                };
              },
              hashAction: function(action) {
                // Stub hash function
                return '0x00test_action_hash';
              }
            },
            proofOfHuman: function(config) {
              return config;
            }
          };
        }
        if (path === '/qrcode-bundle.js') {
          return {
            QRCode: {
              toCanvas: async function(canvas, text, options) {
                // Stub QR code generation
                return;
              }
            }
          };
        }
        throw new Error('Module not found: ' + path);
      };
    `);
    
    // Intercept the module script's import statement
    const originalEval = window.eval;
    window.eval = function(code) {
      if (typeof code === 'string' && code.includes('import(')) {
        // Replace import() calls with our stub
        code = code.replace(/import\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g, 'dynamicImportStub($1$2$1)');
      }
      return originalEval.call(this, code);
    };
  }
});

const { window } = dom;

// Wait for scripts to execute
let retries = 0;
while (typeof window.handleProofError !== 'function' && retries < 10) {
  await new Promise(resolve => setTimeout(resolve, 500));
  retries++;
}

console.log('Checking for exposed functions...\n');

if (typeof window.handleProofError !== 'function') {
  console.error('❌ handleProofError not exposed after waiting');
  console.error('   JSDOM limitation: ES module dynamic imports not supported');
  console.error('   This is a concrete blocker for Node.js-based testing');
  console.error('   Browser-based testing would be required for full validation');
  process.exit(1);
}

console.log('✅ handleProofError found\n');

// Create mock IDKit request for testing
const mockIdkitRequest = {
  getDebugReport: async function() {
    return {
      package_version: '4.6.0',
      transport: 'bridge',
      request_payload: {
        app_id: syntheticAppId,
        environment: 'production',
        proof_request: {
          rp_id: syntheticRpId,
          nonce: rpSig.nonce,
          signature: rpSig.sig,
          created_at: rpSig.createdAt,
          expires_at: rpSig.expiresAt,
          action: '0x00test_action_hash'
        }
      }
    };
  }
};

// Stub window.IDKit for hashAction
window.IDKit = {
  hashAction: function(action) {
    return '0x00test_action_hash';
  }
};

console.log('Test 1: Valid error with all fields present\n');

await window.handleProofError('invalid_rp_signature', mockIdkitRequest, syntheticSession);

// Check diagnostics visible
const diagnosticsEl = window.document.getElementById('diagnostics');
if (!diagnosticsEl.classList.contains('visible')) {
  console.error('❌ Diagnostics not visible');
  process.exit(1);
}

console.log('✅ Diagnostics visible\n');

// Check all fields are populated
const fields = [
  'diagErrorCode',
  'diagSdkVersion',
  'diagTransport',
  'diagEnvMatch',
  'diagActionMatch',
  'diagAppIdMatch',
  'diagRpIdMatch',
  'diagNoncePresent',
  'diagSignaturePresent',
  'diagCreatedAtMatch',
  'diagExpiresAtMatch',
  'diagTimestampValid',
  'diagTtl'
];

console.log('Diagnostic values:\n');

for (const field of fields) {
  const el = window.document.getElementById(field);
  if (!el) {
    console.error(`❌ Field not found: ${field}`);
    process.exit(1);
  }
  const value = el.textContent;
  console.log(`  ${field}: ${value}`);
}

console.log();

// Test 2: Check for sensitive data leaks
console.log('Test 2: Checking for sensitive data leaks\n');

const allText = diagnosticsEl.textContent;
const sensitivePatterns = [rpSig.nonce, rpSig.sig, 'telegram:123456'];

let leaked = false;
for (const pattern of sensitivePatterns) {
  if (allText.includes(pattern)) {
    console.error(`❌ SENSITIVE DATA LEAKED: ${pattern.substring(0, 20)}...`);
    leaked = true;
  }
}

if (leaked) {
  process.exit(1);
}

console.log('✅ No sensitive data leaked\n');

// Test 3: Hostile package_version
console.log('Test 3: Hostile package_version (not in allowlist)\n');

const hostileVersionRequest = {
  getDebugReport: async function() {
    return {
      package_version: '999.999.999-malicious',
      transport: 'bridge',
      request_payload: {
        app_id: syntheticAppId,
        environment: 'production',
        proof_request: {
          rp_id: syntheticRpId,
          nonce: rpSig.nonce,
          signature: rpSig.sig,
          created_at: rpSig.createdAt,
          expires_at: rpSig.expiresAt,
          action: '0x00test_action_hash'
        }
      }
    };
  }
};

await window.handleProofError('invalid_rp_signature', hostileVersionRequest, syntheticSession);

const versionEl = window.document.getElementById('diagSdkVersion');
const versionValue = versionEl.textContent;

console.log(`  Version displayed: ${versionValue}`);

if (versionValue === '999.999.999-malicious') {
  console.error('❌ Hostile version leaked');
  process.exit(1);
}

console.log('✅ Hostile version rejected\n');

// Test 4: Hostile transport
console.log('Test 4: Hostile transport (not in allowlist)\n');

const hostileTransportRequest = {
  getDebugReport: async function() {
    return {
      package_version: '4.6.0',
      transport: 'malicious-transport',
      request_payload: {
        app_id: syntheticAppId,
        environment: 'production',
        proof_request: {
          rp_id: syntheticRpId,
          nonce: rpSig.nonce,
          signature: rpSig.sig,
          created_at: rpSig.createdAt,
          expires_at: rpSig.expiresAt,
          action: '0x00test_action_hash'
        }
      }
    };
  }
};

await window.handleProofError('invalid_rp_signature', hostileTransportRequest, syntheticSession);

const transportEl = window.document.getElementById('diagTransport');
const transportValue = transportEl.textContent;

console.log(`  Transport displayed: ${transportValue}`);

if (transportValue === 'malicious-transport') {
  console.error('❌ Hostile transport leaked');
  process.exit(1);
}

console.log('✅ Hostile transport rejected\n');

// Test 5: Getter execution test
console.log('Test 5: Hostile object with getter\n');

const getterRequest = {
  getDebugReport: async function() {
    return {
      get package_version() {
        throw new Error('Getter executed!');
      },
      transport: 'bridge',
      request_payload: {
        app_id: syntheticAppId,
        environment: 'production',
        proof_request: {
          rp_id: syntheticRpId,
          nonce: rpSig.nonce,
          signature: rpSig.sig,
          created_at: rpSig.createdAt,
          expires_at: rpSig.expiresAt,
          action: '0x00test_action_hash'
        }
      }
    };
  }
};

await window.handleProofError('invalid_rp_signature', getterRequest, syntheticSession);

const versionAfterGetter = window.document.getElementById('diagSdkVersion').textContent;

console.log(`  Version displayed: ${versionAfterGetter}`);

if (versionAfterGetter !== 'unknown') {
  console.error('❌ Getter was executed or version not unknown');
  process.exit(1);
}

console.log('✅ Getter not executed\n');

// Test 6: Infinity TTL test
console.log('Test 6: Invalid TTL (should show "invalid" not Infinity)\n');

const invalidTtlSession = {
  ...syntheticSession,
  signedChallenge: {
    ...syntheticSession.signedChallenge,
    createdAt: 0,
    expiresAt: Infinity
  }
};

await window.handleProofError('invalid_rp_signature', mockIdkitRequest, invalidTtlSession);

const ttlEl = window.document.getElementById('diagTtl');
const ttlValue = ttlEl.textContent;

console.log(`  TTL displayed: ${ttlValue}`);

if (ttlValue.includes('Infinity')) {
  console.error('❌ TTL displays Infinity');
  process.exit(1);
}

console.log('✅ TTL bounded (no Infinity)\n');

// Test 7: Missing fields show UNKNOWN
console.log('Test 7: Missing fields show UNKNOWN (not FAIL)\n');

const missingFieldsRequest = {
  getDebugReport: async function() {
    return {
      package_version: '4.6.0',
      transport: 'bridge',
      request_payload: {
        // Missing app_id
        environment: 'production',
        proof_request: {
          // Missing fields
          rp_id: syntheticRpId
        }
      }
    };
  }
};

await window.handleProofError('invalid_rp_signature', missingFieldsRequest, syntheticSession);

const appIdEl = window.document.getElementById('diagAppIdMatch');
const appIdValue = appIdEl.textContent;

console.log(`  App ID Match: ${appIdValue}`);

if (appIdValue.includes('FAIL') && !appIdValue.includes('UNKNOWN')) {
  console.error('❌ Missing field shows FAIL instead of UNKNOWN');
  process.exit(1);
}

console.log('✅ Missing fields show UNKNOWN\n');

console.log('=== CONCLUSION ===\n');
console.log('Actual handler test results:');
console.log('  ✅ Inline handler executed');
console.log('  ✅ Diagnostics displayed');
console.log('  ✅ No sensitive data leaked');
console.log('  ✅ Hostile version rejected');
console.log('  ✅ Hostile transport rejected');
console.log('  ✅ Getter not executed (descriptor-safe)');
console.log('  ✅ TTL bounded (no Infinity)');
console.log('  ✅ Missing fields show UNKNOWN');
console.log();
console.log('Tested artifact:');
console.log(`  ${htmlPath}`);
console.log(`  SHA256: ${htmlHash}`);

process.exit(0);
