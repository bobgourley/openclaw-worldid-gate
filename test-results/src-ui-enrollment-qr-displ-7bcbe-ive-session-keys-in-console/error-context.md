# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: src/ui/enrollment-qr-display.browser.test.ts >> Enrollment QR Code Display >> should not log sensitive session keys in console
- Location: src/ui/enrollment-qr-display.browser.test.ts:193:3

# Error details

```
Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:8080/enrollment.html?session=sensitive-test
Call log:
  - navigating to "http://localhost:8080/enrollment.html?session=sensitive-test", waiting until "load"

```

# Test source

```ts
  129 | 
  130 |   test('should show fallback text if QR generation fails', async ({ page }) => {
  131 |     // Block QR library CDN to force fallback
  132 |     await page.route('**/cdn.jsdelivr.net/**', (route) => route.abort());
  133 | 
  134 |     // Same setup as above...
  135 |     await page.addInitScript(() => {
  136 |       (window as any).Telegram = {
  137 |         WebApp: {
  138 |           initData: 'query_id=test&user=%7B%22id%22%3A12345%7D&auth_date=1234567890&hash=test',
  139 |           initDataUnsafe: { query_id: 'test', user: { id: 12345 }, auth_date: 1234567890, hash: 'test' },
  140 |           ready: () => {},
  141 |           expand: () => {},
  142 |         },
  143 |       };
  144 |       (window as any).mockConnectorURI = 'https://world.org/verify?t=wld&i=fallback-test&k=key';
  145 |     });
  146 | 
  147 |     await page.route('**/api/enrollment/session/*', async (route) => {
  148 |       await route.fulfill({
  149 |         status: 200,
  150 |         contentType: 'application/json',
  151 |         body: JSON.stringify({
  152 |           appId: TEST_APP_ID,
  153 |           rpId: TEST_RP_ID,
  154 |           signedChallenge: {
  155 |             action: 'fallback-test',
  156 |             nonce: '0x' + '0'.repeat(64),
  157 |             createdAt: Math.floor(Date.now() / 1000),
  158 |             expiresAt: Math.floor(Date.now() / 1000) + 300,
  159 |             signature: '0x' + '0'.repeat(130),
  160 |           },
  161 |           signal: 'test',
  162 |         }),
  163 |       });
  164 |     });
  165 | 
  166 |     await page.goto('http://localhost:8080/enrollment.html?session=fallback-test');
  167 |     await page.waitForSelector('#status.success', { timeout: 5000 });
  168 | 
  169 |     // Mock IDKit
  170 |     await page.evaluate(() => {
  171 |       (window as any).IDKit = {
  172 |         request: () => ({
  173 |           preset: () => Promise.resolve({
  174 |             connectorURI: (window as any).mockConnectorURI,
  175 |             pollUntilCompletion: () => new Promise(() => {}),
  176 |           }),
  177 |         }),
  178 |       };
  179 |       (window as any).proofOfHuman = () => ({});
  180 |     });
  181 | 
  182 |     await page.click('#verifyButton');
  183 |     await page.waitForSelector('#connectorDisplay:not(.hidden)', { timeout: 5000 });
  184 | 
  185 |     // Verify fallback text containing the URL is shown
  186 |     const qrCodeEl = await page.locator('#qrCode');
  187 |     await expect(qrCodeEl).toBeVisible();
  188 |     
  189 |     const qrHTML = await qrCodeEl.innerHTML();
  190 |     expect(qrHTML).toContain('https://world.org/verify');
  191 |   });
  192 | 
  193 |   test('should not log sensitive session keys in console', async ({ page }) => {
  194 |     const consoleLogs: string[] = [];
  195 |     page.on('console', (msg) => {
  196 |       consoleLogs.push(msg.text());
  197 |     });
  198 | 
  199 |     await page.addInitScript(() => {
  200 |       (window as any).Telegram = {
  201 |         WebApp: {
  202 |           initData: 'query_id=test&user=%7B%22id%22%3A12345%7D&auth_date=1234567890&hash=test',
  203 |           initDataUnsafe: { query_id: 'test', user: { id: 12345 }, auth_date: 1234567890, hash: 'test' },
  204 |           ready: () => {},
  205 |           expand: () => {},
  206 |         },
  207 |       };
  208 |     });
  209 | 
  210 |     await page.route('**/api/enrollment/session/*', async (route) => {
  211 |       await route.fulfill({
  212 |         status: 200,
  213 |         contentType: 'application/json',
  214 |         body: JSON.stringify({
  215 |           appId: TEST_APP_ID,
  216 |           rpId: TEST_RP_ID,
  217 |           signedChallenge: {
  218 |             action: 'sensitive-test',
  219 |             nonce: '0xsecret0123456789',
  220 |             createdAt: Math.floor(Date.now() / 1000),
  221 |             expiresAt: Math.floor(Date.now() / 1000) + 300,
  222 |             signature: '0xsecretSignature',
  223 |           },
  224 |           signal: 'test',
  225 |         }),
  226 |       });
  227 |     });
  228 | 
> 229 |     await page.goto('http://localhost:8080/enrollment.html?session=sensitive-test');
      |                ^ Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:8080/enrollment.html?session=sensitive-test
  230 |     await page.waitForSelector('#status.success', { timeout: 5000 });
  231 | 
  232 |     // Mock IDKit with sensitive session key
  233 |     await page.evaluate(() => {
  234 |       (window as any).IDKit = {
  235 |         request: () => ({
  236 |           preset: () => Promise.resolve({
  237 |             connectorURI: 'https://world.org/verify?k=SENSITIVE_SESSION_KEY_DO_NOT_LOG',
  238 |             pollUntilCompletion: () => new Promise(() => {}),
  239 |           }),
  240 |         }),
  241 |       };
  242 |       (window as any).proofOfHuman = () => ({});
  243 |     });
  244 | 
  245 |     await page.click('#verifyButton');
  246 |     await page.waitForSelector('#connectorDisplay:not(.hidden)', { timeout: 5000 });
  247 | 
  248 |     // Verify session key not logged
  249 |     const sensitiveLogged = consoleLogs.some(log => 
  250 |       log.includes('SENSITIVE_SESSION_KEY') && !log.includes('QR generation failed')
  251 |     );
  252 |     expect(sensitiveLogged).toBe(false);
  253 |   });
  254 | });
  255 | 
```