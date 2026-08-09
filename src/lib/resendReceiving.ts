export function resendReceivingApiKey(): string | null {
  return process.env.RESEND_RECEIVING_API_KEY?.trim()
    || process.env.RESEND_API_KEY?.trim()
    || null;
}

export async function assertResendReceivedEmailReadable(emailId: string): Promise<void> {
  const key = resendReceivingApiKey();
  if (!key) throw new Error('RESEND_RECEIVING_API_KEY or RESEND_API_KEY is required to read received email content');
  const response = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`, {
    headers: { Authorization: `Bearer ${key}`, 'User-Agent': 'Litos/1.0' },
  });
  if (!response.ok) {
    throw new Error(`Resend received email lookup failed with ${response.status}`);
  }
}
