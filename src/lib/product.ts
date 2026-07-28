export const PRODUCT_NAME = 'Litos';
export const API_VERSION = '1';

// These identifiers are migration-safe aliases. Keep them until their external
// systems have moved: the current website, Chrome listing, and support inbox all
// continue to work while Litos becomes the display brand.
export const PRODUCT_LINKS = {
  website: process.env.PRODUCT_WEBSITE_URL || 'https://trylitos.com',
  install:
    process.env.PRODUCT_INSTALL_URL ||
    'https://chromewebstore.google.com/detail/bdbedbmkjpfioknfpmhookefabipjaad',
  privacy:
    process.env.PRODUCT_PRIVACY_URL ||
    'https://trylitos.com/privacy',
  // Served publicly at /v1/meta, so this fallback was shipping a dead address
  // under the old brand to every client that read it. rolequick.com does not
  // resolve. This is the address the Chrome Web Store listing already
  // publishes, so the two surfaces now agree.
  supportEmail: process.env.PRODUCT_SUPPORT_EMAIL || 'mehekbuilds@gmail.com',
} as const;

export const CLIENT_COMPATIBILITY = {
  extension: { minimum: '0.4.4' },
  web: { minimum: '0.1.0' },
} as const;

export function publicProductConfig() {
  return {
    product: {
      name: PRODUCT_NAME,
      links: PRODUCT_LINKS,
    },
    api: {
      version: API_VERSION,
      compatibility: CLIENT_COMPATIBILITY,
    },
  } as const;
}
