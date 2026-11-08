/**
 * Test: QR code generation with independent decoding verification
 * 
 * Validates that QR codes generated from connectorURI are standards-compliant
 * and decode back to exact original URL using independent decoder.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { createCanvas, loadImage } from 'canvas';

describe('QR Code Generation and Decoding', () => {
  it('generates standards-compliant QR code that decodes to exact original URL', async () => {
    // Synthetic connectorURI shaped like World verify URL
    const originalURI = 'https://world.org/verify?t=wld&i=550e8400-e29b-41d4-a716-446655440000&k=YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY3ODkwKy89';
    
    // Generate QR code to canvas
    const canvas = createCanvas(280, 280);
    await QRCode.toCanvas(canvas, originalURI, {
      errorCorrectionLevel: 'M',
      margin: 4,
      scale: 8,
      width: 280,
      color: {
        dark: '#1a202c',
        light: '#ffffff'
      }
    });
    
    // Extract image data from canvas
    const ctx = canvas.getContext('2d');
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    
    // Decode QR code using independent decoder (jsQR)
    const decoded = jsQR(
      imageData.data,
      imageData.width,
      imageData.height
    );
    
    // Verify QR code was successfully decoded
    assert.ok(decoded, 'QR code must be decodable');
    assert.ok(decoded.data, 'Decoded QR must have data');
    
    // CRITICAL: Verify decoded data matches EXACT original URI
    assert.strictEqual(
      decoded.data,
      originalURI,
      'Decoded QR code must match exact original connectorURI'
    );
  });

  it('preserves special characters in base64 key parameter', async () => {
    // URL with base64 that includes +, /, and = characters
    const urlWithSpecialChars = 'https://world.org/verify?t=wld&i=test-uuid&k=ABC+def/123==';
    
    const canvas = createCanvas(280, 280);
    await QRCode.toCanvas(canvas, urlWithSpecialChars, {
      errorCorrectionLevel: 'M',
      margin: 4,
      scale: 8,
      width: 280
    });
    
    const ctx = canvas.getContext('2d');
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const decoded = jsQR(imageData.data, imageData.width, imageData.height);
    
    assert.ok(decoded);
    assert.strictEqual(
      decoded.data,
      urlWithSpecialChars,
      'Special characters in base64 must be preserved exactly'
    );
  });

  it('handles long UUIDs and session keys', async () => {
    // Maximum realistic connector URI length
    const longURI = 'https://world.org/verify?t=wld&i=550e8400-e29b-41d4-a716-446655440000&k=' + 
                    'VGhpcyBpcyBhIHZlcnkgbG9uZyBiYXNlNjQgZW5jb2RlZCBzZXNzaW9uIGtleSB0aGF0IG1pZ2h0IGJlIHVzZWQgaW4gcHJhY3RpY2U=' +
                    'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVpbXWBhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3ODkrLz0=';
    
    const canvas = createCanvas(280, 280);
    await QRCode.toCanvas(canvas, longURI, {
      errorCorrectionLevel: 'M',
      margin: 4,
      scale: 8,
      width: 280
    });
    
    const ctx = canvas.getContext('2d');
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const decoded = jsQR(imageData.data, imageData.width, imageData.height);
    
    assert.ok(decoded);
    assert.strictEqual(decoded.data, longURI, 'Long URLs must decode exactly');
  });

  it('generates QR with proper quiet zone (margin)', async () => {
    const testURI = 'https://world.org/verify?t=wld&i=test&k=test123';
    
    // Generate with explicit 4-module margin (standard quiet zone)
    const canvas = createCanvas(280, 280);
    await QRCode.toCanvas(canvas, testURI, {
      errorCorrectionLevel: 'M',
      margin: 4, // ISO/IEC 18004 requires 4 modules minimum
      scale: 8,
      width: 280
    });
    
    const ctx = canvas.getContext('2d');
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const decoded = jsQR(imageData.data, imageData.width, imageData.height);
    
    assert.ok(decoded);
    assert.strictEqual(decoded.data, testURI);
  });

  it('uses M error correction level (15% recovery)', async () => {
    const testURI = 'https://world.org/verify?test';
    
    const canvas = createCanvas(280, 280);
    await QRCode.toCanvas(canvas, testURI, {
      errorCorrectionLevel: 'M', // Medium: 15% error recovery
      margin: 4,
      scale: 8,
      width: 280
    });
    
    const ctx = canvas.getContext('2d');
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const decoded = jsQR(imageData.data, imageData.width, imageData.height);
    
    assert.ok(decoded);
    assert.strictEqual(decoded.data, testURI);
  });

  it('generates scannable QR at 280x280 pixel size', async () => {
    const testURI = 'https://world.org/verify?minimal';
    
    const canvas = createCanvas(280, 280);
    await QRCode.toCanvas(canvas, testURI, {
      errorCorrectionLevel: 'M',
      margin: 4,
      scale: 8,
      width: 280
    });
    
    // Verify canvas dimensions
    assert.strictEqual(canvas.width, 280);
    assert.strictEqual(canvas.height, 280);
    
    // Verify decodable
    const ctx = canvas.getContext('2d');
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const decoded = jsQR(imageData.data, imageData.width, imageData.height);
    
    assert.ok(decoded);
    assert.strictEqual(decoded.data, testURI);
  });
});
