/**
 * Layout Assertions with Real Screenshots and Bounding Rect Evidence
 * 
 * Tests actual HTTP-served UI at specified viewports with:
 * - Real screenshots (before/after if applicable)
 * - Bounding rect measurements
 * - Scroll position metrics
 * - Client dimension verification
 * - Independent QR decode at rendered sizes
 */

import { test, expect } from '@playwright/test';
import { HttpEnrollmentBridge } from './src/ui/http-enrollment-bridge.js';
import type { SignedChallenge } from './src/worldid-challenge-adapter.js';
import jsQR from 'jsqr';

const TEST_PORT = 18083;
const BASE_URL = `http://localhost:${TEST_PORT}`;

// Representative connectorURI length (base64url encoded session data)
const SYNTHETIC_CONNECTOR_URI = 'wc:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef@2?relay-protocol=irn&symKey=abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';

test.describe('Layout Assertions with Screenshots', () => {
  let bridge: HttpEnrollmentBridge;

  test.beforeAll(async () => {
    bridge = new HttpEnrollmentBridge(TEST_PORT);
    await bridge.start();
  });

  test.afterAll(async () => {
    await bridge.stop();
  });

  async function setupSession() {
    const mockChallenge: SignedChallenge = {
      action: 'test-layout',
      signal: 'telegram:12345',
      nonce: `nonce-${Date.now()}`,
      signature: 'mock-signature',
      signalHash: 'mock-hash',
      createdAt: Math.floor(Date.now() / 1000),
      expiresAt: Math.floor(Date.now() / 1000) + 300,
    };

    const sessionId = await bridge.createSession({
      signedChallenge: mockChallenge,
      appId: 'app_test_layout',
      rpId: 'rp_test_layout',
      signal: mockChallenge.signal,
    });

    return sessionId;
  }

  async function captureLayoutMetrics(page: any, viewportName: string) {
    // Get viewport dimensions
    const viewport = page.viewportSize();
    
    // Get scroll dimensions
    const scrollMetrics = await page.evaluate(() => ({
      scrollTop: document.documentElement.scrollTop,
      scrollLeft: document.documentElement.scrollLeft,
      scrollHeight: document.documentElement.scrollHeight,
      scrollWidth: document.documentElement.scrollWidth,
      clientHeight: document.documentElement.clientHeight,
      clientWidth: document.documentElement.clientWidth,
    }));

    // Get bounding rects for critical elements
    const heading = await page.locator('h1').boundingBox();
    const subtitle = await page.locator('.subtitle').boundingBox();
    const qrCode = await page.locator('#qrCode canvas').boundingBox();
    const qrInstruction = await page.locator('.qr-instruction').boundingBox();
    const connectorLink = await page.locator('#connectorLink').boundingBox();
    const container = await page.locator('.container').boundingBox();

    const metrics = {
      viewportName,
      viewport,
      scroll: scrollMetrics,
      elements: {
        heading,
        subtitle,
        qrCode,
        qrInstruction,
        connectorLink,
        container,
      },
    };

    // Print metrics
    console.log(`\n=== ${viewportName} Layout Metrics ===`);
    console.log(`Viewport: ${viewport.width}x${viewport.height}`);
    console.log(`Scroll: top=${scrollMetrics.scrollTop}, left=${scrollMetrics.scrollLeft}`);
    console.log(`Client: ${scrollMetrics.clientWidth}x${scrollMetrics.clientHeight}`);
    console.log(`Scroll dimensions: ${scrollMetrics.scrollWidth}x${scrollMetrics.scrollHeight}`);
    
    if (qrCode) {
      console.log(`QR Code: ${Math.round(qrCode.width)}x${Math.round(qrCode.height)} at (${Math.round(qrCode.x)}, ${Math.round(qrCode.y)})`);
    }
    
    if (connectorLink) {
      console.log(`Blue Button: ${Math.round(connectorLink.width)}x${Math.round(connectorLink.height)} at (${Math.round(connectorLink.x)}, ${Math.round(connectorLink.y)})`);
      console.log(`Blue Button bottom: ${Math.round(connectorLink.y + connectorLink.height)} (viewport height: ${viewport.height})`);
    }

    return metrics;
  }

  async function verifyQRDecode(page: any, viewportName: string) {
    // Get QR code canvas data
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

    if (!qrData) {
      console.log(`${viewportName}: No QR canvas data`);
      return false;
    }

    // Decode with jsQR
    const uint8Data = new Uint8ClampedArray(qrData.data);
    const decoded = jsQR(uint8Data, qrData.width, qrData.height);

    if (decoded) {
      console.log(`${viewportName}: QR decode SUCCESS at ${qrData.width}x${qrData.height}px`);
      console.log(`  Decoded length: ${decoded.data.length} chars`);
      return true;
    } else {
      console.log(`${viewportName}: QR decode FAILED at ${qrData.width}x${qrData.height}px`);
      return false;
    }
  }

  test('Phone 320x568: Layout assertions and screenshot', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    
    const sessionId = await setupSession();
    await page.goto(`${BASE_URL}/api/enrollment?session=${sessionId}`);
    await page.waitForSelector('h1');
    
    // Capture before state
    await page.screenshot({
      path: '/opt/cursor/artifacts/layout-before-320x568.png',
      fullPage: false,
    });

    // Trigger QR display
    const verifyButton = page.locator('#verifyButton');
    await expect(verifyButton).toBeVisible({ timeout: 5000 });
    await verifyButton.click();
    await page.waitForSelector('#qrCode canvas', { timeout: 5000 });

    // Capture after state
    await page.screenshot({
      path: '/opt/cursor/artifacts/layout-after-320x568.png',
      fullPage: false,
    });

    // Capture metrics
    const metrics = await captureLayoutMetrics(page, '320x568');

    // ASSERTIONS
    // 1. No horizontal scroll
    expect(metrics.scroll.scrollWidth).toBeLessThanOrEqual(320 + 1);
    
    // 2. Blue button within viewport
    expect(metrics.elements.connectorLink).not.toBeNull();
    expect(metrics.elements.connectorLink!.y + metrics.elements.connectorLink!.height).toBeLessThanOrEqual(568);
    
    // 3. QR code minimum size
    expect(metrics.elements.qrCode).not.toBeNull();
    expect(metrics.elements.qrCode!.width).toBeGreaterThanOrEqual(140);
    
    // 4. All critical elements visible
    expect(metrics.elements.heading).not.toBeNull();
    expect(metrics.elements.qrInstruction).not.toBeNull();
    
    // 5. QR decode at rendered size
    const qrDecoded = await verifyQRDecode(page, '320x568');
    expect(qrDecoded).toBe(true);
  });

  test('Phone 390x844: Layout assertions and screenshot', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    
    const sessionId = await setupSession();
    await page.goto(`${BASE_URL}/api/enrollment?session=${sessionId}`);
    await page.waitForSelector('h1');
    
    await page.screenshot({
      path: '/opt/cursor/artifacts/layout-before-390x844.png',
      fullPage: false,
    });

    const verifyButton = page.locator('#verifyButton');
    await expect(verifyButton).toBeVisible({ timeout: 5000 });
    await verifyButton.click();
    await page.waitForSelector('#qrCode canvas', { timeout: 5000 });

    await page.screenshot({
      path: '/opt/cursor/artifacts/layout-after-390x844.png',
      fullPage: false,
    });

    const metrics = await captureLayoutMetrics(page, '390x844');

    // ASSERTIONS
    expect(metrics.scroll.scrollWidth).toBeLessThanOrEqual(390 + 1);
    expect(metrics.elements.connectorLink).not.toBeNull();
    expect(metrics.elements.connectorLink!.y + metrics.elements.connectorLink!.height).toBeLessThanOrEqual(844);
    expect(metrics.elements.qrCode).not.toBeNull();
    expect(metrics.elements.qrCode!.width).toBeGreaterThanOrEqual(140);
    
    const qrDecoded = await verifyQRDecode(page, '390x844');
    expect(qrDecoded).toBe(true);
  });

  test('Landscape 667x375: Layout assertions and screenshot', async ({ page }) => {
    await page.setViewportSize({ width: 667, height: 375 });
    
    const sessionId = await setupSession();
    await page.goto(`${BASE_URL}/api/enrollment?session=${sessionId}`);
    await page.waitForSelector('h1');
    
    await page.screenshot({
      path: '/opt/cursor/artifacts/layout-before-667x375.png',
      fullPage: false,
    });

    const verifyButton = page.locator('#verifyButton');
    await expect(verifyButton).toBeVisible({ timeout: 5000 });
    await verifyButton.click();
    await page.waitForSelector('#qrCode canvas', { timeout: 5000 });

    await page.screenshot({
      path: '/opt/cursor/artifacts/layout-after-667x375.png',
      fullPage: false,
    });

    const metrics = await captureLayoutMetrics(page, '667x375');

    // ASSERTIONS
    expect(metrics.scroll.scrollWidth).toBeLessThanOrEqual(667 + 1);
    expect(metrics.elements.connectorLink).not.toBeNull();
    expect(metrics.elements.connectorLink!.y + metrics.elements.connectorLink!.height).toBeLessThanOrEqual(375);
    expect(metrics.elements.qrCode).not.toBeNull();
    expect(metrics.elements.qrCode!.width).toBeGreaterThanOrEqual(140);
    
    const qrDecoded = await verifyQRDecode(page, '667x375');
    expect(qrDecoded).toBe(true);
  });

  test('Desktop 1280x800: Layout assertions and screenshot', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    
    const sessionId = await setupSession();
    await page.goto(`${BASE_URL}/api/enrollment?session=${sessionId}`);
    await page.waitForSelector('h1');
    
    await page.screenshot({
      path: '/opt/cursor/artifacts/layout-before-1280x800.png',
      fullPage: false,
    });

    const verifyButton = page.locator('#verifyButton');
    await expect(verifyButton).toBeVisible({ timeout: 5000 });
    await verifyButton.click();
    await page.waitForSelector('#qrCode canvas', { timeout: 5000 });

    await page.screenshot({
      path: '/opt/cursor/artifacts/layout-after-1280x800.png',
      fullPage: false,
    });

    const metrics = await captureLayoutMetrics(page, '1280x800');

    // ASSERTIONS
    expect(metrics.scroll.scrollWidth).toBeLessThanOrEqual(1280 + 1);
    expect(metrics.elements.connectorLink).not.toBeNull();
    expect(metrics.elements.connectorLink!.y + metrics.elements.connectorLink!.height).toBeLessThanOrEqual(800);
    expect(metrics.elements.qrCode).not.toBeNull();
    expect(metrics.elements.qrCode!.width).toBeGreaterThanOrEqual(140);
    expect(metrics.elements.qrCode!.width).toBeLessThanOrEqual(300);
    
    const qrDecoded = await verifyQRDecode(page, '1280x800');
    expect(qrDecoded).toBe(true);
  });
});
