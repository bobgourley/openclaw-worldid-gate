# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: src/ui/layout-assertions.browser.test.ts >> Layout Assertions with Screenshots >> orientation transition: portrait to landscape maintains strict fit
- Location: src/ui/layout-assertions.browser.test.ts:457:3

# Error details

```
Error: expect(received).toBeLessThanOrEqual(expected)

Expected: <= 343
Received:    406
```

# Test source

```ts
  503 |         }
  504 |         
  505 |         // Wait for canvas render
  506 |         await new Promise(resolve => setTimeout(resolve, 100));
  507 |         
  508 |         // Extract imageData for decode verification
  509 |         const canvas = qrCodeEl.querySelector('canvas') as HTMLCanvasElement;
  510 |         if (!canvas) return null;
  511 |         const ctx = canvas.getContext('2d');
  512 |         if (!ctx) return null;
  513 |         const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  514 |         return {
  515 |           data: Array.from(imageData.data),
  516 |           width: imageData.width,
  517 |           height: imageData.height
  518 |         };
  519 |       }
  520 |       return null;
  521 |     }, testConnectorURI);
  522 |     
  523 |     // Decode portrait QR
  524 |     if (portraitDecoded) {
  525 |       const imageData = {
  526 |         data: new Uint8ClampedArray(portraitDecoded.data),
  527 |         width: portraitDecoded.width,
  528 |         height: portraitDecoded.height
  529 |       };
  530 |       const code = jsQR(imageData.data, imageData.width, imageData.height);
  531 |       expect(code).not.toBeNull();
  532 |       expect(code?.data).toBe(testConnectorURI);
  533 |     }
  534 |     
  535 |     await page.screenshot({ path: '/opt/cursor/artifacts/orientation-portrait-375x667.png', fullPage: false });
  536 |     const portraitMetrics = await captureLayoutMetrics(page, 'portrait-375x667');
  537 |     
  538 |     // Assert strict fit in portrait (no internal overflow)
  539 |     const portraitContainer = await page.evaluate(() => {
  540 |       const container = document.querySelector('.container') as HTMLElement;
  541 |       return container ? {
  542 |         scrollHeight: container.scrollHeight,
  543 |         clientHeight: container.clientHeight
  544 |       } : null;
  545 |     });
  546 |     expect(portraitContainer).not.toBeNull();
  547 |     expect(portraitContainer!.scrollHeight).toBeLessThanOrEqual(portraitContainer!.clientHeight);
  548 |     expect(portraitMetrics.connectorLink!.y + portraitMetrics.connectorLink!.height).toBeLessThanOrEqual(667);
  549 |     
  550 |     // Rotate to landscape (667x375)
  551 |     await page.setViewportSize({ width: 667, height: 375 });
  552 |     
  553 |     // Trigger viewport change handlers and wait for QR regeneration
  554 |     const landscapeDecoded = await page.evaluate(async () => {
  555 |       window.dispatchEvent(new Event('orientationchange'));
  556 |       window.dispatchEvent(new Event('resize'));
  557 |       if ('visualViewport' in window && window.visualViewport) {
  558 |         window.visualViewport.dispatchEvent(new Event('resize'));
  559 |       }
  560 |       
  561 |       // Wait for QR regeneration to complete
  562 |       await new Promise(resolve => setTimeout(resolve, 200));
  563 |       
  564 |       // Extract imageData after regeneration
  565 |       const qrCodeEl = document.getElementById('qrCode');
  566 |       if (!qrCodeEl) return null;
  567 |       const canvas = qrCodeEl.querySelector('canvas') as HTMLCanvasElement;
  568 |       if (!canvas) return null;
  569 |       const ctx = canvas.getContext('2d');
  570 |       if (!ctx) return null;
  571 |       const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  572 |       return {
  573 |         data: Array.from(imageData.data),
  574 |         width: imageData.width,
  575 |         height: imageData.height
  576 |       };
  577 |     });
  578 |     
  579 |     // Decode landscape QR (verify regeneration worked)
  580 |     if (landscapeDecoded) {
  581 |       const imageData = {
  582 |         data: new Uint8ClampedArray(landscapeDecoded.data),
  583 |         width: landscapeDecoded.width,
  584 |         height: landscapeDecoded.height
  585 |       };
  586 |       const code = jsQR(imageData.data, imageData.width, imageData.height);
  587 |       expect(code).not.toBeNull();
  588 |       expect(code?.data).toBe(testConnectorURI);
  589 |     }
  590 |     
  591 |     await page.screenshot({ path: '/opt/cursor/artifacts/orientation-landscape-667x375.png', fullPage: false });
  592 |     const landscapeMetrics = await captureLayoutMetrics(page, 'landscape-667x375');
  593 |     
  594 |     // Assert strict fit in landscape (no internal overflow)
  595 |     const landscapeContainer = await page.evaluate(() => {
  596 |       const container = document.querySelector('.container') as HTMLElement;
  597 |       return container ? {
  598 |         scrollHeight: container.scrollHeight,
  599 |         clientHeight: container.clientHeight
  600 |       } : null;
  601 |     });
  602 |     expect(landscapeContainer).not.toBeNull();
> 603 |     expect(landscapeContainer!.scrollHeight).toBeLessThanOrEqual(landscapeContainer!.clientHeight);
      |                                              ^ Error: expect(received).toBeLessThanOrEqual(expected)
  604 |     expect(landscapeMetrics.connectorLink).not.toBeNull();
  605 |     expect(landscapeMetrics.qrCode).not.toBeNull();
  606 |     expect(landscapeMetrics.connectorLink!.y + landscapeMetrics.connectorLink!.height).toBeLessThanOrEqual(375);
  607 |   });
  608 | 
  609 |   test('viewport shrink transition maintains accessibility', async ({ page }) => {
  610 |     const sessionId = `test-viewport-shrink-${Date.now()}`;
  611 |     
  612 |     // Start at comfortable size (414x896 - iPhone 11)
  613 |     await page.setViewportSize({ width: 414, height: 896 });
  614 |     
  615 |     await page.route('https://telegram.org/js/telegram-web-app.js', route => {
  616 |       route.fulfill({ status: 200, contentType: 'application/javascript', body: '// Telegram SDK blocked for testing' });
  617 |     });
  618 |     
  619 |     await page.addInitScript(() => {
  620 |       (window as any).Telegram = {
  621 |         WebApp: {
  622 |           initData: 'user=%7B%22id%22%3A123456%7D&auth_date=1700000000&hash=abc123',
  623 |           initDataUnsafe: { user: { id: 123456, first_name: 'Test' }, auth_date: 1700000000 },
  624 |           ready: () => {}, expand: () => {}, close: () => {},
  625 |           MainButton: { show: () => {}, hide: () => {}, setText: () => {} },
  626 |           BackButton: { show: () => {}, hide: () => {} },
  627 |         },
  628 |       };
  629 |     });
  630 |     
  631 |     await page.goto(`${BASE_URL}/enrollment?session=${sessionId}`);
  632 |     await page.waitForSelector('h1');
  633 |     await page.waitForTimeout(1000); // Wait for session initialization
  634 |     await expect(page.locator('#verifyButton')).toBeVisible({ timeout: 5000 });
  635 |     
  636 |     const testConnectorURI = 'wc:test-shrink@2?relay-protocol=irn&symKey=shrink1234567890abcd';
  637 |     await page.evaluate(async (connectorURI) => {
  638 |       const connectorDisplay = document.getElementById('connectorDisplay');
  639 |       const qrCodeEl = document.getElementById('qrCode');
  640 |       const connectorLink = document.getElementById('connectorLink');
  641 |       if (connectorDisplay && qrCodeEl && connectorLink && (window as any).generateQRCode) {
  642 |         await (window as any).generateQRCode(connectorURI, qrCodeEl);
  643 |         connectorLink.href = connectorURI;
  644 |         connectorLink.textContent = 'Or tap to open on this device';
  645 |         connectorDisplay.classList.remove('hidden');
  646 |         document.getElementById('verifyButton')?.classList.add('hidden');
  647 |         const statusEl = document.getElementById('status');
  648 |         if (statusEl) {
  649 |           statusEl.textContent = 'Scan QR code with World App';
  650 |           statusEl.className = 'success';
  651 |         }
  652 |       }
  653 |     }, testConnectorURI);
  654 |     await page.waitForTimeout(500);
  655 |     
  656 |     await page.screenshot({ path: '/opt/cursor/artifacts/viewport-before-414x896.png', fullPage: false });
  657 |     const beforeMetrics = await captureLayoutMetrics(page, 'before-414x896');
  658 |     expect(beforeMetrics.connectorLink!.y + beforeMetrics.connectorLink!.height).toBeLessThanOrEqual(896);
  659 |     
  660 |     // Shrink viewport dramatically (320x480 - very constrained)
  661 |     await page.setViewportSize({ width: 320, height: 480 });
  662 |     await page.evaluate(() => {
  663 |       if ('visualViewport' in window && window.visualViewport) {
  664 |         window.dispatchEvent(new Event('resize'));
  665 |       }
  666 |       window.dispatchEvent(new Event('resize'));
  667 |     });
  668 |     await page.waitForTimeout(500); // Let layout adapt
  669 |     
  670 |     await page.screenshot({ path: '/opt/cursor/artifacts/viewport-after-320x480.png', fullPage: false });
  671 |     const afterMetrics = await captureLayoutMetrics(page, 'after-320x480');
  672 |     
  673 |     // Assert all elements still accessible (no overflow)
  674 |     expect(afterMetrics.scroll.scrollWidth).toBeLessThanOrEqual(320 + 2);
  675 |     expect(afterMetrics.connectorLink).not.toBeNull();
  676 |     expect(afterMetrics.qrCode).not.toBeNull();
  677 |     // Content must fit within visible viewport
  678 |     expect(afterMetrics.connectorLink!.y + afterMetrics.connectorLink!.height).toBeLessThanOrEqual(480);
  679 |   });
  680 | });
  681 | 
```