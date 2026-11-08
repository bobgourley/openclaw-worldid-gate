/**
 * QR Code browser bridge - re-exports qrcode library for local bundling.
 */

import QRCode from 'qrcode';

// Re-export for browser use
export { QRCode };

// Expose on window for enrollment.html
if (typeof window !== 'undefined') {
  (window as any).QRCodeLib = QRCode;
}
