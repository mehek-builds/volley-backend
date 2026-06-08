import axios from 'axios';

export type VerifyStatus = 'VALID' | 'INVALID' | 'CATCH_ALL' | 'UNKNOWN';

export interface PrimaryVerifyResult {
  status: VerifyStatus;
  isCatchAll: boolean;
  raw: unknown;
}

export interface SecondaryVerifyResult {
  deliverable: boolean;
  confidence: number;
  raw: unknown;
}

export async function verifyPrimary(email: string): Promise<PrimaryVerifyResult> {
  const apiKey = process.env.REOON_API_KEY;

  if (!apiKey) {
    console.warn('[verify] REOON_API_KEY not set - skipping primary verification');
    return { status: 'UNKNOWN', isCatchAll: false, raw: null };
  }

  try {
    const url = `https://emailverifier.reoon.com/api/v1/verify`;
    const response = await axios.get(url, {
      params: { email, key: apiKey, mode: 'power' },
      timeout: 10000,
    });

    const data = response.data as {
      status: string;
      is_safe_to_send: boolean;
      is_catch_all: boolean;
    };

    let status: VerifyStatus;
    switch (data.status) {
      case 'valid':
        status = 'VALID';
        break;
      case 'invalid':
      case 'disposable':
        status = 'INVALID';
        break;
      case 'catch_all':
        status = 'CATCH_ALL';
        break;
      default:
        status = 'UNKNOWN';
    }

    return {
      status,
      isCatchAll: data.is_catch_all ?? false,
      raw: data,
    };
  } catch (err) {
    console.error('[verify] Reoon API error:', err);
    return { status: 'UNKNOWN', isCatchAll: false, raw: null };
  }
}

export async function verifySecondary(email: string): Promise<SecondaryVerifyResult> {
  const apiKey = process.env.BOUNCEBAN_API_KEY;

  if (!apiKey) {
    console.warn('[verify] BOUNCEBAN_API_KEY not set - skipping secondary verification');
    return { deliverable: false, confidence: 0, raw: null };
  }

  try {
    const response = await axios.post(
      'https://api.bounceban.com/v1/verify',
      { email, api_key: apiKey },
      { timeout: 10000 }
    );

    const data = response.data as {
      result: 'deliverable' | 'undeliverable' | 'unknown';
      confidence: number;
    };

    return {
      deliverable: data.result === 'deliverable',
      confidence: data.confidence ?? 0,
      raw: data,
    };
  } catch (err) {
    console.error('[verify] BounceBan API error:', err);
    return { deliverable: false, confidence: 0, raw: null };
  }
}
