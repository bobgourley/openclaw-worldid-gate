/**
 * Frontend integration tests - verifies correct SDK usage patterns and HTTP flows.
 * 
 * Tests integration points without JSDOM ES module limitations.
 * Verifies:
 * - Correct IDKit API usage (request vs proveSession)
 * - Correct HTTP endpoint flows
 * - Session ID handling (never stored/displayed)
 * - Status-driven flow selection
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('Frontend Integration Patterns', () => {
  it('uses IDKit.request with session_id: create for new enrollment', () => {
    const html = readFileSync(join(__dirname, 'enrollment.html'), 'utf-8');
    
    // Verify new enrollment uses IDKit.request with session creation
    assert.ok(html.includes('IDKit.request'), 'Must use IDKit.request');
    assert.ok(html.includes("session_id: 'create'"), 'Must use session_id: create for new enrollment');
    assert.ok(html.includes('allow_legacy_proofs: false'), 'Must disable legacy proofs');
    assert.ok(html.includes('.constraints('), 'Must use constraints API');
    assert.ok(html.includes('CredentialRequest'), 'Must use CredentialRequest');
  });

  it('uses IDKit.proveSession for returning users', () => {
    const html = readFileSync(join(__dirname, 'enrollment.html'), 'utf-8');
    
    // Verify returning user uses IDKit.proveSession
    assert.ok(html.includes('IDKit.proveSession'), 'Must use IDKit.proveSession for returning users');
    assert.ok(html.includes('proveSession(sessionId'), 'Must pass sessionId to proveSession');
    assert.ok(html.includes('app_id:'), 'Must pass app_id to proveSession');
    assert.ok(html.includes('rp_context:'), 'Must pass rp_context to proveSession');
  });

  it('calls authenticated status endpoint before enrollment', () => {
    const html = readFileSync(join(__dirname, 'enrollment.html'), 'utf-8');
    
    // Verify status check flow
    assert.ok(html.includes('/api/enrollment/query'), 'Must call status endpoint');
    assert.ok(html.includes('checkEnrollmentStatus'), 'Must check enrollment status');
    assert.ok(html.includes('POST'), 'Must use POST for status (authenticated)');
    assert.ok(html.includes('initData:'), 'Must send initData for authentication');
  });

  it('routes to correct flow based on server status response', () => {
    const html = readFileSync(join(__dirname, 'enrollment.html'), 'utf-8');
    
    // Verify flow routing (renewal only, no reactivation)
    assert.ok(html.includes("status === 'renewal'"), 'Must check renewal status');
    assert.ok(html.includes('handleReturningUser'), 'Must handle returning users');
    assert.ok(html.includes('handleNewEnrollment'), 'Must handle new enrollment');
  });

  it('handles renewal flow without mode parameter', () => {
    const html = readFileSync(join(__dirname, 'enrollment.html'), 'utf-8');
    
    // Verify renewal handling (no mode parameter)
    assert.ok(html.includes('/api/session/challenge/create'), 'Must call session challenge endpoint');
    assert.ok(!html.includes("mode: 'reactivation'"), 'Must not use reactivation mode');
  });

  it('submits proofs to correct endpoints', () => {
    const html = readFileSync(join(__dirname, 'enrollment.html'), 'utf-8');
    
    // Verify submission endpoints
    assert.ok(html.includes('/api/enrollment/complete'), 'Must submit new enrollment to /complete');
    assert.ok(html.includes('/api/session/verify'), 'Must submit session proofs to /verify');
    assert.ok(html.includes('submitEndpoint'), 'Must use dynamic submit endpoint');
  });

  it('never stores session ID in localStorage', () => {
    const html = readFileSync(join(__dirname, 'enrollment.html'), 'utf-8');
    
    // Verify NO localStorage usage for session IDs
    assert.ok(!html.includes('localStorage.setItem'), 'Must not use localStorage.setItem');
    assert.ok(!html.includes('sessionStorage.setItem'), 'Must not use sessionStorage.setItem');
    
    // Session ID should be in memory only (function parameter/variable)
    const sessionIdPattern = /sessionId\s*=\s*enrollmentStatus\.sessionId/;
    assert.ok(sessionIdPattern.test(html), 'Session ID should be extracted to local variable only');
  });

  it('never displays session ID in UI', () => {
    const html = readFileSync(join(__dirname, 'enrollment.html'), 'utf-8');
    
    // Verify session ID is never rendered
    assert.ok(!html.includes('textContent = sessionId'), 'Must not display sessionId in textContent');
    assert.ok(!html.includes('innerHTML = sessionId'), 'Must not display sessionId in innerHTML');
    
    // Success message should not include session ID
    const successMessagePattern = /showSuccess.*sessionId/i;
    assert.ok(!successMessagePattern.test(html), 'Success message must not include sessionId');
  });

  it('preserves QR code generation', () => {
    const html = readFileSync(join(__dirname, 'enrollment.html'), 'utf-8');
    
    // Verify QR code functionality
    assert.ok(html.includes('generateQRCode'), 'Must have generateQRCode function');
    assert.ok(html.includes('connectorURI'), 'Must use connectorURI for QR');
    assert.ok(html.includes('QRCode.toCanvas'), 'Must use QRCode library');
  });

  it('preserves privacy-safe error diagnostics', () => {
    const html = readFileSync(join(__dirname, 'enrollment.html'), 'utf-8');
    
    // Verify error handling exists
    assert.ok(html.includes('showError'), 'Must have showError function');
    assert.ok(html.includes('handleProofError'), 'Must have error handler');
    assert.ok(html.includes('errorCode'), 'Must log errorCode for diagnostics');
    
    // Verify no sensitive data in error logs
    assert.ok(!html.includes('console.log(initData)'), 'Must not log initData');
    assert.ok(!html.includes('console.log(sessionId)'), 'Must not log sessionId');
  });

  it('requires Telegram context (fail-closed)', () => {
    const html = readFileSync(join(__dirname, 'enrollment.html'), 'utf-8');
    
    // Verify Telegram requirement
    assert.ok(html.includes('if (!initData)'), 'Must check for initData');
    assert.ok(html.includes('Telegram'), 'Must reference Telegram context');
    assert.ok(html.includes('return'), 'Must return early if no Telegram context');
  });

  it('uses correct RP context structure (no synthetic values)', () => {
    const html = readFileSync(join(__dirname, 'enrollment.html'), 'utf-8');
    
    // Verify RP context construction
    assert.ok(html.includes('rp_context = {'), 'Must construct rp_context');
    assert.ok(html.includes('rp_id:'), 'Must include rp_id');
    assert.ok(html.includes('nonce:'), 'Must include nonce');
    assert.ok(html.includes('created_at:'), 'Must include created_at');
    assert.ok(html.includes('expires_at:'), 'Must include expires_at');
    assert.ok(html.includes('signature:'), 'Must include signature');
    
    // Verify no fallbacks
    assert.ok(!html.includes("|| 'rp_"), 'Must not have rp_id fallback');
    assert.ok(!html.includes("|| '0x0"), 'Must not have signature fallback');
  });

  it('handles viewport changes for QR responsiveness', () => {
    const html = readFileSync(join(__dirname, 'enrollment.html'), 'utf-8');
    
    // Verify responsive QR
    assert.ok(html.includes('handleViewportChange'), 'Must handle viewport changes');
    assert.ok(html.includes('visualViewport'), 'Must listen to visualViewport');
    assert.ok(html.includes('orientationchange'), 'Must listen to orientation changes');
  });
});

describe('HTTP Flow Verification', () => {
  it('status endpoint requires initData authentication', () => {
    const html = readFileSync(join(__dirname, 'enrollment.html'), 'utf-8');
    
    // Verify status request includes initData
    assert.ok(html.includes('/api/enrollment/query'), 'Must call status endpoint');
    assert.ok(html.includes('initData:'), 'Must include initData in request');
    assert.ok(html.includes('checkEnrollmentStatus'), 'Must check enrollment status');
  });

  it('challenge endpoints called with correct parameters', () => {
    const html = readFileSync(join(__dirname, 'enrollment.html'), 'utf-8');
    
    // Initial challenge
    assert.ok(html.includes('/api/challenge/create'), 'Must call challenge create for new enrollment');
    
    // Session challenge
    assert.ok(html.includes('/api/session/challenge/create'), 'Must call session challenge for returning users');
  });

  it('proof submission includes initData for binding', () => {
    const html = readFileSync(join(__dirname, 'enrollment.html'), 'utf-8');
    
    // Verify both endpoints include initData and idkitResult
    assert.ok(html.includes('/api/enrollment/complete'), 'Must have complete endpoint');
    assert.ok(html.includes('/api/session/verify'), 'Must have verify endpoint');
    assert.ok(html.includes('initData: initData'), 'Must include initData in request');
    assert.ok(html.includes('idkitResult:'), 'Must include idkitResult in request');
  });
});

describe('Bundle Export Verification', () => {
  it('IDKit bundle exports required APIs', () => {
    const bundlePath = join(__dirname, '../../dist/ui/idkit-bundle.js');
    const bundle = readFileSync(bundlePath, 'utf-8');
    
    // Verify exports
    assert.ok(bundle.includes('IDKit'), 'Bundle must export IDKit');
    assert.ok(bundle.includes('CredentialRequest'), 'Bundle must export CredentialRequest');
    
    // Verify window exposure for compatibility
    assert.ok(bundle.includes('WorldIDKit'), 'Bundle must expose WorldIDKit on window');
  });

  it('QRCode bundle exports QR generation API', () => {
    const bundlePath = join(__dirname, '../../dist/ui/qrcode-bundle.js');
    const bundle = readFileSync(bundlePath, 'utf-8');
    
    // Verify QRCode export
    assert.ok(bundle.includes('QRCode') || bundle.includes('export_QRCode'), 'Bundle must export QRCode');
  });
});
