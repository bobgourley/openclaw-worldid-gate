/**
 * XSS safety tests for enrollment.html
 * 
 * Verifies that error messages are rendered via textContent and do not execute injected scripts
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
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('<img src=x onerror="window.__XSS_EXECUTED=true">');
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      serverPort = typeof addr === 'object' && addr !== null ? addr.port : 0;
      console.log(`XSS test server started on port ${serverPort}`);
      resolve();
    });
  });
});

test.afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Error messages rendered via textContent do not execute injected scripts', async ({ page }) => {
  // Navigate to enrollment page (will fail to load IDKit bundle)
  await page.goto(`http://127.0.0.1:${serverPort}/enrollment?session=test123`);
  
  // Wait for error to appear
  await page.waitForTimeout(2000);
  
  // Verify XSS did not execute
  const xssExecuted = await page.evaluate(() => (window as any).__XSS_EXECUTED);
  expect(xssExecuted).toBeUndefined();
  
  // Verify no img element was created from the injected string
  const imgCount = await page.locator('img').count();
  expect(imgCount).toBe(0);
  
  // Verify error message is displayed as text (not HTML)
  const statusText = await page.locator('#status').textContent();
  expect(statusText).toBeTruthy();
  
  // The raw string should be visible as text if it was displayed
  const pageText = await page.textContent('body');
  if (pageText?.includes('<img')) {
    // If the injected string is visible as text, that's safe
    console.log('PASS: Injected HTML rendered as text, not executed');
  } else {
    // Or it was sanitized completely
    console.log('PASS: Injected HTML not displayed or executed');
  }
  
  console.log('PASS: No XSS execution from error message');
});
