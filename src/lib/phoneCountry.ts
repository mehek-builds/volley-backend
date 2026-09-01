/**
 * THE COUNTRY A PHONE NUMBER BELONGS TO, read off its dial code.
 *
 * Two employer controls want this and neither of them is a residence question. Workable renders a
 * fixed `phone_country` select beside its phone field, which portalSubmission has answered from the
 * number's dial code since the Cresta "phone number is too short" regression. Recruitee, and every
 * other board that splits the number into a picker and a field, asks the same thing as a discovered
 * question ("Select country calling code", "Country code", "International dialling code") and until
 * this module existed that question had no intent: RESIDENCE_QUESTION refuses it on purpose, because
 * the value it wants is not where she lives, and nothing else claimed it. Measured live on
 * dsiinnovations.recruitee.com (application a34e5ce2, 2026-09-01): the form's own default already
 * read "United States", the resolver had no opinion, and the run stopped to ask her the one question
 * her profile answers in full.
 *
 * So the rule lives here once, shared by the fixed Workable field and the discovered-question
 * resolver: the number's own dial code decides, and a number with no dial code falls back to the
 * country she lives in, which is where a local number is dialled from. It is a country NAME on
 * purpose, whatever the control's type: a discovered question is resolved once with the live control
 * and again by the refresh with the hardcoded 'text' type (see the phone rule in
 * classifyFieldIntent for the packet_stale deadlock a type-dependent value causes), and a picker's
 * option search lands a name on "United States (+1)" as readily as on "United States".
 */

/**
 * A label asking WHICH CODE, not which number. "Select country calling code", "Country code",
 * "Phone country code", "International dialling code (e.g. +1)". A label that asks for the phone
 * number and merely mentions its code ("phone number with country code +1 201-555-0123", the
 * teamtailor placeholder) is the phone field and must stay with the phone rule, which is why the
 * bare "country code" form has to open the label and "phone number" is refused outright.
 */
export const CALLING_CODE_QUESTION =
  /\b(?:country\s+|phone\s+|international\s+)?(?:calling|dial(?:l?ing)?)\s+code\b|^\s*(?:(?:please\s+)?select\s+(?:your\s+|a\s+)?|your\s+)?(?:phone\s+)?country\s+code\b/i;

const PHONE_NUMBER_ITSELF = /\b(?:phone|mobile|cell(?:ular)?|telephone)\s+numbers?\b/i;

/** True when the label is asking for the dial code as its own answer. */
export function isCallingCodeQuestion(label: string): boolean {
  return CALLING_CODE_QUESTION.test(label) && !PHONE_NUMBER_ITSELF.test(label);
}

export const DIAL_CODE_COUNTRY_LABELS: Record<string, string> = {
  '1': 'United States',
  '7': 'Russia',
  '20': 'Egypt',
  '27': 'South Africa',
  '30': 'Greece',
  '31': 'Netherlands',
  '32': 'Belgium',
  '33': 'France',
  '34': 'Spain',
  '36': 'Hungary',
  '39': 'Italy',
  '40': 'Romania',
  '41': 'Switzerland',
  '43': 'Austria',
  '44': 'United Kingdom',
  '45': 'Denmark',
  '46': 'Sweden',
  '47': 'Norway',
  '48': 'Poland',
  '49': 'Germany',
  '52': 'Mexico',
  '55': 'Brazil',
  '60': 'Malaysia',
  '61': 'Australia',
  '62': 'Indonesia',
  '63': 'Philippines',
  '65': 'Singapore',
  '81': 'Japan',
  '82': 'South Korea',
  '86': 'China',
  '90': 'Turkey',
  '91': 'India',
  '92': 'Pakistan',
  '971': 'United Arab Emirates',
};

export function countryForPhoneField(phone: string | undefined, fallbackCountry: string | undefined): string | undefined {
  if (!phone) return fallbackCountry;
  const digits = phone.trim().startsWith('+') ? phone.replace(/\D/g, '') : '';
  if (!digits) return fallbackCountry;
  const dialCode = Object.keys(DIAL_CODE_COUNTRY_LABELS)
    .filter((code) => digits.startsWith(code))
    .sort((a, b) => b.length - a.length)[0];
  return dialCode ? DIAL_CODE_COUNTRY_LABELS[dialCode] : fallbackCountry;
}
