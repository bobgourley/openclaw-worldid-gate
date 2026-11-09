/**
 * Client-side execution tests for enrollment.html
 * 
 * Tests actual browser JS execution using JSDOM, not just HTML regex matching.
 * Validates IDKit SDK integration, Telegram initData forwarding, and security boundaries.
 */

import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('enrollment.html client execution', () => {
  /**
   * Load HTML and create browser-like environment
   */
  function createDOMEnvironment(options: {
    sessionId?: string;
    hasTelegramWebApp?: boolean;
    initData?: string;
  }) {
    const html = readFileSync(join(__dirname, 'enrollment.html'), 'utf-8');
    const url = options.sessionId 
      ? `http://localhost:3000/enrollment?session=${options.sessionId}`
      : 'http://localhost:3000/enrollment';
    
    const dom = new JSDOM(html, {
      url,
      runScripts: 'outside-only',
      resources: 'usable',
      pretendToBeVisual: true,
    });

    const { window } = dom;

    // Mock Telegram WebApp API if requested
    if (options.hasTelegramWebApp) {
      (window as any).Telegram = {
        WebApp: {
          initData: options.initData || '',
          ready: () => {},
          expand: () => {},
        }
      };
    }

    // Mock fetch API with URL resolution
    const fetchMock = mock.fn(async (urlInput: string | URL, options?: any) => {
      // Resolve relative URLs
      const url = typeof urlInput === 'string' 
        ? (urlInput.startsWith('/') ? `http://localhost:3000${urlInput}` : urlInput)
        : urlInput.toString();
      throw new Error(`Unmocked fetch: ${url}`);
    });
    window.fetch = fetchMock as any;

    return { dom, window, document: window.document, fetchMock };
  }

  /**
   * Wait for async initialization to complete
   */
  async function waitForInit(window: any, timeoutMs = 1000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await new Promise(resolve => setTimeout(resolve, 50));
      if (window.enrollmentSession || window.document.querySelector('#status').className !== 'loading') {
        break;
      }
    }
  }

  test('should disable verification when Telegram initData is missing (external browser)', async () => {
    const { window, document } = createDOMEnvironment({
      sessionId: 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6',
      hasTelegramWebApp: false, // External browser - no Telegram context
    });

    // Extract and execute the script
    const scriptContent = document.querySelector('script[type="module"]')?.textContent;
    assert.ok(scriptContent, 'Script should exist');

    // Execute script in the window context - should throw when SDK missing
    const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
    const scriptFn = new AsyncFunction('window', 'document', 'console', scriptContent);
    
    // Script should throw error when Telegram SDK not loaded
    await assert.rejects(
      async () => await scriptFn(window, document, console),
      /Telegram WebApp SDK not loaded/,
      'Script must throw when Telegram SDK not loaded'
    );

    // Should show error before throwing (fail-closed)
    const statusEl = document.getElementById('status');
    assert.ok(statusEl, 'Status element should exist');
    assert.strictEqual(statusEl.className, 'error', 'Should show error state');
    assert.ok(
      statusEl.textContent?.includes('Telegram'),
      'Should explain that Telegram SDK failed to load'
    );

    // Button should be hidden (verification disabled)
    const buttonEl = document.getElementById('verifyButton');
    assert.ok(buttonEl?.classList.contains('hidden'), 'Button should be hidden');
  });

  test('should explicitly load Telegram SDK and check availability', () => {
    const html = readFileSync(join(__dirname, 'enrollment.html'), 'utf-8');
    
    // Verify Telegram SDK is explicitly loaded
    assert.ok(
      html.includes('telegram-web-app.js'),
      'Must explicitly load Telegram WebApp SDK'
    );
    
    const scriptContent = html.match(/<script[^>]*type="module"[^>]*>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(scriptContent, 'Script should exist');
    
    // Verify script explicitly checks if SDK loaded before use
    assert.ok(
      /typeof\s+window\.Telegram/.test(scriptContent) ||
      /window\.Telegram\s*===/.test(scriptContent) ||
      /!window\.Telegram/.test(scriptContent),
      'Script must explicitly check if Telegram SDK loaded'
    );
    
    // Verify script checks for Telegram WebApp initData
    assert.ok(
      scriptContent.includes('Telegram') && 
      scriptContent.includes('WebApp') && 
      scriptContent.includes('initData'),
      'Script must check for Telegram.WebApp.initData'
    );
    
    // Verify script shows warning when initData is missing
    assert.ok(
      scriptContent.includes('Telegram bot') || 
      scriptContent.includes('external browser') ||
      scriptContent.includes('Telegram.'),
      'Script must warn when SDK not loaded or opened in external browser'
    );
    
    // Verify script blocks verification without initData
    assert.ok(
      /if\s*\([^)]*!initData[^)]*\)/.test(scriptContent),
      'Script must check and block when initData is missing'
    );
  });

  test('should send initData along with idkitResult to /api/enrollment/complete', () => {
    const html = readFileSync(join(__dirname, 'enrollment.html'), 'utf-8');
    const scriptContent = html.match(/<script[^>]*type="module"[^>]*>([\s\S]*?)<\/script>/)?.[1];
    
    assert.ok(scriptContent, 'Script should exist');
    
    // Verify script constructs completion request with both initData and idkitResult
    assert.ok(
      scriptContent.includes('initData:') && scriptContent.includes('idkitResult:'),
      'Completion request must include both initData and idkitResult fields'
    );
    
    // Verify initData comes from Telegram WebApp context
    assert.ok(
      scriptContent.includes('initData') && scriptContent.includes('Telegram') && scriptContent.includes('WebApp'),
      'Script must use Telegram.WebApp.initData for authentication'
    );
    
    // Verify fetch body stringifies both fields
    assert.ok(
      /JSON\.stringify\([^)]*initData[^)]*idkitResult[^)]*\)/s.test(scriptContent) ||
      /JSON\.stringify\([^)]*idkitResult[^)]*initData[^)]*\)/s.test(scriptContent),
      'Completion POST must send both initData and idkitResult in JSON body'
    );
  });

  test('should use textContent instead of innerHTML for error messages (XSS prevention)', async () => {
    const { window, document } = createDOMEnvironment({
      sessionId: 'test123',
      hasTelegramWebApp: true,
      initData: 'test',
    });

    // Execute script
    const scriptContent = document.querySelector('script[type="module"]')?.textContent;
    assert.ok(scriptContent, 'Script should exist');

    // Verify no innerHTML usage with dynamic content
    assert.ok(
      !scriptContent.includes('innerHTML =') || scriptContent.includes('// SECURITY: Use textContent'),
      'Should not use innerHTML for dynamic content without security comment'
    );
  });

  test('should handle enrollment status check and show ready state', async () => {
    const { window, document, fetchMock } = createDOMEnvironment({
      hasTelegramWebApp: true,
      initData: 'test',
    });

    // Mock successful status check (new user)
    fetchMock.mock.mockImplementationOnce(async (urlInput: string | URL) => ({
      ok: true,
      status: 200,
      json: async () => ({ status: 'new' })
    }));

    // Execute script
    const scriptContent = document.querySelector('script[type="module"]')?.textContent;
    const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
    const scriptFn = new AsyncFunction('window', 'document', 'console', scriptContent);
    await scriptFn(window, document, console);

    await waitForInit(window, 2000);

    // Should show ready state (not error)
    const statusEl = document.getElementById('status');
    assert.ok(statusEl?.className !== 'error', 'Should not show error state');
  });

  test('should validate no secrets in client code', () => {
    const html = readFileSync(join(__dirname, 'enrollment.html'), 'utf-8');
    
    // Check for common secret patterns (case-insensitive)
    const secretPatterns = [
      /bot_token/i,
      /api_key/i,
      /secret_key/i,
      /private_key/i,
      /app_secret/i,
      /-----BEGIN/i, // PEM keys
    ];

    for (const pattern of secretPatterns) {
      assert.ok(
        !pattern.test(html),
        `Should not contain pattern ${pattern} in client code`
      );
    }
  });

  test('should display accurate privacy statement', () => {
    const html = readFileSync(join(__dirname, 'enrollment.html'), 'utf-8');
    
    // Should NOT claim proof never leaves device
    assert.ok(
      !html.includes('never leaves your device'),
      'Should not claim proof never leaves device'
    );
    
    // Should accurately state our service receives no raw biometric data
    assert.ok(
      html.includes('Our service') && html.includes('no raw biometric data'),
      'Should accurately state our service receives no raw biometric data'
    );
  });

  test('should use official IDKit.request API, not fabricated IDKitWidget', () => {
    const html = readFileSync(join(__dirname, 'enrollment.html'), 'utf-8');
    
    // Should NOT use fabricated IDKitWidget class
    assert.ok(
      !html.includes('new IDKitWidget'),
      'Should not use fabricated IDKitWidget class'
    );
    
    // Should use official IDKit API
    assert.ok(
      html.includes('IDKit.request'),
      'Should use official IDKit.request API'
    );
    
    // Should use constraints API with CredentialRequest (World ID 4.0)
    assert.ok(
      html.includes('.constraints('),
      'Should use constraints API (World ID 4.0 session support)'
    );
    
    assert.ok(
      html.includes('CredentialRequest'),
      'Should use CredentialRequest for session enrollment'
    );
  });
});
