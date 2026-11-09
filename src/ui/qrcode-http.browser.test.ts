/**
 * HTTP Integration Test: QR Code Generation and Decode
 * 
 * Tests real HTTP server serving actual enrollment page and bundled scripts.
 * Verifies QR code renders and decodes to exact connectorURI over HTTP.
 */

import { test, expect } from '@playwright/test';
import { EnrollmentService } from '../enrollment-service-production.js';
import { HttpService } from '../http-service.js';
import { InMemoryEnrollmentStore } from '../enrollment-store.js';
import { WorldIdVerifierStub } from '../verifier-stub.js';
import jsQR from 'jsqr';

// Mock Telegram bot handler to enable enrollment routes
class MockTelegramBotHandler {
  validateWebhook() { return true; }
  async handleUpdate() {}
  async getSessionInfo(sessionId: string) {
    return {
      signedChallenge: {
        appId: 'test-app',
        rpId: 'test-rp',
        nonce: '0xtest',
        createdAt: Math.floor(Date.now() / 1000),
        expiresAt: Math.floor(Date.now() / 1000) + 300,
        signature: '0xsig',
        action: 'test-action',
        signalHash: '0xhash',
        environment: 'staging',
      },
      appId: 'test-app',
      rpId: 'test-rp',
      signal: 'test-signal',
    };
  }
}

