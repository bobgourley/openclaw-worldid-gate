# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: src/ui/enrollment-decrypt-error.browser.test.ts >> Decryption error handling >> SDK handles corrupted encrypted response with user-facing error
- Location: src/ui/enrollment-decrypt-error.browser.test.ts:110:3

# Error details

```
Error: expect(received).toMatch(expected)

Expected pattern: /fail|error|invalid/i
Received string:  "Unable to connect to World App. Please try again."
```

# Test source

```ts
  99  |     serverPort = typeof address === 'object' && address !== null ? address.port : 0;
  100 |     
  101 |     (service as any).stubTransport = stubTransport;
  102 |   });
  103 | 
  104 |   test.afterAll(async () => {
  105 |     if (service) {
  106 |       await service.stop();
  107 |     }
  108 |   });
  109 | 
  110 |   test('SDK handles corrupted encrypted response with user-facing error', async ({ page, request }) => {
  111 |     console.log('\n=== Testing corrupted encrypted response handling ===');
  112 | 
  113 |     // Send webhook /verify
  114 |     const webhookUpdate = {
  115 |       update_id: 123456789,
  116 |       message: {
  117 |         message_id: 1,
  118 |         from: {
  119 |           id: TEST_USER_ID,
  120 |           is_bot: false,
  121 |           first_name: 'Alice',
  122 |           username: 'alice_test',
  123 |         },
  124 |         chat: {
  125 |           id: TEST_USER_ID,
  126 |           first_name: 'Alice',
  127 |           username: 'alice_test',
  128 |           type: 'private',
  129 |         },
  130 |         date: Math.floor(Date.now() / 1000),
  131 |         text: '/verify',
  132 |       },
  133 |     };
  134 | 
  135 |     await request.post(`http://127.0.0.1:${serverPort}/telegram/webhook`, {
  136 |       headers: { 'Content-Type': 'application/json' },
  137 |       data: JSON.stringify(webhookUpdate),
  138 |     });
  139 | 
  140 |     const stubTransport = (service as any).stubTransport;
  141 |     const webAppUrl = (stubTransport as any).lastWebAppUrl;
  142 |     const sessionMatch = webAppUrl.match(/session=([0-9a-f]{32})/);
  143 |     const sessionId = sessionMatch![1];
  144 | 
  145 |     const initData = createValidInitData(TEST_USER_ID, TEST_BOT_TOKEN);
  146 | 
  147 |     await page.route('**/telegram-web-app.js', async (route) => {
  148 |       await route.fulfill({
  149 |         status: 200,
  150 |         contentType: 'application/javascript',
  151 |         body: `window.Telegram = { WebApp: { initData: ${JSON.stringify(initData)}, ready: function() {}, expand: function() {} } };`,
  152 |       });
  153 |     });
  154 | 
  155 |     // Mock bridge with corrupted response
  156 |     await page.route('**bridge.worldcoin.org/**', async (route) => {
  157 |       const url = route.request().url();
  158 |       
  159 |       if (url.includes('/request') && route.request().method() === 'POST') {
  160 |         await route.fulfill({
  161 |           status: 200,
  162 |           contentType: 'application/json',
  163 |           body: JSON.stringify({ request_id: 'test_corrupted' }),
  164 |         });
  165 |       } else if (url.includes('/response/')) {
  166 |         // Return corrupted encrypted response
  167 |         await route.fulfill({
  168 |           status: 200,
  169 |           contentType: 'application/json',
  170 |           body: JSON.stringify({
  171 |             status: 'completed',
  172 |             response: {
  173 |               iv: 'aW52YWxpZF9pdg==',  // Invalid IV
  174 |               payload: 'Y29ycnVwdGVkX3BheWxvYWQ=',  // Corrupted payload
  175 |             },
  176 |           }),
  177 |         });
  178 |       } else {
  179 |         await route.abort();
  180 |       }
  181 |     });
  182 | 
  183 |     const enrollmentUrl = `http://127.0.0.1:${serverPort}/enrollment?session=${sessionId}`;
  184 |     await page.goto(enrollmentUrl);
  185 |     await page.waitForLoadState('networkidle');
  186 | 
  187 |     const verifyButton = page.locator('#verifyButton');
  188 |     await verifyButton.click();
  189 | 
  190 |     // Wait for SDK to attempt decryption
  191 |     await page.waitForTimeout(5000);
  192 | 
  193 |     const statusEl = page.locator('#status');
  194 |     const finalStatus = await statusEl.textContent();
  195 | 
  196 |     console.log('Final status after corrupted response:', finalStatus);
  197 | 
  198 |     // Should show user-facing error, not crash
> 199 |     expect(finalStatus).toMatch(/fail|error|invalid/i);
      |                         ^ Error: expect(received).toMatch(expected)
  200 | 
  201 |     await page.screenshot({ 
  202 |       path: '/opt/cursor/artifacts/enrollment-decrypt-error.png',
  203 |       fullPage: true 
  204 |     });
  205 | 
  206 |     console.log('✓ SDK handled corrupted response gracefully');
  207 |   });
  208 | });
  209 | 
```