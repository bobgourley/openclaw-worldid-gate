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
  344 |         }
  345 |         return;
  346 |       }
  347 |       
  348 |       // Unknown endpoint
  349 |       console.log('[Mock] Unknown bridge endpoint, aborting');
  350 |       await route.abort();
  351 |     });
  352 | 
  353 |     // Navigate to enrollment page
  354 |     const enrollmentUrl = `http://127.0.0.1:${serverPort}/enrollment?session=${sessionId}`;
  355 |     await page.goto(enrollmentUrl);
  356 |     await page.waitForLoadState('networkidle');
  357 | 
  358 |     const statusEl = page.locator('#status');
  359 |     await expect(statusEl).toBeVisible();
  360 | 
  361 |     // Step 3: Click Verify and capture connectorURI
  362 |     console.log('\n=== Step 3: Clicking Verify and extracting encryption key ===');
  363 | 
  364 |     const verifyButton = page.locator('#verifyButton');
  365 |     await expect(verifyButton).toBeVisible();
  366 | 
  367 |     // Wait for SDK to be ready
  368 |     await page.waitForTimeout(500);
  369 | 
  370 |     // Click Verify
  371 |     await verifyButton.click();
  372 |     console.log('Verify button clicked');
  373 | 
  374 |     // Wait for connectorURI to be displayed
  375 |     await page.waitForTimeout(2000);
  376 | 
  377 |     const connectorLink = page.locator('#connectorLink');
  378 |     await expect(connectorLink).toBeVisible({ timeout: 5000 });
  379 | 
  380 |     const connectorHref = await connectorLink.getAttribute('href');
  381 |     expect(connectorHref).toBeTruthy();
  382 |     
  383 |     capturedConnectorURI = connectorHref!;
  384 |     console.log('connectorURI captured (redacted)');
  385 | 
  386 |     // Extract encryption key from connectorURI
  387 |     const keyMatch = capturedConnectorURI.match(/[?&]k=([^&]+)/);
  388 |     expect(keyMatch).toBeTruthy();
  389 |     const keyParam = decodeURIComponent(keyMatch![1]);
  390 |     encryptionKey = Buffer.from(keyParam, 'base64');
  391 |     console.log('Encryption key extracted:', encryptionKey.length, 'bytes');
  392 | 
  393 |     // Step 4: Wait for SDK to start polling (already mocked in bridge handler)
  394 |     console.log('\n=== Step 4: Waiting for encrypted bridge poll ===');
  395 | 
  396 |     // Monitor completion POST (but let it go to real server)
  397 |     let completionReceived = false;
  398 |     let completionPayload: any = null;
  399 | 
  400 |     page.on('request', req => {
  401 |       if (req.url().includes('/api/enrollment/complete') && req.method() === 'POST') {
  402 |         completionReceived = true;
  403 |         try {
  404 |           completionPayload = req.postDataJSON();
  405 |           console.log('[Monitor] Completion POST sent');
  406 |           console.log('[Monitor] idkitResult keys:', Object.keys(completionPayload.idkitResult || {}));
  407 |           console.log('[Monitor] idkitResult.nonce:', completionPayload.idkitResult?.nonce);
  408 |           console.log('[Monitor] idkitResult.protocol_version:', completionPayload.idkitResult?.protocol_version);
  409 |         } catch (e) {
  410 |           console.log('[Monitor] Could not parse completion payload');
  411 |         }
  412 |       }
  413 |     });
  414 | 
  415 |     // Wait for polling to complete
  416 |     await page.waitForTimeout(10000);
  417 | 
  418 |     // Step 5: Verify completion
  419 |     console.log('\n=== Step 5: Verifying completion ===');
  420 | 
  421 |     const finalStatus = await statusEl.textContent();
  422 |     console.log('Final status:', finalStatus);
  423 | 
  424 |     // Take screenshot of final state
  425 |     await page.screenshot({ 
  426 |       path: '/opt/cursor/artifacts/enrollment-webhook-final.png',
  427 |       fullPage: true 
  428 |     });
  429 | 
  430 |     // Step 6: Verify enrollment in database
  431 |     console.log('\n=== Step 6: Verifying enrollment in database ===');
  432 |     
  433 |     const enrollmentService = (service as any).enrollmentService;
  434 |     const enrollment = await enrollmentService.findEnrollment(TEST_USER_ID);
  435 |     
  436 |     console.log('Enrollment found:', !!enrollment);
  437 |     if (enrollment) {
  438 |       console.log('  - revoked:', enrollment.revoked);
  439 |       console.log('  - expired:', enrollment.expired);
  440 |     }
  441 |     console.log('Completion POST sent:', completionReceived);
  442 | 
  443 |     // Assertions
> 444 |     expect(completionReceived).toBeTruthy();
      |                                ^ Error: expect(received).toBeTruthy()
  445 |     expect(completionPayload).toBeTruthy();
  446 |     expect(completionPayload.initData).toBeTruthy();
  447 |     expect(completionPayload.idkitResult).toBeTruthy();
  448 |     expect(enrollment).toBeTruthy();
  449 |     expect(enrollment.revoked).toBe(false);
  450 | 
  451 |     console.log('\n=== Test Results ===');
  452 |     console.log('✓ Webhook /verify created session via production path');
  453 |     console.log('✓ Session stored with storeChallengeForSession');
  454 |     console.log('✓ connectorURI extracted and key decoded');
  455 |     console.log('✓ Valid AES-GCM encrypted response constructed');
  456 |     console.log('✓ SDK decrypted response successfully');
  457 |     console.log('✓ Completion POST sent with initData + idkitResult');
  458 |     console.log('✓ Enrollment saved to database');
  459 |   });
  460 | });
  461 | 
```