/**
 * Responsive QR layout viewport tests
 * Tests QR rendering, sizing, and visibility at various viewport sizes
 */

import { test, expect } from '@playwright/test';
import { HttpEnrollmentBridge } from './src/http-enrollment-bridge.js';
import type { SignedChallenge } from './src/worldid-challenge-adapter.js';

const TEST_PORT = 18082;
const BASE_URL = `http://localhost:${TEST_PORT}`;

// Test viewport configurations
const VIEWPORTS = [
  { name: 'iPhone SE', width: 375, height: 667 },
  { name: 'iPhone 12/13', width: 390, height: 844 },
  { name: 'Small Phone Portrait', width: 320, height: 568 },
  { name: 'Phone Landscape', width: 667, height: 375 },
  { name: 'Tablet Portrait', width: 768, height: 1024 },
  { name: 'Desktop 1280x800', width: 1280, height: 800 },
  { name: 'Desktop 1366x768', width: 1366, height: 768 },
  { name: 'Short Laptop', width: 1024, height: 640 },
];

test.describe('Responsive QR Layout', () => {
  let bridge: HttpEnrollmentBridge;

  test.beforeAll(async () => {
    bridge = new HttpEnrollmentBridge(TEST_PORT);
    await bridge.start();
  });

  test.afterAll(async () => {
    await bridge.stop();
  });

  for (const viewport of VIEWPORTS) {
    test(`${viewport.name} (${viewport.width}x${viewport.height}): all content visible without scrolling`, async ({ page }) => {
      // Set viewport
      await page.setViewportSize({ width: viewport.width, height: viewport.height });

      // Create synthetic session
      const mockChallenge: SignedChallenge = {
        action: 'test-responsive',
        signal: 'telegram:123',
        nonce: `nonce-${Date.now()}`,
        signature: 'mock-signature',
        signalHash: 'mock-hash',
        createdAt: Math.floor(Date.now() / 1000),
        expiresAt: Math.floor(Date.now() / 1000) + 300,
      };

      const sessionId = await bridge.createSession({
        signedChallenge: mockChallenge,
        appId: 'app_test',
        rpId: 'rp_test',
        signal: mockChallenge.signal,
      });

      // Navigate to enrollment page
      const enrollmentUrl = `${BASE_URL}/api/enrollment?session=${sessionId}`;
      await page.goto(enrollmentUrl);

      // Wait for page load
      await page.waitForSelector('h1', { timeout: 5000 });

      // Click verify button to trigger QR display
      const verifyButton = page.locator('#verifyButton');
      await expect(verifyButton).toBeVisible({ timeout: 5000 });
      await verifyButton.click();

      // Wait for QR code to render
      await page.waitForSelector('#qrCode canvas', { timeout: 5000 });

      // Check if all critical elements are visible in viewport
      const heading = page.locator('h1');
      const subtitle = page.locator('.subtitle');
      const qrCode = page.locator('#qrCode canvas');
      const qrInstruction = page.locator('.qr-instruction');
      const connectorLink = page.locator('#connectorLink');

      // Verify all elements are visible
      await expect(heading).toBeVisible();
      await expect(subtitle).toBeVisible();
      await expect(qrCode).toBeVisible();
      await expect(qrInstruction).toBeVisible();
      await expect(connectorLink).toBeVisible();

      // Check if blue button is in viewport (critical requirement)
      const buttonBox = await connectorLink.boundingBox();
      expect(buttonBox).not.toBeNull();
      expect(buttonBox!.y + buttonBox!.height).toBeLessThanOrEqual(viewport.height);

      // Verify no horizontal scrolling required
      const bodyScrollWidth = await page.evaluate(() => document.body.scrollWidth);
      expect(bodyScrollWidth).toBeLessThanOrEqual(viewport.width + 1); // Allow 1px tolerance

      // Verify QR code is appropriately sized
      const qrBox = await qrCode.boundingBox();
      expect(qrBox).not.toBeNull();
      
      // QR should be at least 140px (minimum scannable)
      expect(qrBox!.width).toBeGreaterThanOrEqual(140);
      
      // QR should not exceed container width
      expect(qrBox!.width).toBeLessThanOrEqual(Math.min(viewport.width - 40, 320));

      // Take screenshot for visual verification
      const screenshotName = `responsive-qr-${viewport.name.toLowerCase().replace(/\s+/g, '-')}-${viewport.width}x${viewport.height}.png`;
      await page.screenshot({
        path: `test-results/${screenshotName}`,
        fullPage: false,
      });

      console.log(`✓ ${viewport.name}: All content visible, QR size=${qrBox!.width}px, button at y=${buttonBox!.y}`);
    });
  }

  test('Extreme short viewport (320x480): usable fallback', async ({ page }) => {
    // Test extreme case
    await page.setViewportSize({ width: 320, height: 480 });

    const mockChallenge: SignedChallenge = {
      action: 'test-extreme',
      signal: 'telegram:456',
      nonce: `nonce-${Date.now()}`,
      signature: 'mock-signature',
      signalHash: 'mock-hash',
      createdAt: Math.floor(Date.now() / 1000),
      expiresAt: Math.floor(Date.now() / 1000) + 300,
    };

    const sessionId = await bridge.createSession({
      signedChallenge: mockChallenge,
      appId: 'app_test',
      rpId: 'rp_test',
      signal: mockChallenge.signal,
    });

    await page.goto(`${BASE_URL}/api/enrollment?session=${sessionId}`);
    await page.waitForSelector('h1');

    const verifyButton = page.locator('#verifyButton');
    await expect(verifyButton).toBeVisible();
    await verifyButton.click();

    await page.waitForSelector('#qrCode canvas');

    // At extreme viewport, content should still be accessible
    // May require minimal scrolling, but QR and button must be usable
    const qrCode = page.locator('#qrCode canvas');
    const connectorLink = page.locator('#connectorLink');

    await expect(qrCode).toBeVisible();
    await expect(connectorLink).toBeVisible();

    // QR should still meet minimum scannable size
    const qrBox = await qrCode.boundingBox();
    expect(qrBox!.width).toBeGreaterThanOrEqual(140);

    // Button should be tappable (in viewport or scrollable)
    const buttonBox = await connectorLink.boundingBox();
    expect(buttonBox).not.toBeNull();

    await page.screenshot({
      path: 'test-results/responsive-qr-extreme-320x480.png',
      fullPage: true, // Full page for extreme case
    });

    console.log(`✓ Extreme viewport: QR=${qrBox!.width}px, button accessible`);
  });
});
