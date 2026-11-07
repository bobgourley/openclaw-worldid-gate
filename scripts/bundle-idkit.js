/**
 * Bundle IDKit Core browser exports for local serving.
 * 
 * Creates a self-contained browser bundle of @worldcoin/idkit-core
 * with actual SDK exports (IDKit.request, proofOfHuman preset).
 */

import * as esbuild from 'esbuild';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(
  readFileSync(resolve(__dirname, '../package.json'), 'utf-8')
);

const idkitVersion = packageJson.dependencies['@worldcoin/idkit-core'];

try {
  await esbuild.build({
    entryPoints: [resolve(__dirname, '../src/ui/idkit-bridge.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    outfile: 'dist/ui/idkit-bundle.js',
    sourcemap: true,
    minify: true,
    banner: {
      js: `/* @worldcoin/idkit-core ${idkitVersion} - bundled for browser */`,
    },
  });
  
  console.log('IDKit bundle created: dist/ui/idkit-bundle.js');
} catch (error) {
  console.error('Bundle failed:', error);
  process.exit(1);
}
