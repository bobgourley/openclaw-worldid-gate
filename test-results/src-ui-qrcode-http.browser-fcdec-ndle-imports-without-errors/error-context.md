# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: src/ui/qrcode-http.browser.test.ts >> QR Code HTTP Integration >> QR bundle imports without errors
- Location: src/ui/qrcode-http.browser.test.ts:236:3

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: true
Received: false
```

# Test source

```ts
  159 |     // Extract canvas image data
  160 |     const imageData = await page.evaluate(() => {
  161 |       const canvas = document.querySelector('#test-qr-container canvas') as HTMLCanvasElement;
  162 |       if (!canvas) throw new Error('Canvas not found');
  163 | 
  164 |       const ctx = canvas.getContext('2d');
  165 |       if (!ctx) throw new Error('Canvas context not found');
  166 | 
  167 |       const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  168 |       return {
  169 |         data: Array.from(imgData.data),
  170 |         width: imgData.width,
  171 |         height: imgData.height,
  172 |       };
  173 |     });
  174 | 
  175 |     // Decode QR code using independent decoder
  176 |     const decoded = jsQR(
  177 |       new Uint8ClampedArray(imageData.data),
  178 |       imageData.width,
  179 |       imageData.height
  180 |     );
  181 | 
  182 |     // Verify QR decoded successfully
  183 |     if (!decoded || !decoded.data) {
  184 |       console.error('QR decode failed. Canvas may not have rendered.');
  185 |       throw new Error(`QR decode failed: decoded=${decoded}`);
  186 |     }
  187 |     
  188 |     // CRITICAL: Verify exact URI match
  189 |     expect(decoded.data).toBe(syntheticConnectorURI);
  190 |   });
  191 | 
  192 |   test('QR decoding preserves base64 special characters', async ({ page }) => {
  193 |     const uriWithSpecialChars = 'https://world.org/verify?t=wld&i=test-uuid&k=ABC+def/123==';
  194 | 
  195 |     await page.goto(`${BASE_URL}/enrollment`);
  196 |     await page.waitForLoadState('networkidle');
  197 | 
  198 |     await page.evaluate(async (uri) => {
  199 |       const container = document.createElement('div');
  200 |       container.id = 'test-special-chars-qr';
  201 |       document.body.appendChild(container);
  202 | 
  203 |       // @ts-ignore - enrollment.html exposes this on window
  204 |       if (typeof window.generateQRCode === 'function') {
  205 |         await window.generateQRCode(uri, container);
  206 |       }
  207 |     }, uriWithSpecialChars);
  208 | 
  209 |     await page.waitForSelector('#test-special-chars-qr canvas', { timeout: 5000 });
  210 | 
  211 |     const imageData = await page.evaluate(() => {
  212 |       const canvas = document.querySelector('#test-special-chars-qr canvas') as HTMLCanvasElement;
  213 |       const ctx = canvas?.getContext('2d');
  214 |       if (!ctx) throw new Error('Canvas context not found');
  215 | 
  216 |       const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  217 |       return {
  218 |         data: Array.from(imgData.data),
  219 |         width: imgData.width,
  220 |         height: imgData.height,
  221 |       };
  222 |     });
  223 | 
  224 |     const decoded = jsQR(
  225 |       new Uint8ClampedArray(imageData.data),
  226 |       imageData.width,
  227 |       imageData.height
  228 |     );
  229 | 
  230 |     expect(decoded?.data).toBe(uriWithSpecialChars);
  231 |     expect(decoded?.data).toContain('+');
  232 |     expect(decoded?.data).toContain('/');
  233 |     expect(decoded?.data).toContain('==');
  234 |   });
  235 | 
  236 |   test('QR bundle imports without errors', async ({ page }) => {
  237 |     const consoleErrors: string[] = [];
  238 | 
  239 |     page.on('console', msg => {
  240 |       if (msg.type() === 'error') {
  241 |         consoleErrors.push(msg.text());
  242 |       }
  243 |     });
  244 | 
  245 |     await page.goto(`${BASE_URL}/enrollment`);
  246 |     await page.waitForLoadState('networkidle');
  247 | 
  248 |     // Import QR bundle explicitly
  249 |     const importSuccess = await page.evaluate(async () => {
  250 |       try {
  251 |         const module = await import('/qrcode-bundle.js');
  252 |         return module.QRCode !== undefined;
  253 |       } catch (error) {
  254 |         console.error('QR bundle import failed:', error);
  255 |         return false;
  256 |       }
  257 |     });
  258 | 
> 259 |     expect(importSuccess).toBe(true);
      |                           ^ Error: expect(received).toBe(expected) // Object.is equality
  260 | 
  261 |     // Check for import errors
  262 |     const importErrors = consoleErrors.filter(err => 
  263 |       err.includes('qrcode-bundle') || err.includes('import')
  264 |     );
  265 |     expect(importErrors).toEqual([]);
  266 |   });
  267 | 
  268 |   test('enrollment page generateQRCode function exists', async ({ page }) => {
  269 |     await page.goto(`${BASE_URL}/enrollment`);
  270 |     await page.waitForLoadState('networkidle');
  271 | 
  272 |     const hasFn = await page.evaluate(() => {
  273 |       return typeof (window as any).generateQRCode === 'function';
  274 |     });
  275 | 
  276 |     expect(hasFn).toBe(true);
  277 |   });
  278 | });
  279 | 
```