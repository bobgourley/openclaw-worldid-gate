/**
 * Bundle qrcode library for local serving.
 * 
 * Creates a self-contained browser bundle of qrcode
 * for standards-compliant QR code generation.
 */

import * as esbuild from 'esbuild';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(
  readFileSync(resolve(__dirname, '../package.json'), 'utf-8')
);

const qrcodeVersion = packageJson.dependencies['qrcode'];

try {
  await esbuild.build({
    entryPoints: [resolve(__dirname, '../src/ui/qrcode-bridge.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    outfile: 'dist/ui/qrcode-bundle.js',
    sourcemap: true,
    minify: true,
    banner: {
      js: `/* qrcode ${qrcodeVersion} - bundled for browser */`,
    },
  });
  
  console.log('QRCode bundle created: dist/ui/qrcode-bundle.js');
} catch (error) {
  console.error('Bundle failed:', error);
  process.exit(1);
}
