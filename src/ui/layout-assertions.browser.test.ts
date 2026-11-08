/**
 * Layout Assertions with Real Screenshots and Bounding Rect Evidence
 * 
 * Tests actual HTTP-served UI at specified viewports with:
 * - Real screenshots
 * - Bounding rect measurements
 * - Scroll position metrics
 * - Independent QR decode at rendered sizes
 */

import { test, expect } from '@playwright/test';
import { EnrollmentService } from '../enrollment-service-production.js';
import { HttpService } from '../http-service.js';
import { InMemoryEnrollmentStore } from '../enrollment-store.js';
import { WorldIdVerifierStub } from '../verifier-stub.js';
import jsQR from 'jsqr';

const TEST_PORT = 18086;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

class MockTelegramBotHandler {
  validateWebhook() { return true; }
  async handleUpdate() {}
  async getSessionInfo(sessionId: string) {
    // Return session info matching enrollment service expectations
    return {
      signedChallenge: {
        app_id: 'app_test_layout',
        rp_id: 'rp_test_layout',
        nonce: sessionId,
        created_at: Math.floor(Date.now() / 1000),
        expires_at: Math.floor(Date.now() / 1000) + 300,
        signature: '0x' + '0'.repeat(130), // Valid signature format
        action: 'test-layout',
        signal_hash: '0x00c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a4',
        environment: 'staging',
      },
      appId: 'app_test_layout',
      rpId: 'rp_test_layout',
      signal: 'test-user-signal',
    };
  }
}

// Configure Playwright to run tests serially to avoid port conflicts
test.describe.configure({ mode: 'serial' });

