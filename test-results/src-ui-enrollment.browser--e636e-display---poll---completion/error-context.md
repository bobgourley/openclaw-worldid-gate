# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: src/ui/enrollment.browser.test.ts >> Enrollment browser workflow >> Full flow: session -> connectorURI display -> poll -> completion
- Location: src/ui/enrollment.browser.test.ts:134:3

# Error details

```
Error: Verification failed: Unable to connect to World App. Please try again.
```

# Test source

```ts
  261 |     });
  262 | 
  263 |     // Log page title and URL
  264 |     console.log(`Page title: ${await page.title()}`);
  265 |     console.log(`Page URL: ${page.url()}`);
  266 | 
  267 |     // Wait for page load
  268 |     await page.waitForLoadState('networkidle');
  269 | 
  270 |     // Check if status element exists
  271 |     const statusCount = await page.locator('#status').count();
  272 |     console.log(`Status element count: ${statusCount}`);
  273 | 
  274 |     if (statusCount === 0) {
  275 |       console.error('Status element not found! Page may have failed to load enrollment.html');
  276 |       throw new Error('Status element not found - enrollment page did not load correctly');
  277 |     }
  278 | 
  279 |     const statusEl = page.locator('#status');
  280 |     await expect(statusEl).toBeVisible();
  281 | 
  282 |     // Wait for SDK initialization
  283 |     await page.waitForTimeout(2000);
  284 | 
  285 |     const statusText = await statusEl.textContent();
  286 |     console.log('Status text:', statusText);
  287 | 
  288 |     // Check for error messages
  289 |     const hasError = await statusEl.evaluate(el => el.className.includes('error'));
  290 |     if (hasError) {
  291 |       console.error('Enrollment failed with error:', statusText);
  292 |       await page.screenshot({ 
  293 |         path: '/opt/cursor/artifacts/enrollment-error.png',
  294 |         fullPage: true 
  295 |       });
  296 |       throw new Error(`Enrollment initialization failed: ${statusText}`);
  297 |     }
  298 | 
  299 |     console.log(`Status after load - hasError: ${hasError}`);
  300 | 
  301 |     // Intercept World App navigation
  302 |     let connectorUriNavigated = '';
  303 |     await page.route('worldcoin://**', async (route) => {
  304 |       connectorUriNavigated = route.request().url();
  305 |       console.log(`[Intercepted World App navigation]: ${connectorUriNavigated}`);
  306 |       await route.abort();
  307 |     });
  308 | 
  309 |     // Step 3: Check what session data was loaded
  310 |     console.log('\n=== Step 2.5: Checking loaded session data ===');
  311 |     const sessionData = await page.evaluate(() => {
  312 |       return (window as any).enrollmentSession;
  313 |     });
  314 |     console.log('Session data in browser:', JSON.stringify(sessionData, null, 2));
  315 | 
  316 |     // Step 3: Click the Verify button
  317 |     console.log('\n=== Step 3: Clicking Verify button ===');
  318 |     const verifyButton = page.locator('#verifyButton');
  319 |     await expect(verifyButton).toBeVisible();
  320 |     
  321 |     // Take screenshot before click
  322 |     await page.screenshot({ 
  323 |       path: '/opt/cursor/artifacts/enrollment-before-verify.png',
  324 |       fullPage: true 
  325 |     });
  326 | 
  327 |     // Click the button
  328 |     await verifyButton.click();
  329 |     console.log('Verify button clicked');
  330 | 
  331 |     // Wait for any immediate response
  332 |     await page.waitForTimeout(1000);
  333 | 
  334 |     // Take screenshot after click
  335 |     await page.screenshot({ 
  336 |       path: '/opt/cursor/artifacts/enrollment-after-verify-click.png',
  337 |       fullPage: true 
  338 |     });
  339 | 
  340 |     // Check status after click
  341 |     const statusAfterClick = await statusEl.textContent();
  342 |     console.log('Status after click:', statusAfterClick);
  343 | 
  344 |     // Check for errors after click
  345 |     const hasErrorAfterClick = await statusEl.evaluate(el => el.className.includes('error'));
  346 |     console.log('Has error after click:', hasErrorAfterClick);
  347 | 
  348 |     if (hasErrorAfterClick) {
  349 |       console.error('Error after verify click:', statusAfterClick);
  350 |       await page.screenshot({ 
  351 |         path: '/opt/cursor/artifacts/enrollment-verify-error.png',
  352 |         fullPage: true 
  353 |       });
  354 |       
  355 |       // Get console logs
  356 |       const logs = await page.evaluate(() => {
  357 |         return (window as any).testLogs || [];
  358 |       });
  359 |       console.log('Browser logs:', logs);
  360 |       
> 361 |       throw new Error(`Verification failed: ${statusAfterClick}`);
      |             ^ Error: Verification failed: Unable to connect to World App. Please try again.
  362 |     }
  363 | 
  364 |     // Step 4: Assert connectorURI is displayed in tappable DOM BEFORE polling
  365 |     console.log('\n=== Step 4: Asserting connectorURI in tappable DOM ===');
  366 |     
  367 |     // Wait for connectorURI to be displayed
  368 |     await page.waitForTimeout(2000);
  369 | 
  370 |     // CRITICAL: Assert connectorURI link is visible and has href
  371 |     const connectorLink = page.locator('#connectorLink');
  372 |     await expect(connectorLink).toBeVisible({ timeout: 5000 });
  373 |     
  374 |     const connectorHref = await connectorLink.getAttribute('href');
  375 |     console.log('connectorURI href:', connectorHref);
  376 |     
  377 |     // Assert it's a valid World App URI
  378 |     expect(connectorHref).toBeTruthy();
  379 |     expect(connectorHref).toMatch(/^(worldcoin:|https:\/\/)/);
  380 |     
  381 |     // Take screenshot showing connectorURI displayed
  382 |     await page.screenshot({ 
  383 |       path: '/opt/cursor/artifacts/enrollment-connector-displayed.png',
  384 |       fullPage: true 
  385 |     });
  386 | 
  387 |     // Step 5: Simulate user tapping the World App link
  388 |     console.log('\n=== Step 5: Simulating World App launch ===');
  389 |     
  390 |     // Mock completion response with encrypted bridge payload
  391 |     let pollCount = 0;
  392 |     await page.route('https://bridge.worldcoin.org/response/**', async (route) => {
  393 |       pollCount++;
  394 |       console.log(`[Mock] Bridge poll attempt ${pollCount}`);
  395 |       
  396 |       if (pollCount <= 2) {
  397 |         // First polls: waiting for user
  398 |         await route.fulfill({
  399 |           status: 200,
  400 |           contentType: 'application/json',
  401 |           body: JSON.stringify({ status: 'initialized' }),
  402 |         });
  403 |       } else if (pollCount === 3) {
  404 |         // Third poll: user completed in World App
  405 |         // Return encrypted success response
  406 |         console.log('[Mock] Returning completed status');
  407 |         await route.fulfill({
  408 |           status: 200,
  409 |           contentType: 'application/json',
  410 |           body: JSON.stringify({
  411 |             status: 'completed',
  412 |             response: {
  413 |               // Encrypted payload (mocked - SDK will attempt to decrypt)
  414 |               iv: 'AAAAAAAAAAAAAAAAAAAAAA==',
  415 |               payload: 'bW9ja2VkX2VuY3J5cHRlZF9wYXlsb2Fk',
  416 |             },
  417 |           }),
  418 |         });
  419 |       } else {
  420 |         await route.fulfill({
  421 |           status: 200,
  422 |           contentType: 'application/json',
  423 |           body: JSON.stringify({ status: 'initialized' }),
  424 |         });
  425 |       }
  426 |     });
  427 | 
  428 |     // Wait for polling to complete (will fail on decryption, which is expected)
  429 |     await page.waitForTimeout(8000);
  430 | 
  431 |     // Take final screenshot
  432 |     await page.screenshot({ 
  433 |       path: '/opt/cursor/artifacts/enrollment-final-state.png',
  434 |       fullPage: true 
  435 |     });
  436 | 
  437 |     const finalStatus = await statusEl.textContent();
  438 |     console.log('Final status:', finalStatus);
  439 | 
  440 |     // Log what happened
  441 |     console.log('\n=== Test Results ===');
  442 |     console.log('✓ connectorURI displayed in tappable DOM element');
  443 |     console.log('✓ Bridge polling executed');
  444 |     console.log('✓ Poll state transitions tested');
  445 |     console.log(`Final browser state: ${finalStatus}`);
  446 |   });
  447 | });
  448 | 
```