test.describe('QR Code HTTP Integration', () => {
  let httpService: HttpService;
  let enrollmentService: EnrollmentService;
  const TEST_PORT = 0; // Let OS assign an available port
  let BASE_URL: string;

  test.beforeAll(async () => {
    // Setup real HTTP service with mock bot handler to enable enrollment routes
    const store = new InMemoryEnrollmentStore();
    const verifier = new WorldIdVerifierStub();
    
    enrollmentService = new EnrollmentService({
      enrollmentStore: store,
      worldIdVerifier: verifier,
      requireProofOfHuman: true,
      enrollmentTTLSeconds: 3600,
      action: 'test-action',
      rpId: 'test-rp',
    });

    httpService = new HttpService({
      enrollmentService,
      telegramBotHandler: new MockTelegramBotHandler() as any,
      port: TEST_PORT,
      host: '127.0.0.1',
    });

    await httpService.start();
    
    // Get the actual assigned port and set BASE_URL
    const actualPort = httpService.getActualPort();
    BASE_URL = `http://127.0.0.1:${actualPort}`;
  });

  test.afterAll(async () => {
    await httpService.stop();
  });

  test('serves QR bundle over HTTP with correct MIME type', async ({ request }) => {
    const response = await request.get(`${BASE_URL}/qrcode-bundle.js`);
    
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('application/javascript');
    
    const body = await response.text();
    expect(body.length).toBeGreaterThan(10000); // Should be ~25KB
    expect(body).toContain('QRCode'); // Should contain QR library
  });

  test('serves IDKit bundle over HTTP', async ({ request }) => {
    const response = await request.get(`${BASE_URL}/idkit-bundle.js`);
    
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('application/javascript');
  });

  test('serves enrollment page over HTTP', async ({ request }) => {
    const response = await request.get(`${BASE_URL}/enrollment`);
    
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('text/html');
    
    const html = await response.text();
    expect(html).toContain('/qrcode-bundle.js'); // Should import QR bundle
    expect(html).toContain('/idkit-bundle.js'); // Should import IDKit bundle
  });

  test('loads enrollment page in browser without 404 errors', async ({ page }) => {
    const consoleErrors: string[] = [];
    const networkErrors: string[] = [];

    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    page.on('response', response => {
      if (response.status() === 404) {
        networkErrors.push(`404: ${response.url()}`);
      }
    });

    await page.goto(`${BASE_URL}/enrollment`, { waitUntil: 'networkidle' });

    // Verify no 404s
    expect(networkErrors).toEqual([]);
    
    // Verify no critical console errors (allow World ID SDK errors)
    const criticalErrors = consoleErrors.filter(err => 
      !err.includes('World') && !err.includes('IDKit')
    );
    expect(criticalErrors).toEqual([]);

    // Verify page loaded
    await expect(page.locator('body')).toBeVisible();
  });

  test('renders QR code and decodes to exact synthetic connectorURI', async ({ page }) => {
    // Synthetic connectorURI shaped like World verify URL
    const syntheticConnectorURI = 'https://world.org/verify?t=wld&i=550e8400-e29b-41d4-a716-446655440000&k=YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY3ODkwKy89';

    await page.goto(`${BASE_URL}/enrollment`);

    // Wait for page to load
    await page.waitForLoadState('networkidle');

    // Inject synthetic connectorURI and trigger QR generation
    await page.evaluate(async (uri) => {
      // Create container
      const container = document.createElement('div');
      container.id = 'test-qr-container';
      document.body.appendChild(container);

      // Call QR generation function directly
      // @ts-ignore - enrollment.html exposes this on window
      if (typeof window.generateQRCode === 'function') {
        await window.generateQRCode(uri, container);
      }
    }, syntheticConnectorURI);

    // Wait for QR canvas to render
    await page.waitForSelector('#test-qr-container canvas', { timeout: 5000 });

    // Extract canvas image data
    const imageData = await page.evaluate(() => {
      const canvas = document.querySelector('#test-qr-container canvas') as HTMLCanvasElement;
      if (!canvas) throw new Error('Canvas not found');

      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas context not found');

      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      return {
        data: Array.from(imgData.data),
        width: imgData.width,
        height: imgData.height,
      };
    });

    // Decode QR code using independent decoder
    const decoded = jsQR(
      new Uint8ClampedArray(imageData.data),
      imageData.width,
      imageData.height
    );

    // Verify QR decoded successfully
    if (!decoded || !decoded.data) {
      console.error('QR decode failed. Canvas may not have rendered.');
      throw new Error(`QR decode failed: decoded=${decoded}`);
    }
    
    // CRITICAL: Verify exact URI match
    expect(decoded.data).toBe(syntheticConnectorURI);
  });

  test('QR decoding preserves base64 special characters', async ({ page }) => {
    const uriWithSpecialChars = 'https://world.org/verify?t=wld&i=test-uuid&k=ABC+def/123==';

    await page.goto(`${BASE_URL}/enrollment`);
    await page.waitForLoadState('networkidle');

    await page.evaluate(async (uri) => {
      const container = document.createElement('div');
      container.id = 'test-special-chars-qr';
      document.body.appendChild(container);

      // @ts-ignore - enrollment.html exposes this on window
      if (typeof window.generateQRCode === 'function') {
        await window.generateQRCode(uri, container);
      }
    }, uriWithSpecialChars);

    await page.waitForSelector('#test-special-chars-qr canvas', { timeout: 5000 });

    const imageData = await page.evaluate(() => {
      const canvas = document.querySelector('#test-special-chars-qr canvas') as HTMLCanvasElement;
      const ctx = canvas?.getContext('2d');
      if (!ctx) throw new Error('Canvas context not found');

      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      return {
        data: Array.from(imgData.data),
        width: imgData.width,
        height: imgData.height,
      };
    });

    const decoded = jsQR(
      new Uint8ClampedArray(imageData.data),
      imageData.width,
      imageData.height
    );

    expect(decoded?.data).toBe(uriWithSpecialChars);
    expect(decoded?.data).toContain('+');
    expect(decoded?.data).toContain('/');
    expect(decoded?.data).toContain('==');
  });

  test('QR bundle imports without errors', async ({ page }) => {
    const consoleErrors: string[] = [];

    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    await page.goto(`${BASE_URL}/enrollment`);
    await page.waitForLoadState('networkidle');

    // Import QR bundle explicitly
    const importSuccess = await page.evaluate(async () => {
      try {
        const module = await import('/qrcode-bundle.js');
        return module.QRCode !== undefined;
      } catch (error) {
        console.error('QR bundle import failed:', error);
        return false;
      }
    });

    expect(importSuccess).toBe(true);

    // Check for import errors
    const importErrors = consoleErrors.filter(err => 
      err.includes('qrcode-bundle') || err.includes('import')
    );
    expect(importErrors).toEqual([]);
  });

  test('enrollment page generateQRCode function exists', async ({ page }) => {
    await page.goto(`${BASE_URL}/enrollment`);
    await page.waitForLoadState('networkidle');

    const hasFn = await page.evaluate(() => {
      return typeof (window as any).generateQRCode === 'function';
    });

    expect(hasFn).toBe(true);
  });
});