test.describe('Layout Assertions with Screenshots', () => {
  let httpService: HttpService;
  let enrollmentService: EnrollmentService;

  test.beforeAll(async () => {
    const store = new InMemoryEnrollmentStore();
    const verifier = new WorldIdVerifierStub();
    
    enrollmentService = new EnrollmentService({
      enrollmentStore: store,
      worldIdVerifier: verifier,
      requireProofOfHuman: true,
      enrollmentTTLSeconds: 3600,
      action: 'test-layout',
      rpId: 'test-rp-layout',
    });

    httpService = new HttpService({
      enrollmentService,
      telegramBotHandler: new MockTelegramBotHandler() as any,
      port: TEST_PORT,
      host: '127.0.0.1',
    });
    
    await httpService.start();
    
    // Wait for server to be ready
    await new Promise(resolve => setTimeout(resolve, 500));
  });

  test.afterAll(async () => {
    if (httpService) {
      await httpService.stop();
    }
  })

  async function captureLayoutMetrics(page: any, viewportName: string) {
    const viewport = page.viewportSize();
    
    const scrollMetrics = await page.evaluate(() => ({
      scrollTop: document.documentElement.scrollTop,
      scrollLeft: document.documentElement.scrollLeft,
      scrollHeight: document.documentElement.scrollHeight,
      scrollWidth: document.documentElement.scrollWidth,
      clientHeight: document.documentElement.clientHeight,
      clientWidth: document.documentElement.clientWidth,
    }));

    const heading = await page.locator('h1').boundingBox();
    const subtitle = await page.locator('.subtitle').boundingBox();
    const qrCode = await page.locator('#qrCode canvas').boundingBox();
    const qrInstruction = await page.locator('.qr-instruction').boundingBox();
    const connectorLink = await page.locator('#connectorLink').boundingBox();
    const container = await page.locator('.container').boundingBox();

    console.log(`\n=== ${viewportName} Layout Metrics ===`);
    console.log(`Viewport: ${viewport.width}x${viewport.height}`);
    console.log(`Scroll: top=${scrollMetrics.scrollTop}, left=${scrollMetrics.scrollLeft}`);
    console.log(`Client: ${scrollMetrics.clientWidth}x${scrollMetrics.clientHeight}`);
    console.log(`ScrollDims: ${scrollMetrics.scrollWidth}x${scrollMetrics.scrollHeight}`);
    
    if (qrCode) {
      console.log(`QR: ${Math.round(qrCode.width)}x${Math.round(qrCode.height)} at y=${Math.round(qrCode.y)}`);
    }
    
    if (connectorLink) {
      console.log(`Button: ${Math.round(connectorLink.width)}x${Math.round(connectorLink.height)} at y=${Math.round(connectorLink.y)}`);
      console.log(`Button bottom: ${Math.round(connectorLink.y + connectorLink.height)} / ${viewport.height}`);
    }

    return { viewport, scroll: scrollMetrics, heading, subtitle, qrCode, qrInstruction, connectorLink, container };
  }

  async function verifyQRDecode(page: any, viewportName: string) {
    const qrData = await page.evaluate(() => {
      const canvas = document.querySelector('#qrCode canvas') as HTMLCanvasElement;
      if (!canvas) return null;
      
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      return {
        data: Array.from(imageData.data),
        width: imageData.width,
        height: imageData.height,
      };
    });

    if (!qrData) return false;

    const uint8Data = new Uint8ClampedArray(qrData.data);
    const decoded = jsQR(uint8Data, qrData.width, qrData.height);

    if (decoded) {
      console.log(`${viewportName}: QR decode SUCCESS at ${qrData.width}x${qrData.height}px, length=${decoded.data.length}`);
      return true;
    } else {
      console.log(`${viewportName}: QR decode FAILED at ${qrData.width}x${qrData.height}px`);
      return false;
    }
  }

  test('Phone 320x568: Layout assertions and screenshot', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    
    // Block the real Telegram SDK and serve empty response
    await page.route('https://telegram.org/js/telegram-web-app.js', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        body: '// Telegram SDK blocked for testing',
      });
    });
    
    // Mock Telegram WebApp SDK before page load
    await page.addInitScript(() => {
      (window as any).Telegram = {
        WebApp: {
          initData: 'user=%7B%22id%22%3A123456%7D&auth_date=1700000000&hash=abc123',
          initDataUnsafe: {
            user: { id: 123456, first_name: 'Test' },
            auth_date: 1700000000,
          },
          ready: () => {},
          expand: () => {},
          close: () => {},
          MainButton: { show: () => {}, hide: () => {}, setText: () => {} },
          BackButton: { show: () => {}, hide: () => {} },
        },
      };
    });
    
    const sessionId = `session-320-${Date.now()}`;
    
    // Capture console logs for debugging
    page.on('console', msg => console.log('Browser log:', msg.text()));
    
    await page.goto(`${BASE_URL}/enrollment?session=${sessionId}`);
    await page.waitForSelector('h1');
    
    // Wait for page to settle
    await page.waitForTimeout(2000);
    
    // Debug: Check if Telegram mock exists and initData value
    const debugInfo = await page.evaluate(() => {
      return {
        hasTelegram: typeof (window as any).Telegram !== 'undefined',
        hasWebApp: typeof (window as any).Telegram?.WebApp !== 'undefined',
        initData: (window as any).Telegram?.WebApp?.initData,
        initDataLength: (window as any).Telegram?.WebApp?.initData?.length,
      };
    });
    console.log('Debug info:', debugInfo);
    
    await page.screenshot({
      path: '/opt/cursor/artifacts/layout-before-320x568.png',
      fullPage: false,
    });

    // Check what status is shown
    const statusText = await page.locator('#status').textContent();
    console.log('Status text:', statusText);
    
    const verifyButton = page.locator('#verifyButton');
    const buttonClasses = await verifyButton.getAttribute('class');
    console.log('Button classes:', buttonClasses);
    
    await expect(verifyButton).toBeVisible({ timeout: 10000 });
    
    // Generate real QR code using production generateQRCode function
    const testConnectorURI = 'wc:test-connector-320x568@2?relay-protocol=irn&symKey=abcdef1234567890';
    
    await page.evaluate(async (connectorURI) => {
      const connectorDisplay = document.getElementById('connectorDisplay');
      const qrCodeEl = document.getElementById('qrCode');
      const connectorLink = document.getElementById('connectorLink');
      
      if (connectorDisplay && qrCodeEl && connectorLink && (window as any).generateQRCode) {
        // Call production generateQRCode function
        await (window as any).generateQRCode(connectorURI, qrCodeEl);
        
        connectorLink.href = connectorURI;
        connectorLink.textContent = 'Or tap to open on this device';
        connectorDisplay.classList.remove('hidden');
        document.getElementById('verifyButton')?.classList.add('hidden');
        
        const statusEl = document.getElementById('status');
        if (statusEl) {
          statusEl.textContent = 'Scan QR code with World App on your phone';
          statusEl.className = 'success';
        }
      }
    }, testConnectorURI);
    
    await page.waitForTimeout(500); // Let QR generation complete
    
    // Verify QR code can be decoded back to original connectorURI
    const decodedURI = await page.evaluate(() => {
      const qrCodeEl = document.getElementById('qrCode');
      const canvas = qrCodeEl?.querySelector('canvas');
      if (!canvas) return null;
      
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      
      // jsQR is available in browser context via CDN or bundle
      // For testing, we'll extract imageData and decode in Node
      return {
        data: Array.from(imageData.data),
        width: imageData.width,
        height: imageData.height
      };
    });
    
    if (decodedURI) {
      const imageData = {
        data: new Uint8ClampedArray(decodedURI.data),
        width: decodedURI.width,
        height: decodedURI.height
      };
      const code = jsQR(imageData.data, imageData.width, imageData.height);
      expect(code).not.toBeNull();
      expect(code?.data).toBe(testConnectorURI);
    }

    await page.screenshot({
      path: '/opt/cursor/artifacts/layout-after-320x568.png',
      fullPage: false,
    });

    const metrics = await captureLayoutMetrics(page, '320x568');

    // ASSERTIONS
    expect(metrics.scroll.scrollWidth).toBeLessThanOrEqual(320 + 2);
    expect(metrics.connectorLink).not.toBeNull();
    expect(metrics.connectorLink!.y + metrics.connectorLink!.height).toBeLessThanOrEqual(568);
    expect(metrics.qrCode).not.toBeNull();
    expect(metrics.qrCode!.width).toBeGreaterThanOrEqual(100);
  });

  test('Phone 390x844: Layout assertions and screenshot', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    
    await page.route('https://telegram.org/js/telegram-web-app.js', route => {
      route.fulfill({ status: 200, contentType: 'application/javascript', body: '// Telegram SDK blocked for testing' });
    });
    
    await page.addInitScript(() => {
      (window as any).Telegram = {
        WebApp: {
          initData: 'user=%7B%22id%22%3A123456%7D&auth_date=1700000000&hash=abc123',
          initDataUnsafe: { user: { id: 123456, first_name: 'Test' }, auth_date: 1700000000 },
          ready: () => {}, expand: () => {}, close: () => {},
          MainButton: { show: () => {}, hide: () => {}, setText: () => {} },
          BackButton: { show: () => {}, hide: () => {} },
        },
      };
    });
    
    const sessionId = `session-390-${Date.now()}`;
    await page.goto(`${BASE_URL}/enrollment?session=${sessionId}`);
    await page.waitForSelector('h1');
    await page.waitForTimeout(1000);
    
    await page.screenshot({
      path: '/opt/cursor/artifacts/layout-before-390x844.png',
      fullPage: false,
    });

    await expect(page.locator('#verifyButton')).toBeVisible({ timeout: 5000 });
    
    const testConnectorURI2 = 'wc:test-connector-844x390@2?relay-protocol=irn&symKey=fedcba9876543210';
    await page.evaluate(async (connectorURI) => {
      const connectorDisplay = document.getElementById('connectorDisplay');
      const qrCodeEl = document.getElementById('qrCode');
      const connectorLink = document.getElementById('connectorLink');
      if (connectorDisplay && qrCodeEl && connectorLink && (window as any).generateQRCode) {
        await (window as any).generateQRCode(connectorURI, qrCodeEl);
        connectorLink.href = connectorURI;
        connectorLink.textContent = 'Or tap to open on this device';
        connectorDisplay.classList.remove('hidden');
        document.getElementById('verifyButton')?.classList.add('hidden');
        const statusEl = document.getElementById('status');
        if (statusEl) {
          statusEl.textContent = 'Scan QR code with World App on your phone';
          statusEl.className = 'success';
        }
      }
    }, testConnectorURI2);
    await page.waitForTimeout(500);
    await page.waitForTimeout(500);

    await page.screenshot({
      path: '/opt/cursor/artifacts/layout-after-390x844.png',
      fullPage: false,
    });

    const metrics = await captureLayoutMetrics(page, '390x844');
    expect(metrics.scroll.scrollWidth).toBeLessThanOrEqual(390 + 2);
    expect(metrics.connectorLink).not.toBeNull();
    expect(metrics.connectorLink!.y + metrics.connectorLink!.height).toBeLessThanOrEqual(844);
    expect(metrics.qrCode).not.toBeNull();
  });

  test('Landscape 667x375: Layout assertions and screenshot', async ({ page }) => {
    await page.setViewportSize({ width: 667, height: 375 });
    await page.route('https://telegram.org/js/telegram-web-app.js', route => {
      route.fulfill({ status: 200, contentType: 'application/javascript', body: '// Blocked' });
    });
    await page.addInitScript(() => {
      (window as any).Telegram = {
        WebApp: {
          initData: 'user=%7B%22id%22%3A123456%7D&auth_date=1700000000&hash=abc123',
          initDataUnsafe: { user: { id: 123456 }, auth_date: 1700000000 },
          ready: () => {}, expand: () => {}, close: () => {},
          MainButton: { show: () => {}, hide: () => {} },
          BackButton: { show: () => {}, hide: () => {} },
        },
      };
    });
    const sessionId = `session-667-${Date.now()}`;
    await page.goto(`${BASE_URL}/enrollment?session=${sessionId}`);
    await page.waitForSelector('h1');
    await page.waitForTimeout(1000);
    await page.screenshot({ path: '/opt/cursor/artifacts/layout-before-667x375.png', fullPage: false });
    await expect(page.locator('#verifyButton')).toBeVisible({ timeout: 5000 });
    const testConnectorURI3 = 'wc:test-connector-667x375@2?relay-protocol=irn&symKey=abc1234567890def';
    await page.evaluate(async (connectorURI) => {
      const connectorDisplay = document.getElementById('connectorDisplay');
      const qrCodeEl = document.getElementById('qrCode');
      const connectorLink = document.getElementById('connectorLink');
      if (connectorDisplay && qrCodeEl && connectorLink && (window as any).generateQRCode) {
        await (window as any).generateQRCode(connectorURI, qrCodeEl);
        connectorLink.href = connectorURI;
        connectorLink.textContent = 'Or tap to open on this device';
        connectorDisplay.classList.remove('hidden');
        document.getElementById('verifyButton')?.classList.add('hidden');
        const statusEl = document.getElementById('status');
        if (statusEl) {
          statusEl.textContent = 'Scan QR code with World App';
          statusEl.className = 'success';
        }
      }
    }, testConnectorURI3);
    await page.waitForTimeout(500);
    await page.waitForTimeout(500);
    await page.screenshot({ path: '/opt/cursor/artifacts/layout-after-667x375.png', fullPage: false });
    const metrics = await captureLayoutMetrics(page, '667x375');
    expect(metrics.scroll.scrollWidth).toBeLessThanOrEqual(667 + 2);
    expect(metrics.connectorLink).not.toBeNull();
    // STRICT: Button must fit entirely within viewport, no scrolling required
    expect(metrics.connectorLink!.y + metrics.connectorLink!.height).toBeLessThanOrEqual(375);
    expect(metrics.qrCode).not.toBeNull();
  });

  test('Desktop 1280x800: Layout assertions and screenshot', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.route('https://telegram.org/js/telegram-web-app.js', route => {
      route.fulfill({ status: 200, contentType: 'application/javascript', body: '// Blocked' });
    });
    await page.addInitScript(() => {
      (window as any).Telegram = {
        WebApp: {
          initData: 'user=%7B%22id%22%3A123456%7D&auth_date=1700000000&hash=abc123',
          initDataUnsafe: { user: { id: 123456 }, auth_date: 1700000000 },
          ready: () => {}, expand: () => {}, close: () => {},
          MainButton: { show: () => {}, hide: () => {} },
          BackButton: { show: () => {}, hide: () => {} },
        },
      };
    });
    const sessionId = `session-1280-${Date.now()}`;
    await page.goto(`${BASE_URL}/enrollment?session=${sessionId}`);
    await page.waitForSelector('h1');
    await page.waitForTimeout(1000);
    await page.screenshot({ path: '/opt/cursor/artifacts/layout-before-1280x800.png', fullPage: false });
    await expect(page.locator('#verifyButton')).toBeVisible({ timeout: 5000 });
    const testConnectorURI4 = 'wc:test-connector-1280x800@2?relay-protocol=irn&symKey=1234567890abcdef';
    await page.evaluate(async (connectorURI) => {
      const connectorDisplay = document.getElementById('connectorDisplay');
      const qrCodeEl = document.getElementById('qrCode');
      const connectorLink = document.getElementById('connectorLink');
      if (connectorDisplay && qrCodeEl && connectorLink && (window as any).generateQRCode) {
        await (window as any).generateQRCode(connectorURI, qrCodeEl);
        connectorLink.href = connectorURI;
        connectorLink.textContent = 'Or tap to open on this device';
        connectorDisplay.classList.remove('hidden');
        document.getElementById('verifyButton')?.classList.add('hidden');
        const statusEl = document.getElementById('status');
        if (statusEl) {
          statusEl.textContent = 'Scan QR code with World App';
          statusEl.className = 'success';
        }
      }
    }, testConnectorURI4);
    await page.waitForTimeout(500);
    await page.waitForTimeout(500);
    await page.screenshot({ path: '/opt/cursor/artifacts/layout-after-1280x800.png', fullPage: false });
    const metrics = await captureLayoutMetrics(page, '1280x800');
    expect(metrics.scroll.scrollWidth).toBeLessThanOrEqual(1280 + 2);
    expect(metrics.connectorLink).not.toBeNull();
    expect(metrics.connectorLink!.y + metrics.connectorLink!.height).toBeLessThanOrEqual(800);
    expect(metrics.qrCode).not.toBeNull();
    expect(metrics.qrCode!.width).toBeLessThanOrEqual(300);
  });

  test('orientation transition: portrait to landscape maintains strict fit', async ({ page }) => {
    const sessionId = `test-orientation-${Date.now()}`;
    
    // Start in portrait (375x667 - iPhone 8)
    await page.setViewportSize({ width: 375, height: 667 });
    
    await page.route('https://telegram.org/js/telegram-web-app.js', route => {
      route.fulfill({ status: 200, contentType: 'application/javascript', body: '// Telegram SDK blocked for testing' });
    });
    
    await page.addInitScript(() => {
      (window as any).Telegram = {
        WebApp: {
          initData: 'user=%7B%22id%22%3A123456%7D&auth_date=1700000000&hash=abc123',
          initDataUnsafe: { user: { id: 123456, first_name: 'Test' }, auth_date: 1700000000 },
          ready: () => {}, expand: () => {}, close: () => {},
          MainButton: { show: () => {}, hide: () => {}, setText: () => {} },
          BackButton: { show: () => {}, hide: () => {} },
        },
      };
    });
    
    await page.goto(`${BASE_URL}/enrollment?session=${sessionId}`);
    await page.waitForSelector('h1');
    await page.waitForTimeout(1000); // Wait for session initialization
    
    // Verify button is visible after session initialization
    await expect(page.locator('#verifyButton')).toBeVisible({ timeout: 5000 });
    
    const testConnectorURI = 'wc:test-orientation@2?relay-protocol=irn&symKey=orientation1234567890';
    
    // Generate QR and wait for completion
    const portraitDecoded = await page.evaluate(async (connectorURI) => {
      const connectorDisplay = document.getElementById('connectorDisplay');
      const qrCodeEl = document.getElementById('qrCode');
      const connectorLink = document.getElementById('connectorLink');
      if (connectorDisplay && qrCodeEl && connectorLink && (window as any).generateQRCode) {
        await (window as any).generateQRCode(connectorURI, qrCodeEl);
        connectorLink.href = connectorURI;
        connectorLink.textContent = 'Or tap to open on this device';
        connectorDisplay.classList.remove('hidden');
        document.getElementById('verifyButton')?.classList.add('hidden');
        const statusEl = document.getElementById('status');
        if (statusEl) {
          statusEl.textContent = 'Scan QR code with World App';
          statusEl.className = 'success';
        }
        
        // Wait for canvas render
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Extract imageData for decode verification
        const canvas = qrCodeEl.querySelector('canvas') as HTMLCanvasElement;
        if (!canvas) return null;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        return {
          data: Array.from(imageData.data),
          width: imageData.width,
          height: imageData.height
        };
      }
      return null;
    }, testConnectorURI);
    
    // Decode portrait QR
    if (portraitDecoded) {
      const imageData = {
        data: new Uint8ClampedArray(portraitDecoded.data),
        width: portraitDecoded.width,
        height: portraitDecoded.height
      };
      const code = jsQR(imageData.data, imageData.width, imageData.height);
      expect(code).not.toBeNull();
      expect(code?.data).toBe(testConnectorURI);
    }
    
    await page.screenshot({ path: '/opt/cursor/artifacts/orientation-portrait-375x667.png', fullPage: false });
    const portraitMetrics = await captureLayoutMetrics(page, 'portrait-375x667');
    
    // Assert strict fit in portrait (no internal overflow)
    const portraitContainer = await page.evaluate(() => {
      const container = document.querySelector('.container') as HTMLElement;
      return container ? {
        scrollHeight: container.scrollHeight,
        clientHeight: container.clientHeight
      } : null;
    });
    expect(portraitContainer).not.toBeNull();
    expect(portraitContainer!.scrollHeight).toBeLessThanOrEqual(portraitContainer!.clientHeight);
    expect(portraitMetrics.connectorLink!.y + portraitMetrics.connectorLink!.height).toBeLessThanOrEqual(667);
    
    // Rotate to landscape (667x375)
    await page.setViewportSize({ width: 667, height: 375 });
    
    // Trigger viewport change handlers and wait for QR regeneration
    const landscapeDecoded = await page.evaluate(async () => {
      window.dispatchEvent(new Event('orientationchange'));
      window.dispatchEvent(new Event('resize'));
      if ('visualViewport' in window && window.visualViewport) {
        window.visualViewport.dispatchEvent(new Event('resize'));
      }
      
      // Wait for QR regeneration to complete
      await new Promise(resolve => setTimeout(resolve, 200));
      
      // Extract imageData after regeneration
      const qrCodeEl = document.getElementById('qrCode');
      if (!qrCodeEl) return null;
      const canvas = qrCodeEl.querySelector('canvas') as HTMLCanvasElement;
      if (!canvas) return null;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      return {
        data: Array.from(imageData.data),
        width: imageData.width,
        height: imageData.height
      };
    });
    
    // Decode landscape QR (verify regeneration worked)
    if (landscapeDecoded) {
      const imageData = {
        data: new Uint8ClampedArray(landscapeDecoded.data),
        width: landscapeDecoded.width,
        height: landscapeDecoded.height
      };
      const code = jsQR(imageData.data, imageData.width, imageData.height);
      expect(code).not.toBeNull();
      expect(code?.data).toBe(testConnectorURI);
    }
    
    await page.screenshot({ path: '/opt/cursor/artifacts/orientation-landscape-667x375.png', fullPage: false });
    const landscapeMetrics = await captureLayoutMetrics(page, 'landscape-667x375');
    
    // Assert strict fit in landscape (no internal overflow)
    const landscapeContainer = await page.evaluate(() => {
      const container = document.querySelector('.container') as HTMLElement;
      return container ? {
        scrollHeight: container.scrollHeight,
        clientHeight: container.clientHeight
      } : null;
    });
    expect(landscapeContainer).not.toBeNull();
    expect(landscapeContainer!.scrollHeight).toBeLessThanOrEqual(landscapeContainer!.clientHeight);
    expect(landscapeMetrics.connectorLink).not.toBeNull();
    expect(landscapeMetrics.qrCode).not.toBeNull();
    expect(landscapeMetrics.connectorLink!.y + landscapeMetrics.connectorLink!.height).toBeLessThanOrEqual(375);
  });

  test('viewport shrink transition maintains accessibility', async ({ page }) => {
    const sessionId = `test-viewport-shrink-${Date.now()}`;
    
    // Start at comfortable size (414x896 - iPhone 11)
    await page.setViewportSize({ width: 414, height: 896 });
    
    await page.route('https://telegram.org/js/telegram-web-app.js', route => {
      route.fulfill({ status: 200, contentType: 'application/javascript', body: '// Telegram SDK blocked for testing' });
    });
    
    await page.addInitScript(() => {
      (window as any).Telegram = {
        WebApp: {
          initData: 'user=%7B%22id%22%3A123456%7D&auth_date=1700000000&hash=abc123',
          initDataUnsafe: { user: { id: 123456, first_name: 'Test' }, auth_date: 1700000000 },
          ready: () => {}, expand: () => {}, close: () => {},
          MainButton: { show: () => {}, hide: () => {}, setText: () => {} },
          BackButton: { show: () => {}, hide: () => {} },
        },
      };
    });
    
    await page.goto(`${BASE_URL}/enrollment?session=${sessionId}`);
    await page.waitForSelector('h1');
    await page.waitForTimeout(1000); // Wait for session initialization
    await expect(page.locator('#verifyButton')).toBeVisible({ timeout: 5000 });
    
    const testConnectorURI = 'wc:test-shrink@2?relay-protocol=irn&symKey=shrink1234567890abcd';
    await page.evaluate(async (connectorURI) => {
      const connectorDisplay = document.getElementById('connectorDisplay');
      const qrCodeEl = document.getElementById('qrCode');
      const connectorLink = document.getElementById('connectorLink');
      if (connectorDisplay && qrCodeEl && connectorLink && (window as any).generateQRCode) {
        await (window as any).generateQRCode(connectorURI, qrCodeEl);
        connectorLink.href = connectorURI;
        connectorLink.textContent = 'Or tap to open on this device';
        connectorDisplay.classList.remove('hidden');
        document.getElementById('verifyButton')?.classList.add('hidden');
        const statusEl = document.getElementById('status');
        if (statusEl) {
          statusEl.textContent = 'Scan QR code with World App';
          statusEl.className = 'success';
        }
      }
    }, testConnectorURI);
    await page.waitForTimeout(500);
    
    await page.screenshot({ path: '/opt/cursor/artifacts/viewport-before-414x896.png', fullPage: false });
    const beforeMetrics = await captureLayoutMetrics(page, 'before-414x896');
    expect(beforeMetrics.connectorLink!.y + beforeMetrics.connectorLink!.height).toBeLessThanOrEqual(896);
    
    // Shrink viewport dramatically (320x480 - very constrained)
    await page.setViewportSize({ width: 320, height: 480 });
    await page.evaluate(() => {
      if ('visualViewport' in window && window.visualViewport) {
        window.dispatchEvent(new Event('resize'));
      }
      window.dispatchEvent(new Event('resize'));
    });
    await page.waitForTimeout(500); // Let layout adapt
    
    await page.screenshot({ path: '/opt/cursor/artifacts/viewport-after-320x480.png', fullPage: false });
    const afterMetrics = await captureLayoutMetrics(page, 'after-320x480');
    
    // Assert all elements still accessible (no overflow)
    expect(afterMetrics.scroll.scrollWidth).toBeLessThanOrEqual(320 + 2);
    expect(afterMetrics.connectorLink).not.toBeNull();
    expect(afterMetrics.qrCode).not.toBeNull();
    // Content must fit within visible viewport
    expect(afterMetrics.connectorLink!.y + afterMetrics.connectorLink!.height).toBeLessThanOrEqual(480);
  });
});
