# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: src/ui/enrollment-webhook.browser.test.ts >> Full webhook enrollment workflow >> Full flow: webhook → session → connectorURI → encrypted poll → completion
- Location: src/ui/enrollment-webhook.browser.test.ts:174:3

# Error details

```
Error: expect(received).toBeTruthy()

Received: false
```

# Test source

```ts
  342 |         }
  343 |         return;
  344 |       }
  345 |       
  346 |       // Unknown endpoint
  347 |       console.log('[Mock] Unknown bridge endpoint, aborting');
  348 |       await route.abort();
  349 |     });
  350 | 
  351 |     // Navigate to enrollment page
  352 |     const enrollmentUrl = `http://127.0.0.1:${serverPort}/enrollment?session=${sessionId}`;
  353 |     await page.goto(enrollmentUrl);
  354 |     await page.waitForLoadState('networkidle');
  355 | 
  356 |     const statusEl = page.locator('#status');
  357 |     await expect(statusEl).toBeVisible();
  358 | 
  359 |     // Step 3: Click Verify and capture connectorURI
  360 |     console.log('\n=== Step 3: Clicking Verify and extracting encryption key ===');
  361 | 
  362 |     const verifyButton = page.locator('#verifyButton');
  363 |     await expect(verifyButton).toBeVisible();
  364 | 
  365 |     // Wait for SDK to be ready
  366 |     await page.waitForTimeout(500);
  367 | 
  368 |     // Click Verify
  369 |     await verifyButton.click();
  370 |     console.log('Verify button clicked');
  371 | 
  372 |     // Wait for connectorURI to be displayed
  373 |     await page.waitForTimeout(2000);
  374 | 
  375 |     const connectorLink = page.locator('#connectorLink');
  376 |     await expect(connectorLink).toBeVisible({ timeout: 5000 });
  377 | 
  378 |     const connectorHref = await connectorLink.getAttribute('href');
  379 |     expect(connectorHref).toBeTruthy();
  380 |     
  381 |     capturedConnectorURI = connectorHref!;
  382 |     console.log('connectorURI captured (redacted)');
  383 | 
  384 |     // Extract encryption key from connectorURI
  385 |     const keyMatch = capturedConnectorURI.match(/[?&]k=([^&]+)/);
  386 |     expect(keyMatch).toBeTruthy();
  387 |     const keyParam = decodeURIComponent(keyMatch![1]);
  388 |     encryptionKey = Buffer.from(keyParam, 'base64');
  389 |     console.log('Encryption key extracted:', encryptionKey.length, 'bytes');
  390 | 
  391 |     // Step 4: Wait for SDK to start polling (already mocked in bridge handler)
  392 |     console.log('\n=== Step 4: Waiting for encrypted bridge poll ===');
  393 | 
  394 |     // Monitor completion POST (but let it go to real server)
  395 |     let completionReceived = false;
  396 |     let completionPayload: any = null;
  397 | 
  398 |     page.on('request', req => {
  399 |       if (req.url().includes('/api/enrollment/complete') && req.method() === 'POST') {
  400 |         completionReceived = true;
  401 |         try {
  402 |           completionPayload = req.postDataJSON();
  403 |           console.log('[Monitor] Completion POST sent');
  404 |           console.log('[Monitor] idkitResult keys:', Object.keys(completionPayload.idkitResult || {}));
  405 |           console.log('[Monitor] idkitResult.nonce:', completionPayload.idkitResult?.nonce);
  406 |           console.log('[Monitor] idkitResult.protocol_version:', completionPayload.idkitResult?.protocol_version);
  407 |         } catch (e) {
  408 |           console.log('[Monitor] Could not parse completion payload');
  409 |         }
  410 |       }
  411 |     });
  412 | 
  413 |     // Wait for polling to complete
  414 |     await page.waitForTimeout(10000);
  415 | 
  416 |     // Step 5: Verify completion
  417 |     console.log('\n=== Step 5: Verifying completion ===');
  418 | 
  419 |     const finalStatus = await statusEl.textContent();
  420 |     console.log('Final status:', finalStatus);
  421 | 
  422 |     // Take screenshot of final state
  423 |     await page.screenshot({ 
  424 |       path: '/opt/cursor/artifacts/enrollment-webhook-final.png',
  425 |       fullPage: true 
  426 |     });
  427 | 
  428 |     // Step 6: Verify enrollment in database
  429 |     console.log('\n=== Step 6: Verifying enrollment in database ===');
  430 |     
  431 |     const enrollmentService = (service as any).enrollmentService;
  432 |     const enrollment = await enrollmentService.findEnrollment(TEST_USER_ID);
  433 |     
  434 |     console.log('Enrollment found:', !!enrollment);
  435 |     if (enrollment) {
  436 |       console.log('  - revoked:', enrollment.revoked);
  437 |       console.log('  - expired:', enrollment.expired);
  438 |     }
  439 |     console.log('Completion POST sent:', completionReceived);
  440 | 
  441 |     // Assertions
> 442 |     expect(completionReceived).toBeTruthy();
      |                                ^ Error: expect(received).toBeTruthy()
  443 |     expect(completionPayload).toBeTruthy();
  444 |     expect(completionPayload.initData).toBeTruthy();
  445 |     expect(completionPayload.idkitResult).toBeTruthy();
  446 |     expect(enrollment).toBeTruthy();
  447 |     expect(enrollment.revoked).toBe(false);
  448 | 
  449 |     console.log('\n=== Test Results ===');
  450 |     console.log('✓ Webhook /verify created session via production path');
  451 |     console.log('✓ Session stored with storeChallengeForSession');
  452 |     console.log('✓ connectorURI extracted and key decoded');
  453 |     console.log('✓ Valid AES-GCM encrypted response constructed');
  454 |     console.log('✓ SDK decrypted response successfully');
  455 |     console.log('✓ Completion POST sent with initData + idkitResult');
  456 |     console.log('✓ Enrollment saved to database');
  457 |   });
  458 | });
  459 | 
```