/**
 * IDKit browser bridge - re-exports installed SDK for local bundling.
 * 
 * This module imports from the installed @worldcoin/idkit-core package
 * and re-exports for browser use. Bundled by esbuild into dist/ui/idkit-bundle.js.
 */

import { IDKit, proofOfHuman } from '@worldcoin/idkit-core';

// Re-export for browser use
export { IDKit, proofOfHuman };

// Expose on window for backward compatibility with existing HTML
if (typeof window !== 'undefined') {
  (window as any).WorldIDKit = { IDKit, proofOfHuman };
}
