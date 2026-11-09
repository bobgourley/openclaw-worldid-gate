/**
 * Telegram initData validation tests
 * 
 * Verifies that missing initData disables verification
 */

import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'http';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENROLLMENT_HTML_PATH = join(__dirname, '../../dist/ui/enrollment.html');

let server: Server;
let serverPort: number;

test.beforeAll(async () => {
  const html = readFileSync(ENROLLMENT_HTML_PATH, 'utf-8');

  server = createServer((req, res) => {
    if (req.url === '/enrollment' || req.url?.startsWith('/enrollment?')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      serverPort = typeof addr === 'object' && addr !== null ? addr.port : 0;
      console.log(`InitData test server started on port ${serverPort}`);
      resolve();
    });
  });
});

test.afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Missing Telegram initData disables verification', async ({ page }) => {
  // Mock Telegram SDK with empty initData
  await page.route('**/telegram-web-app.js', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: `
        window.Telegram = {
          WebApp: {
            initData: '',
            ready: function() {},
            expand: function() {}
          }
        };
      `,
    });
  });

  await page.goto(`http://127.0.0.1:${serverPort}/enrollment?session=test123`);
  await page.waitForLoadState('networkidle');
  
  // Wait for page to initialize
  await page.waitForTimeout(1000);
  
  // Verify warning message is displayed
  const statusText = await page.locator('#status').textContent();
  expect(statusText).toContain('Telegram bot');
  expect(statusText).toContain('Verification is disabled');
  
  // Verify verify button is hidden or disabled
  const verifyButton = page.locator('#verifyButton');
  const isHidden = await verifyButton.evaluate((el) => {
    const style = window.getComputedStyle(el);
    return style.display === 'none' || style.visibility === 'hidden' || el.classList.contains('hidden');
  });
  
  expect(isHidden).toBe(true);
  
  console.log('PASS: Missing initData shows warning and disables verification');
});
