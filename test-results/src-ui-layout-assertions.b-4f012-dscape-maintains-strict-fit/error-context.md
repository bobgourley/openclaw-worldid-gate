# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: src/ui/layout-assertions.browser.test.ts >> Layout Assertions with Screenshots >> orientation transition: portrait to landscape maintains strict fit
- Location: src/ui/layout-assertions.browser.test.ts:457:3

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator:  locator('#verifyButton')
Expected: visible
Received: hidden
Timeout:  5000ms

Call log:
  - Expect "toBeVisible" locator('#verifyButton') with timeout 5000ms
  - waiting for locator('#verifyButton')
    14 × locator resolved to <button disabled id="verifyButton" class="button hidden">↵      Connect World App↵    </button>
       - unexpected value "hidden"

```

```yaml
- heading "World ID Verification" [level=1]
- paragraph: Verify your unique personhood to access this Telegram group
- text: ⚠️ This page must be opened from the Telegram bot. Verification is disabled in external browsers for security. Please open the link in Telegram.
- strong: "Privacy:"
- text: Only a zero-knowledge proof is verified. Our service receives no raw biometric data.
```

# Test source

```ts
  364 |           initDataUnsafe: { user: { id: 123456 }, auth_date: 1700000000 },
  365 |           ready: () => {}, expand: () => {}, close: () => {},
  366 |           MainButton: { show: () => {}, hide: () => {} },
  367 |           BackButton: { show: () => {}, hide: () => {} },
  368 |         },
  369 |       };
  370 |     });
  371 |     const sessionId = `session-667-${Date.now()}`;
  372 |     await page.goto(`${BASE_URL}/enrollment?session=${sessionId}`);
  373 |     await page.waitForSelector('h1');
  374 |     await page.waitForTimeout(1000);
  375 |     await page.screenshot({ path: '/opt/cursor/artifacts/layout-before-667x375.png', fullPage: false });
  376 |     await expect(page.locator('#verifyButton')).toBeVisible({ timeout: 5000 });
  377 |     const testConnectorURI3 = 'wc:test-connector-667x375@2?relay-protocol=irn&symKey=abc1234567890def';
  378 |     await page.evaluate(async (connectorURI) => {
  379 |       const connectorDisplay = document.getElementById('connectorDisplay');
  380 |       const qrCodeEl = document.getElementById('qrCode');
  381 |       const connectorLink = document.getElementById('connectorLink');
  382 |       if (connectorDisplay && qrCodeEl && connectorLink && (window as any).generateQRCode) {
  383 |         await (window as any).generateQRCode(connectorURI, qrCodeEl);
  384 |         connectorLink.href = connectorURI;
  385 |         connectorLink.textContent = 'Or tap to open on this device';
  386 |         connectorDisplay.classList.remove('hidden');
  387 |         document.getElementById('verifyButton')?.classList.add('hidden');
  388 |         const statusEl = document.getElementById('status');
  389 |         if (statusEl) {
  390 |           statusEl.textContent = 'Scan QR code with World App';
  391 |           statusEl.className = 'success';
  392 |         }
  393 |       }
  394 |     }, testConnectorURI3);
  395 |     await page.waitForTimeout(500);
  396 |     await page.waitForTimeout(500);
  397 |     await page.screenshot({ path: '/opt/cursor/artifacts/layout-after-667x375.png', fullPage: false });
  398 |     const metrics = await captureLayoutMetrics(page, '667x375');
  399 |     expect(metrics.scroll.scrollWidth).toBeLessThanOrEqual(667 + 2);
  400 |     expect(metrics.connectorLink).not.toBeNull();
  401 |     // STRICT: Button must fit entirely within viewport, no scrolling required
  402 |     expect(metrics.connectorLink!.y + metrics.connectorLink!.height).toBeLessThanOrEqual(375);
  403 |     expect(metrics.qrCode).not.toBeNull();
  404 |   });
  405 | 
  406 |   test('Desktop 1280x800: Layout assertions and screenshot', async ({ page }) => {
  407 |     await page.setViewportSize({ width: 1280, height: 800 });
  408 |     await page.route('https://telegram.org/js/telegram-web-app.js', route => {
  409 |       route.fulfill({ status: 200, contentType: 'application/javascript', body: '// Blocked' });
  410 |     });
  411 |     await page.addInitScript(() => {
  412 |       (window as any).Telegram = {
  413 |         WebApp: {
  414 |           initData: 'user=%7B%22id%22%3A123456%7D&auth_date=1700000000&hash=abc123',
  415 |           initDataUnsafe: { user: { id: 123456 }, auth_date: 1700000000 },
  416 |           ready: () => {}, expand: () => {}, close: () => {},
  417 |           MainButton: { show: () => {}, hide: () => {} },
  418 |           BackButton: { show: () => {}, hide: () => {} },
  419 |         },
  420 |       };
  421 |     });
  422 |     const sessionId = `session-1280-${Date.now()}`;
  423 |     await page.goto(`${BASE_URL}/enrollment?session=${sessionId}`);
  424 |     await page.waitForSelector('h1');
  425 |     await page.waitForTimeout(1000);
  426 |     await page.screenshot({ path: '/opt/cursor/artifacts/layout-before-1280x800.png', fullPage: false });
  427 |     await expect(page.locator('#verifyButton')).toBeVisible({ timeout: 5000 });
  428 |     const testConnectorURI4 = 'wc:test-connector-1280x800@2?relay-protocol=irn&symKey=1234567890abcdef';
  429 |     await page.evaluate(async (connectorURI) => {
  430 |       const connectorDisplay = document.getElementById('connectorDisplay');
  431 |       const qrCodeEl = document.getElementById('qrCode');
  432 |       const connectorLink = document.getElementById('connectorLink');
  433 |       if (connectorDisplay && qrCodeEl && connectorLink && (window as any).generateQRCode) {
  434 |         await (window as any).generateQRCode(connectorURI, qrCodeEl);
  435 |         connectorLink.href = connectorURI;
  436 |         connectorLink.textContent = 'Or tap to open on this device';
  437 |         connectorDisplay.classList.remove('hidden');
  438 |         document.getElementById('verifyButton')?.classList.add('hidden');
  439 |         const statusEl = document.getElementById('status');
  440 |         if (statusEl) {
  441 |           statusEl.textContent = 'Scan QR code with World App';
  442 |           statusEl.className = 'success';
  443 |         }
  444 |       }
  445 |     }, testConnectorURI4);
  446 |     await page.waitForTimeout(500);
  447 |     await page.waitForTimeout(500);
  448 |     await page.screenshot({ path: '/opt/cursor/artifacts/layout-after-1280x800.png', fullPage: false });
  449 |     const metrics = await captureLayoutMetrics(page, '1280x800');
  450 |     expect(metrics.scroll.scrollWidth).toBeLessThanOrEqual(1280 + 2);
  451 |     expect(metrics.connectorLink).not.toBeNull();
  452 |     expect(metrics.connectorLink!.y + metrics.connectorLink!.height).toBeLessThanOrEqual(800);
  453 |     expect(metrics.qrCode).not.toBeNull();
  454 |     expect(metrics.qrCode!.width).toBeLessThanOrEqual(300);
  455 |   });
  456 | 
  457 |   test('orientation transition: portrait to landscape maintains strict fit', async ({ page }) => {
  458 |     const sessionId = `test-orientation-${Date.now()}`;
  459 |     
  460 |     // Start in portrait (375x667 - iPhone 8)
  461 |     await page.setViewportSize({ width: 375, height: 667 });
  462 |     await page.goto(`${BASE_URL}/enrollment?session=${sessionId}`);
  463 |     await page.waitForSelector('h1');
> 464 |     await expect(page.locator('#verifyButton')).toBeVisible({ timeout: 5000 });
      |                                                 ^ Error: expect(locator).toBeVisible() failed
  465 |     
  466 |     const testConnectorURI = 'wc:test-orientation@2?relay-protocol=irn&symKey=orientation1234567890';
  467 |     await page.evaluate(async (connectorURI) => {
  468 |       const connectorDisplay = document.getElementById('connectorDisplay');
  469 |       const qrCodeEl = document.getElementById('qrCode');
  470 |       const connectorLink = document.getElementById('connectorLink');
  471 |       if (connectorDisplay && qrCodeEl && connectorLink && (window as any).generateQRCode) {
  472 |         await (window as any).generateQRCode(connectorURI, qrCodeEl);
  473 |         connectorLink.href = connectorURI;
  474 |         connectorLink.textContent = 'Or tap to open on this device';
  475 |         connectorDisplay.classList.remove('hidden');
  476 |         document.getElementById('verifyButton')?.classList.add('hidden');
  477 |         const statusEl = document.getElementById('status');
  478 |         if (statusEl) {
  479 |           statusEl.textContent = 'Scan QR code with World App';
  480 |           statusEl.className = 'success';
  481 |         }
  482 |       }
  483 |     }, testConnectorURI);
  484 |     await page.waitForTimeout(500);
  485 |     
  486 |     await page.screenshot({ path: '/opt/cursor/artifacts/orientation-portrait-375x667.png', fullPage: false });
  487 |     const portraitMetrics = await captureLayoutMetrics(page, 'portrait-375x667');
  488 |     
  489 |     // Assert strict fit in portrait
  490 |     const portraitContainer = await page.evaluate(() => {
  491 |       const container = document.querySelector('.container') as HTMLElement;
  492 |       return container ? {
  493 |         scrollHeight: container.scrollHeight,
  494 |         clientHeight: container.clientHeight
  495 |       } : null;
  496 |     });
  497 |     expect(portraitContainer).not.toBeNull();
  498 |     expect(portraitContainer!.scrollHeight).toBeLessThanOrEqual(portraitContainer!.clientHeight);
  499 |     expect(portraitMetrics.connectorLink!.y + portraitMetrics.connectorLink!.height).toBeLessThanOrEqual(667);
  500 |     
  501 |     // Rotate to landscape (667x375)
  502 |     await page.setViewportSize({ width: 667, height: 375 });
  503 |     await page.evaluate(() => {
  504 |       // Trigger orientationchange event
  505 |       window.dispatchEvent(new Event('orientationchange'));
  506 |       window.dispatchEvent(new Event('resize'));
  507 |     });
  508 |     await page.waitForTimeout(500); // Let layout recalculate
  509 |     
  510 |     await page.screenshot({ path: '/opt/cursor/artifacts/orientation-landscape-667x375.png', fullPage: false });
  511 |     const landscapeMetrics = await captureLayoutMetrics(page, 'landscape-667x375');
  512 |     
  513 |     // Assert strict fit in landscape
  514 |     const landscapeContainer = await page.evaluate(() => {
  515 |       const container = document.querySelector('.container') as HTMLElement;
  516 |       return container ? {
  517 |         scrollHeight: container.scrollHeight,
  518 |         clientHeight: container.clientHeight
  519 |       } : null;
  520 |     });
  521 |     expect(landscapeContainer).not.toBeNull();
  522 |     expect(landscapeContainer!.scrollHeight).toBeLessThanOrEqual(landscapeContainer!.clientHeight);
  523 |     expect(landscapeMetrics.connectorLink).not.toBeNull();
  524 |     expect(landscapeMetrics.qrCode).not.toBeNull();
  525 |   });
  526 | 
  527 |   test('viewport shrink transition maintains accessibility', async ({ page }) => {
  528 |     const sessionId = `test-viewport-shrink-${Date.now()}`;
  529 |     
  530 |     // Start at comfortable size (414x896 - iPhone 11)
  531 |     await page.setViewportSize({ width: 414, height: 896 });
  532 |     await page.goto(`${BASE_URL}/enrollment?session=${sessionId}`);
  533 |     await page.waitForSelector('h1');
  534 |     await expect(page.locator('#verifyButton')).toBeVisible({ timeout: 5000 });
  535 |     
  536 |     const testConnectorURI = 'wc:test-shrink@2?relay-protocol=irn&symKey=shrink1234567890abcd';
  537 |     await page.evaluate(async (connectorURI) => {
  538 |       const connectorDisplay = document.getElementById('connectorDisplay');
  539 |       const qrCodeEl = document.getElementById('qrCode');
  540 |       const connectorLink = document.getElementById('connectorLink');
  541 |       if (connectorDisplay && qrCodeEl && connectorLink && (window as any).generateQRCode) {
  542 |         await (window as any).generateQRCode(connectorURI, qrCodeEl);
  543 |         connectorLink.href = connectorURI;
  544 |         connectorLink.textContent = 'Or tap to open on this device';
  545 |         connectorDisplay.classList.remove('hidden');
  546 |         document.getElementById('verifyButton')?.classList.add('hidden');
  547 |         const statusEl = document.getElementById('status');
  548 |         if (statusEl) {
  549 |           statusEl.textContent = 'Scan QR code with World App';
  550 |           statusEl.className = 'success';
  551 |         }
  552 |       }
  553 |     }, testConnectorURI);
  554 |     await page.waitForTimeout(500);
  555 |     
  556 |     await page.screenshot({ path: '/opt/cursor/artifacts/viewport-before-414x896.png', fullPage: false });
  557 |     const beforeMetrics = await captureLayoutMetrics(page, 'before-414x896');
  558 |     expect(beforeMetrics.connectorLink!.y + beforeMetrics.connectorLink!.height).toBeLessThanOrEqual(896);
  559 |     
  560 |     // Shrink viewport dramatically (320x480 - very constrained)
  561 |     await page.setViewportSize({ width: 320, height: 480 });
  562 |     await page.evaluate(() => {
  563 |       if ('visualViewport' in window && window.visualViewport) {
  564 |         window.dispatchEvent(new Event('resize'));
```