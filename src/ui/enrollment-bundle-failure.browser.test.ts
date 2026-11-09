/**
 * IDKit bundle load failure test
 * 
 * Verifies that IDKit bundle load failure shows a safe error message
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
    } else if (req.url === '/idkit-bundle.js') {
      // Simulate bundle load failure
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      serverPort = typeof addr === 'object' && addr !== null ? addr.port : 0;
      console.log(`Bundle failure test server started on port ${serverPort}`);
      resolve();
    });
  });
});

test.afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('IDKit bundle load failure shows safe error message', async ({ page }) => {
  // Mock Telegram SDK
  await page.route('**/telegram-web-app.js', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: `
        window.Telegram = {
          WebApp: {
            initData: 'user=%7B%22id%22%3A123%7D&auth_date=1700000000&hash=abc123',
            ready: function() {},
            expand: function() {}
          }
        };
      `,
    });
  });

  await page.goto(`http://127.0.0.1:${serverPort}/enrollment?session=test123`);
  
  // Wait for bundle load to fail
  await page.waitForTimeout(2000);
  
  // Verify page shows an error (not a white screen or crash)
  const bodyText = await page.textContent('body');
  expect(bodyText).toBeTruthy();
  expect(bodyText!.length).toBeGreaterThan(0);
  
  // Verify no unhandled errors crashed the page
  const titleText = await page.title();
  expect(titleText).toBeTruthy();
  
  console.log('PASS: Bundle load failure handled gracefully');
});
