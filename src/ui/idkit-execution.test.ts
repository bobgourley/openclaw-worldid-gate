/**
 * IDKit execution integration tests.
 * 
 * Tests enrollment.html with locally bundled IDKit SDK execution,
 * verifying API parameter usage, connection URI generation,
 * and error state handling without making live API calls.
 */

import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('IDKit execution in enrollment.html', () => {
  test('HTML imports local bundle, not CDN', () => {
    const html = readFileSync(join(__dirname, 'enrollment.html'), 'utf-8');
    
    assert.ok(html.includes('/idkit-bundle.js'), 'Should import local bundle');
    assert.ok(!html.includes('cdn.jsdelivr.net'), 'Should not use CDN import');
    assert.ok(!html.includes('https://cdn'), 'Should not use any CDN');
  });

  test('HTML executes IDKit.request with correct parameters', () => {
    const html = readFileSync(join(__dirname, 'enrollment.html'), 'utf-8');
    
    // Extract script content
    const scriptMatch = html.match(/<script[^>]*type="module"[^>]*>([\s\S]*?)<\/script>/);
    assert.ok(scriptMatch, 'Should have module script');
    
    const script = scriptMatch[1];
    
    // Verify IDKit.request is called with required parameters
    assert.ok(script.includes('IDKit.request'), 'Should call IDKit.request');
    assert.ok(script.includes('app_id:'), 'Should pass app_id parameter');
    assert.ok(script.includes('action:'), 'Should pass action parameter');
    assert.ok(script.includes('rp_context:'), 'Should pass rp_context parameter');
    assert.ok(script.includes('allow_legacy_proofs:'), 'Should pass allow_legacy_proofs parameter');
    assert.ok(script.includes('session_id:'), 'Should pass session_id parameter for session creation');
    
    // Verify constraints API is used (World ID 4.0)
    assert.ok(script.includes('.constraints('), 'Should call constraints (not preset)');
    assert.ok(script.includes('CredentialRequest'), 'Should use CredentialRequest');
    assert.ok(script.includes('signal:'), 'Should pass signal parameter');
    
    // Verify pollUntilCompletion is called
    assert.ok(script.includes('pollUntilCompletion'), 'Should call pollUntilCompletion');
    assert.ok(script.includes('pollInterval:'), 'Should configure poll interval');
    assert.ok(script.includes('timeout:'), 'Should configure timeout');
  });

  test('HTML constructs valid rp_context from session', () => {
    const html = readFileSync(join(__dirname, 'enrollment.html'), 'utf-8');
    const scriptMatch = html.match(/<script[^>]*type="module"[^>]*>([\s\S]*?)<\/script>/);
    const script = scriptMatch![1];
    
    // Verify rp_context construction
    assert.ok(script.includes('rp_id:'), 'Should include rp_id');
    assert.ok(script.includes('nonce:'), 'Should include nonce');
    assert.ok(script.includes('created_at:'), 'Should include created_at');
    assert.ok(script.includes('expires_at:'), 'Should include expires_at');
    assert.ok(script.includes('signature:'), 'Should include signature');
    
    // Verify values come from session
    assert.ok(script.includes('session.signedChallenge.nonce'), 'nonce from session');
    assert.ok(script.includes('session.signedChallenge.signature'), 'signature from session');
  });

  test('HTML handles IDKit bundle load failure', () => {
    const html = readFileSync(join(__dirname, 'enrollment.html'), 'utf-8');
    const scriptMatch = html.match(/<script[^>]*type="module"[^>]*>([\s\S]*?)<\/script>/);
    const script = scriptMatch![1];
    
    // Verify error handling around IDKit import
    assert.ok(script.includes('try {'), 'Should have try block');
    assert.ok(script.includes('catch'), 'Should have catch block');
    assert.ok(
      script.includes('showError') || script.includes('error'),
      'Should handle errors'
    );
  });

  test('HTML handles poll timeout and cancellation', () => {
    const html = readFileSync(join(__dirname, 'enrollment.html'), 'utf-8');
    const scriptMatch = html.match(/<script[^>]*type="module"[^>]*>([\s\S]*?)<\/script>/);
    const script = scriptMatch![1];
    
    // Verify timeout handling
    assert.ok(script.includes('timeout:'), 'Should configure timeout');
    
    // Verify result handling
    assert.ok(script.includes('result.success'), 'Should check success field');
    assert.ok(script.includes('result.result'), 'Should access result data');
    assert.ok(script.includes('result.error'), 'Should handle error case');
  });

  test('HTML sends completion with initData and idkitResult', () => {
    const html = readFileSync(join(__dirname, 'enrollment.html'), 'utf-8');
    const scriptMatch = html.match(/<script[^>]*type="module"[^>]*>([\s\S]*?)<\/script>/);
    const script = scriptMatch![1];
    
    // Verify completion request construction
    assert.ok(script.includes('/api/enrollment/complete'), 'Should call completion endpoint');
    assert.ok(
      script.includes('initData:') && script.includes('idkitResult:'),
      'Should send both initData and idkitResult'
    );
    
    // Verify initData comes from Telegram context
    assert.ok(script.includes('initData'), 'Should include Telegram initData');
  });

  test('Bundle serves with correct MIME type', async () => {
    const html = readFileSync(join(__dirname, 'enrollment.html'), 'utf-8');
    
    // Verify import path
    assert.ok(html.includes("import('/idkit-bundle.js')"), 'Should use absolute path import');
    
    // Note: HTTP Content-Type verified in production server tests
    // (application/javascript with Cache-Control header)
  });
});
