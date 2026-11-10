/**
 * IDKit browser bridge - re-exports installed SDK for local bundling.
 * 
 * This module imports from the installed @worldcoin/idkit-core package
 * and re-exports for browser use. Bundled by esbuild into dist/ui/idkit-bundle.js.
 *
 * hashSignal comes from the documented `@worldcoin/idkit-core/hashing` subpath. The
 * enrollment page uses it only to show whether the action in the SDK debug report
 * matches the expected action (diagnostics panel); it is never sent anywhere.
 */

import { IDKit, proofOfHuman, CredentialRequest } from '@worldcoin/idkit-core';
import { hashSignal } from '@worldcoin/idkit-core/hashing';

// Re-export for browser use
export { IDKit, proofOfHuman, CredentialRequest, hashSignal };

// Expose on window for backward compatibility with existing HTML
if (typeof window !== 'undefined') {
  (window as any).WorldIDKit = { IDKit, proofOfHuman, CredentialRequest, hashSignal };
}
