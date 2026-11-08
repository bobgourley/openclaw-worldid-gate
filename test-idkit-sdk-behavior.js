#!/usr/bin/env node

/**
 * Test ACTUAL IDKit SDK behavior with mocked transport
 * 
 * Executes real IDKit.request() to observe:
 * 1. What happens when environment is omitted (SDK default)
 * 2. What happens when environment is explicitly "production"
 * 3. What canonical request bytes are generated
 * 
 * Uses JSDOM to provide browser environment for SDK execution.
 */

import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';

console.log('=== IDKit SDK Behavior Test ===\n');
console.log('Loading IDKit bundle and executing real SDK code...\n');

// Load the actual IDKit bundle
const idkitBundle = readFileSync('/workspace/dist/ui/idkit-bundle.js', 'utf-8');

// Create browser-like environment
const dom = new JSDOM(`
  <!DOCTYPE html>
  <html>
    <head><title>IDKit Test</title></head>
    <body></body>
  </html>
`, {
  url: 'http://localhost:3000',
  runScripts: 'outside-only'
});

const { window } = dom;
global.window = window;
global.document = window.document;
global.navigator = window.navigator;
global.crypto = {
  getRandomValues: (arr) => {
    for (let i = 0; i < arr.length; i++) {
      arr[i] = Math.floor(Math.random() * 256);
    }
    return arr;
  }
};

// Execute IDKit bundle in the window context
console.log('Step 1: Loading IDKit SDK...');
try {
  window.eval(idkitBundle);
  console.log('✅ IDKit SDK loaded successfully\n');
} catch (error) {
  console.error('❌ Failed to load IDKit SDK:', error.message);
  process.exit(1);
}

// Verify IDKit is available
if (typeof window.IDKit === 'undefined') {
  console.error('❌ IDKit not found in window after bundle execution');
  process.exit(1);
}

console.log('Step 2: Available exports:');
console.log('  - IDKit:', typeof window.IDKit);
console.log('  - proofOfHuman:', typeof window.proofOfHuman);
console.log();

// Test configuration matching production
const testAppId = 'app_b466e1f63a70a695b6d990d261e31b6a';
const testRpId = 'rp_223416a2a76673a1';
const testAction = 'openclaw-verify';
const testRpContext = {
  rp_id: testRpId,
  nonce: '0x00793fca9e59c103bff52add64608a7994149244cfcd6a77fbdb4bf314063f26',
  created_at: 1794175071,
  expires_at: 1794175371,
  signature: '0x3f48825e37db0babf1c744fdc642345e87cc4ca95f7d82b522501342c77d63c1568dcd6965198ed78cbc557a0a6a0ac3da8515dd3c8476ba4bd052088e3787cd1b'
};

console.log('Step 3: Test configuration:');
console.log(`  app_id: ${testAppId}`);
console.log(`  rp_id: ${testRpId}`);
console.log(`  action: ${testAction}`);
console.log();

// Mock fetch to capture requests
const capturedRequests = [];
global.fetch = async (url, options) => {
  capturedRequests.push({ url, options });
  console.log(`  [FETCH] ${options?.method || 'GET'} ${url}`);
  
  // Return minimal valid response
  return {
    ok: true,
    status: 200,
    json: async () => ({ request_id: 'test-request-id' }),
    text: async () => 'OK'
  };
};

console.log('Step 4: Testing IDKit.request() WITHOUT environment parameter...\n');

let request1;
try {
  request1 = await window.IDKit.request({
    app_id: testAppId,
    action: testAction,
    rp_context: testRpContext,
    allow_legacy_proofs: true
    // environment omitted - SDK should default
  });
  console.log('✅ Request created (environment omitted)');
  console.log(`   Request ID: ${request1.requestId || 'N/A'}`);
  console.log(`   Connector URI: ${request1.connectorURI?.substring(0, 50) || 'N/A'}...`);
} catch (error) {
  console.error('❌ Failed to create request:', error.message);
  console.error('   Stack:', error.stack);
}

console.log();
console.log('Step 5: Testing IDKit.request() WITH environment: "production"...\n');

capturedRequests.length = 0; // Clear previous requests

let request2;
try {
  request2 = await window.IDKit.request({
    app_id: testAppId,
    action: testAction,
    rp_context: testRpContext,
    allow_legacy_proofs: true,
    environment: 'production' // Explicitly set
  });
  console.log('✅ Request created (environment: "production")');
  console.log(`   Request ID: ${request2.requestId || 'N/A'}`);
  console.log(`   Connector URI: ${request2.connectorURI?.substring(0, 50) || 'N/A'}...`);
} catch (error) {
  console.error('❌ Failed to create request:', error.message);
  console.error('   Stack:', error.stack);
}

console.log();
console.log('Step 6: Comparing connector URIs...\n');

if (request1?.connectorURI && request2?.connectorURI) {
  console.log('Connector URI 1 (no environment):');
  console.log(`  ${request1.connectorURI}`);
  console.log();
  console.log('Connector URI 2 (environment: "production"):');
  console.log(`  ${request2.connectorURI}`);
  console.log();
  
  if (request1.connectorURI === request2.connectorURI) {
    console.log('✅ RESULT: Connector URIs are IDENTICAL');
    console.log('   → Adding explicit environment: "production" is a NO-OP');
    console.log('   → SDK does default to "production" as claimed');
  } else {
    console.log('❌ RESULT: Connector URIs DIFFER');
    console.log('   → SDK behavior changes with explicit environment parameter');
    
    // Find the difference
    const uri1 = new URL(request1.connectorURI);
    const uri2 = new URL(request2.connectorURI);
    
    console.log();
    console.log('Differences:');
    console.log(`  Base URL 1: ${uri1.origin}${uri1.pathname}`);
    console.log(`  Base URL 2: ${uri2.origin}${uri2.pathname}`);
    
    const params1 = Object.fromEntries(uri1.searchParams);
    const params2 = Object.fromEntries(uri2.searchParams);
    
    console.log();
    console.log('URL Parameters:');
    const allKeys = new Set([...Object.keys(params1), ...Object.keys(params2)]);
    for (const key of allKeys) {
      if (params1[key] !== params2[key]) {
        console.log(`  ${key}:`);
        console.log(`    Without environment: ${params1[key] || '(missing)'}`);
        console.log(`    With environment:    ${params2[key] || '(missing)'}`);
      }
    }
  }
} else {
  console.log('⚠️  Could not compare connector URIs (one or both missing)');
}

console.log();
console.log('Step 7: Captured network requests:');
console.log(`  Total requests: ${capturedRequests.length}`);
capturedRequests.forEach((req, i) => {
  console.log(`  [${i + 1}] ${req.options?.method || 'GET'} ${req.url}`);
  if (req.options?.body) {
    console.log(`      Body: ${req.options.body.substring(0, 100)}...`);
  }
});

console.log();
console.log('=== CONCLUSION ===\n');
console.log('This test executes the ACTUAL IDKit SDK code (not hand-built objects).');
console.log('It compares SDK behavior with and without explicit environment parameter.');
console.log('If connector URIs are identical, adding environment: "production" is a no-op.');
console.log('If they differ, the parameter changes SDK behavior.');

process.exit(0);
