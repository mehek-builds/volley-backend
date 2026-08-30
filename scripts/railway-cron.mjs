const baseUrl = process.env.PUBLIC_API_BASE?.trim()?.replace(/\/+$/, '');
const path = process.env.CRON_PATH?.trim();
const secret = process.env.INTERNAL_CRON_SECRET?.trim() || process.env.CRON_SECRET?.trim();

if (!baseUrl || !path || !path.startsWith('/') || !secret) {
  console.error('Cron requires PUBLIC_API_BASE, CRON_PATH, and INTERNAL_CRON_SECRET or CRON_SECRET');
  process.exit(2);
}

const url = new URL(path, `${baseUrl}/`);
if (url.origin !== new URL(baseUrl).origin) {
  console.error('CRON_PATH must stay on PUBLIC_API_BASE');
  process.exit(2);
}

const response = await fetch(url, {
  method: process.env.CRON_METHOD?.trim() || 'POST',
  headers: { Authorization: `Bearer ${secret}` },
  signal: AbortSignal.timeout(290_000),
});
const detail = await response.text();
if (!response.ok) {
  console.error(`Cron ${path} failed with ${response.status}: ${detail.slice(0, 1000)}`);
  process.exit(1);
}
console.log(`Cron ${path} completed with ${response.status}: ${detail.slice(0, 1000)}`);
