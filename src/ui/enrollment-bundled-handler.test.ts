/**
 * Bundled handler tests - actual IDKit execution with DOM and controlled requests.
 * 
 * Tests real bundled SDK exports, DOM interactions, and HTTP flows.
 * NOT string-search or wholly-mocked SDK tests.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Create controlled fetch mock
function createControlledFetchMock() {
  const responses = new Map<string, any>();
  
  const mockFetch = async (urlInput: string | URL) => {
    const url = typeof urlInput === 'string' ? urlInput : urlInput.toString();
    const endpoint = url.split('?')[0]; // Strip query params
    
    const response = responses.get(endpoint);
    if (response) {
      return response;
    }
    
    // Default 404
    return {
      ok: false,
      status: 404,
      json: async () => ({ error: 'Not found' }),
    };
  };
  
  return {
    mock: mockFetch,
    setResponse: (endpoint: string, response: any) => {
      responses.set(endpoint, response);
    },
    clear: () => {
      responses.clear();
    },
  };
}

// Create DOM environment with bundled scripts
async function createBundledDOMEnvironment(options: {
  hasTelegramWebApp?: boolean;
  initData?: string;
} = {}) {
  // Load actual HTML
  const html = readFileSync(join(__dirname, '../../dist/ui/enrollment.html'), 'utf-8');
  
  // Create JSDOM with bundled scripts
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    resources: 'usable',
    url: 'http://localhost:3000/enrollment',
  });
  
  const { window } = dom;
  const { document } = window;
  
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
  
  // Create controlled fetch mock
  const fetchMock = createControlledFetchMock();
  (window as any).fetch = fetchMock.mock;
  
  // Load bundled IDKit (simulate browser loading)
  const idkitBundlePath = join(__dirname, '../../dist/ui/idkit-bundle.js');
  const idkitBundle = readFileSync(idkitBundlePath, 'utf-8');
  const idkitScript = document.createElement('script');
  idkitScript.textContent = idkitBundle;
  idkitScript.type = 'module';
  document.head.appendChild(idkitScript);
  
  // Load QRCode bundle
  const qrcodeBundlePath = join(__dirname, '../../dist/ui/qrcode-bundle.js');
  const qrcode = readFileSync(qrcodeBundlePath, 'utf-8');
  const qrcodeScript = document.createElement('script');
  qrcodeScript.textContent = qrcode;
  document.head.appendChild(qrcodeScript);
  
  // Wait for scripts to execute
  await new Promise(resolve => setTimeout(resolve, 100));
  
  return { window, document, fetchMock };
}

// Wait for async initialization
async function waitForCondition(fn: () => boolean, timeoutMs: number = 2000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timeout waiting for condition');
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

describe('Bundled Handler Tests', () => {
  it('loads bundled IDKit and exposes API', async () => {
    const { window } = await createBundledDOMEnvironment();
    
    // Wait for bundle to load
    await waitForCondition(() => (window as any).WorldIDKit !== undefined);
    
    // Verify IDKit exports
    const worldIdKit = (window as any).WorldIDKit;
    assert.ok(worldIdKit, 'WorldIDKit should be defined');
    assert.ok(worldIdKit.IDKit, 'IDKit should be exported');
    assert.ok(worldIdKit.CredentialRequest, 'CredentialRequest should be exported');
  });

  it('checks enrollment status on initialization with Telegram context', async () => {
    const { window, document, fetchMock } = await createBundledDOMEnvironment({
      hasTelegramWebApp: true,
      initData: 'test_init_data',
    });
    
    // Mock status endpoint response (new user)
    fetchMock.setResponse('/api/enrollment/query', {
      ok: true,
      status: 200,
      json: async () => ({ status: 'new' }),
    });
    
    // Wait for status check to be called
    let statusCheckCalled = false;
    const originalFetch = fetchMock.mock;
    fetchMock.mock = async (url: string | URL) => {
      if (url.toString().includes('/api/enrollment/query')) {
        statusCheckCalled = true;
      }
      return originalFetch(url);
    };
    
    // Trigger initialization by executing page scripts
    const scriptElements = Array.from(document.querySelectorAll('script[type="module"]'));
    for (const script of scriptElements) {
      if (script.textContent) {
        const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
        const scriptFn = new AsyncFunction('window', 'document', 'console', script.textContent);
        await scriptFn(window, document, console);
      }
    }
    
    // Wait for status check
    await waitForCondition(() => statusCheckCalled, 3000);
    
    assert.ok(statusCheckCalled, 'Should call status endpoint on initialization');
  });

  it('handles new enrollment flow with session creation', async () => {
    const { window, document, fetchMock } = await createBundledDOMEnvironment({
      hasTelegramWebApp: true,
      initData: 'test_init_data',
    });
    
    // Mock status endpoint (new user)
    fetchMock.setResponse('/api/enrollment/query', {
      ok: true,
      status: 200,
      json: async () => ({ status: 'new' }),
    });
    
    // Mock challenge creation
    fetchMock.setResponse('/api/challenge/create', {
      ok: true,
      status: 200,
      json: async () => ({
        appId: 'app_test',
        rpId: 'rp_test',
        signal: 'telegram:12345',
        signedChallenge: {
          action: 'test-action',
          nonce: 'test-nonce-123',
          createdAt: Math.floor(Date.now() / 1000),
          expiresAt: Math.floor(Date.now() / 1000) + 300,
          signature: '0x1234567890abcdef',
        },
      }),
    });
    
    let challengeCreateCalled = false;
    let requestParams: any = null;
    
    // Mock IDKit.request to capture parameters
    await waitForCondition(() => (window as any).WorldIDKit !== undefined);
    const originalIDKit = (window as any).WorldIDKit.IDKit;
    
    (window as any).WorldIDKit.IDKit = {
      request: (params: any) => {
        challengeCreateCalled = true;
        requestParams = params;
        
        // Return mock request object
        return {
          constraints: (constraint: any) => ({
            connectorURI: 'worldapp://verify?test=1',
            pollUntilCompletion: async () => ({
              success: false,
              error: 'test_stopped',
            }),
          }),
        };
      },
      proveSession: originalIDKit?.proveSession,
    };
    
    // Execute page scripts
    const scriptElements = Array.from(document.querySelectorAll('script[type="module"]'));
    for (const script of scriptElements) {
      if (script.textContent) {
        const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
        const scriptFn = new AsyncFunction('window', 'document', 'console', script.textContent);
        await scriptFn(window, document, console);
      }
    }
    
    // Trigger verification (simulates button click)
    const buttonEl = document.querySelector('button');
    if (buttonEl && buttonEl.onclick) {
      await (buttonEl.onclick as any).call(buttonEl, {});
    }
    
    // Wait for challenge create and IDKit.request
    await waitForCondition(() => challengeCreateCalled, 5000);
    
    assert.ok(challengeCreateCalled, 'Should call IDKit.request for new enrollment');
    assert.ok(requestParams, 'Should pass parameters to IDKit.request');
    assert.strictEqual(requestParams.session_id, 'create', 'Should use session_id: create for new enrollment');
    assert.strictEqual(requestParams.allow_legacy_proofs, false, 'Should set allow_legacy_proofs: false');
  });

  it('handles returning user renewal flow with proveSession', async () => {
    const { window, document, fetchMock } = await createBundledDOMEnvironment({
      hasTelegramWebApp: true,
      initData: 'test_init_data',
    });
    
    const savedSessionId = 'session_' + 'a'.repeat(128);
    
    // Mock status endpoint (returning user)
    fetchMock.setResponse('/api/enrollment/query', {
      ok: true,
      status: 200,
      json: async () => ({
        status: 'renewal',
        sessionId: savedSessionId,
        expiresAt: Math.floor(Date.now() / 1000) + 86400,
        expired: false,
      }),
    });
    
    // Mock session challenge creation
    fetchMock.setResponse('/api/session/challenge/create', {
      ok: true,
      status: 200,
      json: async () => ({
        appId: 'app_test',
        rpId: 'rp_test',
        signedChallenge: {
          nonce: 'session-nonce-123',
          createdAt: Math.floor(Date.now() / 1000),
          expiresAt: Math.floor(Date.now() / 1000) + 300,
          signature: '0xabcdef1234567890',
        },
      }),
    });
    
    let proveSessionCalled = false;
    let proveSessionId: string | null = null;
    let proveSessionParams: any = null;
    
    // Mock IDKit.proveSession to capture parameters
    await waitForCondition(() => (window as any).WorldIDKit !== undefined);
    
    (window as any).WorldIDKit.IDKit = {
      request: (window as any).WorldIDKit.IDKit.request,
      proveSession: (sessionId: string, params: any) => {
        proveSessionCalled = true;
        proveSessionId = sessionId;
        proveSessionParams = params;
        
        // Return mock request object
        return {
          constraints: (constraint: any) => ({
            connectorURI: 'worldapp://verify?test=1',
            pollUntilCompletion: async () => ({
              success: false,
              error: 'test_stopped',
            }),
          }),
        };
      },
    };
    
    // Execute page scripts
    const scriptElements = Array.from(document.querySelectorAll('script[type="module"]'));
    for (const script of scriptElements) {
      if (script.textContent) {
        const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
        const scriptFn = new AsyncFunction('window', 'document', 'console', script.textContent);
        await scriptFn(window, document, console);
      }
    }
    
    // Trigger verification
    const buttonEl = document.querySelector('button');
    if (buttonEl && buttonEl.onclick) {
      await (buttonEl.onclick as any).call(buttonEl, {});
    }
    
    // Wait for proveSession call
    await waitForCondition(() => proveSessionCalled, 5000);
    
    assert.ok(proveSessionCalled, 'Should call IDKit.proveSession for returning user');
    assert.strictEqual(proveSessionId, savedSessionId, 'Should pass saved session ID to proveSession');
    assert.ok(proveSessionParams, 'Should pass parameters to proveSession');
    assert.ok(proveSessionParams.app_id, 'Should include app_id');
    assert.ok(proveSessionParams.rp_context, 'Should include rp_context');
  });

  it('handles reactivation flow with explicit mode', async () => {
    const { window, document, fetchMock } = await createBundledDOMEnvironment({
      hasTelegramWebApp: true,
      initData: 'test_init_data',
    });
    
    const savedSessionId = 'session_' + 'b'.repeat(128);
    
    // Mock status endpoint (revoked user)
    fetchMock.setResponse('/api/enrollment/query', {
      ok: true,
      status: 200,
      json: async () => ({
        status: 'reactivation',
        sessionId: savedSessionId,
        expiresAt: Math.floor(Date.now() / 1000) - 1000, // Expired
      }),
    });
    
    let sessionChallengeParams: any = null;
    
    // Intercept session challenge request to verify mode parameter
    const originalFetch = fetchMock.mock;
    (window as any).fetch = async (url: string | URL, options?: any) => {
      const urlStr = url.toString();
      if (urlStr.includes('/api/session/challenge/create') && options?.body) {
        try {
          sessionChallengeParams = JSON.parse(options.body);
        } catch {}
      }
      return originalFetch(url);
    };
    
    // Mock session challenge creation
    fetchMock.setResponse('/api/session/challenge/create', {
      ok: true,
      status: 200,
      json: async () => ({
        appId: 'app_test',
        signedChallenge: {
          nonce: 'reactivation-nonce-123',
          createdAt: Math.floor(Date.now() / 1000),
          expiresAt: Math.floor(Date.now() / 1000) + 300,
          signature: '0xfedcba0987654321',
        },
      }),
    });
    
    // Mock proveSession
    (window as any).WorldIDKit = {
      IDKit: {
        proveSession: () => ({
          constraints: () => ({
            connectorURI: 'worldapp://verify?test=1',
            pollUntilCompletion: async () => ({ success: false, error: 'test_stopped' }),
          }),
        }),
      },
      CredentialRequest: () => ({}),
    };
    
    // Execute page scripts
    const scriptElements = Array.from(document.querySelectorAll('script[type="module"]'));
    for (const script of scriptElements) {
      if (script.textContent) {
        const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
        const scriptFn = new AsyncFunction('window', 'document', 'console', script.textContent);
        await scriptFn(window, document, console);
      }
    }
    
    // Trigger verification
    const buttonEl = document.querySelector('button');
    if (buttonEl && buttonEl.onclick) {
      await (buttonEl.onclick as any).call(buttonEl, {});
    }
    
    // Wait for session challenge request
    await waitForCondition(() => sessionChallengeParams !== null, 5000);
    
    assert.ok(sessionChallengeParams, 'Should call session challenge endpoint');
    assert.strictEqual(sessionChallengeParams.mode, 'reactivation', 'Should pass mode=reactivation for revoked enrollment');
  });

  it('never displays or logs session ID', async () => {
    const { window, document, fetchMock } = await createBundledDOMEnvironment({
      hasTelegramWebApp: true,
      initData: 'test_init_data',
    });
    
    const savedSessionId = 'session_' + 'c'.repeat(128);
    
    // Mock status endpoint with session ID
    fetchMock.setResponse('/api/enrollment/query', {
      ok: true,
      status: 200,
      json: async () => ({
        status: 'renewal',
        sessionId: savedSessionId,
        expiresAt: Math.floor(Date.now() / 1000) + 86400,
      }),
    });
    
    // Capture console logs
    const logs: string[] = [];
    const originalConsoleLog = console.log;
    console.log = (...args: any[]) => {
      logs.push(args.join(' '));
      originalConsoleLog(...args);
    };
    
    // Execute page scripts
    const scriptElements = Array.from(document.querySelectorAll('script[type="module"]'));
    for (const script of scriptElements) {
      if (script.textContent) {
        const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
        const scriptFn = new AsyncFunction('window', 'document', 'console', script.textContent);
        await scriptFn(window, document, console);
      }
    }
    
    // Wait for initialization
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Restore console
    console.log = originalConsoleLog;
    
    // Check document body for session ID
    const bodyText = document.body.textContent || '';
    assert.ok(!bodyText.includes(savedSessionId), 'Session ID should not appear in document body');
    
    // Check console logs for session ID
    const allLogs = logs.join(' ');
    assert.ok(!allLogs.includes(savedSessionId), 'Session ID should not appear in console logs');
    
    // Check localStorage (should not be used)
    const localStorage = (window as any).localStorage;
    if (localStorage) {
      const keys = Object.keys(localStorage);
      for (const key of keys) {
        const value = localStorage.getItem(key) || '';
        assert.ok(!value.includes(savedSessionId), `Session ID should not be in localStorage[${key}]`);
        assert.ok(!value.includes('session_'), `No session_ prefix in localStorage[${key}]`);
      }
    }
  });
});
