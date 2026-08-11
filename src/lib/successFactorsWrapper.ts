export const SAP_SUCCESSFACTORS_WRAPPER_URL =
  'https://jobs.sap.com/job/Walldorf-SAP-LOB-%26-Solution-Marketing-iXp-Intern-%28fmd%29-Marketing-Germany-69190/1403234233/';
export const SAP_SUCCESSFACTORS_APPLICATION_URL =
  'https://career5.successfactors.eu/sfcareer/jobreqcareer?jobId=455609&company=SAP';

const MAX_WRAPPER_HTML_CHARS = 2_000_000;
const SAP_WRAPPER_ORIGIN = 'https://jobs.sap.com';

export type SuccessFactorsWrapperFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Pick<Response, 'headers' | 'ok' | 'status' | 'text' | 'url'>>;

interface WrapperIdentity {
  externalJobId: string;
  rawPath: string;
  slug: string;
}

interface HtmlElement {
  attributes: string;
  body: string;
}

interface JsToken {
  kind: 'identifier' | 'number' | 'punctuation' | 'string';
  value: string;
}

type JsValue =
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null'; value: null }
  | { kind: 'number'; value: string }
  | { kind: 'object'; value: ReadonlyMap<string, JsValue> }
  | { kind: 'string'; value: string };

function wrapperIdentity(rawUrl: string): WrapperIdentity | undefined {
  if (!rawUrl.startsWith(`${SAP_WRAPPER_ORIGIN}/`)) return undefined;
  const suffix = rawUrl.slice(SAP_WRAPPER_ORIGIN.length);
  if (/[?#]/.test(suffix)) return undefined;
  const match = suffix.match(/^\/job\/([A-Za-z0-9._~%&()-]+)\/(\d{6,})\/$/);
  if (!match) return undefined;
  const [, rawSlug, externalJobId] = match;
  if (!rawSlug || !externalJobId || /%(?![0-9A-Fa-f]{2})/.test(rawSlug)) return undefined;
  for (const encoded of rawSlug.matchAll(/%([0-9A-Fa-f]{2})/g)) {
    const byte = Number.parseInt(encoded[1]!, 16);
    if (byte <= 0x20 || byte === 0x25 || byte === 0x2e || byte === 0x2f || byte === 0x5c || byte === 0x7f) {
      return undefined;
    }
  }
  try {
    const url = new URL(rawUrl);
    if (url.origin !== SAP_WRAPPER_ORIGIN || url.pathname !== suffix || url.username || url.password || url.port) {
      return undefined;
    }
    return { externalJobId, rawPath: suffix, slug: decodeURIComponent(rawSlug).normalize('NFC') };
  } catch {
    return undefined;
  }
}

export function sameTrustedSuccessFactorsWrapperIdentity(left: string, right: string): boolean {
  const leftIdentity = wrapperIdentity(left);
  const rightIdentity = wrapperIdentity(right);
  return Boolean(
    leftIdentity
    && rightIdentity
    && leftIdentity.externalJobId === rightIdentity.externalJobId
    && leftIdentity.slug === rightIdentity.slug,
  );
}

function activeHtml(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

function elements(html: string, tagName: 'a' | 'script' | 'span'): HtmlElement[] {
  const rawElements = tagName === 'script'
    ? /<(style|textarea|title|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi
    : /<(script|style|textarea|title|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
  const source = activeHtml(html).replace(rawElements, '');
  const pattern = tagName === 'script'
    ? /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi
    : tagName === 'a'
      ? /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi
      : /<span\b([^>]*)>([\s\S]*?)<\/span\s*>/gi;
  return [...source.matchAll(pattern)]
    .map((match) => ({ attributes: match[1] ?? '', body: match[2] ?? '' }));
}

function exactQuotedAttributes(source: string): ReadonlyMap<string, string> | undefined {
  const attributes = new Map<string, string>();
  let index = 0;
  while (index < source.length) {
    while (/\s/.test(source[index] ?? '')) index += 1;
    if (index >= source.length) break;
    const name = source.slice(index).match(/^[A-Za-z_:][A-Za-z0-9_.:-]*/)?.[0];
    if (!name) return undefined;
    index += name.length;
    while (/\s/.test(source[index] ?? '')) index += 1;
    if (source[index] !== '=') return undefined;
    index += 1;
    while (/\s/.test(source[index] ?? '')) index += 1;
    const quote = source[index];
    if (quote !== '"' && quote !== "'") return undefined;
    index += 1;
    const end = source.indexOf(quote, index);
    if (end < 0) return undefined;
    const value = source.slice(index, end);
    if (/[<>]/.test(value)) return undefined;
    const normalizedName = name.toLowerCase();
    if (attributes.has(normalizedName)) return undefined;
    attributes.set(normalizedName, value);
    index = end + 1;
  }
  return attributes;
}

function tokenizeJavascript(source: string): JsToken[] | undefined {
  const tokens: JsToken[] = [];
  let index = 0;
  while (index < source.length) {
    const current = source[index]!;
    if (/\s/.test(current)) {
      index += 1;
      continue;
    }
    if (current === '/' && source[index + 1] === '/') {
      const newline = source.indexOf('\n', index + 2);
      index = newline < 0 ? source.length : newline + 1;
      continue;
    }
    if (current === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      if (end < 0) return undefined;
      index = end + 2;
      continue;
    }
    if (current === '"' || current === "'") {
      const quote = current;
      let cursor = index + 1;
      let escaped = false;
      while (cursor < source.length) {
        const character = source[cursor]!;
        if (!escaped && character === quote) break;
        if (!escaped && (character === '\n' || character === '\r')) return undefined;
        escaped = !escaped && character === '\\';
        if (character !== '\\') escaped = false;
        cursor += 1;
      }
      if (cursor >= source.length) return undefined;
      tokens.push({ kind: 'string', value: source.slice(index + 1, cursor) });
      index = cursor + 1;
      continue;
    }
    const identifier = source.slice(index).match(/^[A-Za-z_$][A-Za-z0-9_$]*/)?.[0];
    if (identifier) {
      tokens.push({ kind: 'identifier', value: identifier });
      index += identifier.length;
      continue;
    }
    const number = source.slice(index).match(/^(?:0|[1-9]\d*)/)?.[0];
    if (number) {
      tokens.push({ kind: 'number', value: number });
      index += number.length;
      continue;
    }
    tokens.push({ kind: 'punctuation', value: current });
    index += 1;
  }
  return tokens;
}

function normalizedPropertyName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function parseValue(tokens: readonly JsToken[], start: number): { end: number; value: JsValue } | undefined {
  const token = tokens[start];
  if (!token) return undefined;
  if (token.kind === 'string') return { end: start + 1, value: { kind: 'string', value: token.value } };
  if (token.kind === 'number') return { end: start + 1, value: { kind: 'number', value: token.value } };
  if (token.kind === 'identifier' && (token.value === 'true' || token.value === 'false')) {
    return { end: start + 1, value: { kind: 'boolean', value: token.value === 'true' } };
  }
  if (token.kind === 'identifier' && token.value === 'null') {
    return { end: start + 1, value: { kind: 'null', value: null } };
  }
  if (token.value !== '{') return undefined;
  const properties = new Map<string, JsValue>();
  let index = start + 1;
  while (tokens[index]?.value !== '}') {
    const key = tokens[index];
    if (!key || (key.kind !== 'identifier' && key.kind !== 'string')) return undefined;
    if (key.value.includes('\\') || tokens[index + 1]?.value !== ':') return undefined;
    const normalizedKey = normalizedPropertyName(key.value);
    if (!normalizedKey || properties.has(normalizedKey)) return undefined;
    const parsedValue = parseValue(tokens, index + 2);
    if (!parsedValue) return undefined;
    properties.set(normalizedKey, parsedValue.value);
    index = parsedValue.end;
    if (tokens[index]?.value === ',') {
      index += 1;
      if (tokens[index]?.value === '}') break;
      continue;
    }
    if (tokens[index]?.value !== '}') return undefined;
  }
  if (tokens[index]?.value !== '}') return undefined;
  return { end: index + 1, value: { kind: 'object', value: properties } };
}

function sequenceAt(tokens: readonly JsToken[], index: number, values: readonly string[]): boolean {
  return values.every((value, offset) => {
    const token = tokens[index + offset];
    if (token?.value !== value) return false;
    return !/^[A-Za-z_$]/.test(value) || token.kind === 'identifier';
  });
}

function hasComputedJ2wInitAccess(scripts: readonly HtmlElement[]): boolean {
  for (const script of scripts) {
    const tokens = tokenizeJavascript(script.body);
    if (!tokens) continue;
    for (let index = 0; index < tokens.length; index += 1) {
      if (tokens[index]?.kind !== 'identifier' || tokens[index]?.value !== 'j2w') continue;
      if (tokens[index + 1]?.value === '[') return true;
      if (
        sequenceAt(tokens, index, ['j2w', '.', 'Apply'])
        || sequenceAt(tokens, index, ['j2w', '.', 'SSO'])
      ) {
        if (tokens[index + 3]?.value === '[') return true;
      }
    }
  }
  return false;
}

function oneCallObject(scripts: readonly HtmlElement[], pattern: readonly string[]): ReadonlyMap<string, JsValue> | undefined {
  const calls: Array<{ index: number; tokens: readonly JsToken[] }> = [];
  for (const script of scripts) {
    const tokens = tokenizeJavascript(script.body);
    if (!tokens) continue;
    for (let index = 0; index < tokens.length; index += 1) {
      if (!sequenceAt(tokens, index, pattern)) continue;
      if (tokens[index - 1]?.value === '.') return undefined;
      calls.push({ index, tokens });
    }
  }
  if (calls.length !== 1) return undefined;
  const call = calls[0]!;
  const parsed = parseValue(call.tokens, call.index + pattern.length);
  if (!parsed || parsed.value.kind !== 'object' || call.tokens[parsed.end]?.value !== ')') return undefined;
  return parsed.value.value;
}

function oneWindowLocationHref(scripts: readonly HtmlElement[]): string | undefined {
  const values: string[] = [];
  const pattern = ['window', '.', 'location', '.', 'href', '='] as const;
  for (const script of scripts) {
    const tokens = tokenizeJavascript(script.body);
    if (!tokens) continue;
    for (let index = 0; index < tokens.length; index += 1) {
      if (!sequenceAt(tokens, index, pattern)) continue;
      if (tokens[index - 1]?.value === '.') return undefined;
      const value = tokens[index + pattern.length];
      if (value?.kind !== 'string') return undefined;
      values.push(value.value);
    }
  }
  return values.length === 1 ? values[0] : undefined;
}

function stringValue(object: ReadonlyMap<string, JsValue>, name: string): string | undefined {
  const value = object.get(normalizedPropertyName(name));
  return value?.kind === 'string' ? value.value : undefined;
}

function numericValue(object: ReadonlyMap<string, JsValue>, name: string): string | undefined {
  const value = object.get(normalizedPropertyName(name));
  return value?.kind === 'number' ? value.value : undefined;
}

function booleanValue(object: ReadonlyMap<string, JsValue>, name: string): boolean | undefined {
  const value = object.get(normalizedPropertyName(name));
  return value?.kind === 'boolean' ? value.value : undefined;
}

function objectValue(
  object: ReadonlyMap<string, JsValue>,
  name: string,
): ReadonlyMap<string, JsValue> | undefined {
  const value = object.get(normalizedPropertyName(name));
  return value?.kind === 'object' ? value.value : undefined;
}

function exactApplyAnchors(html: string, externalJobId: string): boolean {
  const candidates = elements(html, 'a').filter((element) =>
    /dialogApplyBtn|talentcommunity\/apply/i.test(element.attributes));
  if (candidates.length === 0) return false;
  const expectedHref = `/talentcommunity/apply/${externalJobId}/?locale=en_US`;
  return candidates.every((candidate) => {
    const attributes = exactQuotedAttributes(candidate.attributes);
    const classes = attributes?.get('class')?.split(/\s+/).filter(Boolean) ?? [];
    return Boolean(attributes)
      && classes.includes('dialogApplyBtn')
      && attributes?.get('href') === expectedHref;
  });
}

function structuralRequisitionId(html: string): string | undefined {
  const markers = elements(html, 'span').filter((element) =>
    /data-careersite-propertyid\s*=/i.test(element.attributes));
  const facilities: string[] = [];
  for (const marker of markers) {
    const attributes = exactQuotedAttributes(marker.attributes);
    if (!attributes) return undefined;
    if (attributes.get('data-careersite-propertyid') !== 'facility') continue;
    const requisitionId = marker.body.trim();
    if (!/^\d+$/.test(requisitionId)) return undefined;
    facilities.push(requisitionId);
  }
  return facilities.length === 1 ? facilities[0] : undefined;
}

function exactTenantOrigin(rawUrl: string): string | undefined {
  if (!/^https:\/\/career\d+\.successfactors\.(?:com|eu)$/.test(rawUrl)) return undefined;
  try {
    const url = new URL(rawUrl);
    return url.origin === rawUrl && !url.username && !url.password && !url.port ? url.hostname : undefined;
  } catch {
    return undefined;
  }
}

function loginBindingAgrees(rawUrl: string | undefined, tenantHost: string, company: string): boolean {
  if (!rawUrl) return false;
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:'
      && url.hostname === tenantHost
      && !url.username
      && !url.password
      && !url.port
      && url.pathname === '/career'
      && !url.hash
      && url.searchParams.getAll('career_company').length === 1
      && url.searchParams.get('career_company') === company
      && url.searchParams.getAll('company').length === 1
      && url.searchParams.get('company') === company
      && url.searchParams.getAll('lang').length === 1
      && url.searchParams.get('lang') === 'en_US'
      && url.searchParams.getAll('loginFlowRequired').length === 1
      && url.searchParams.get('loginFlowRequired') === 'true';
  } catch {
    return false;
  }
}

export function isTrustedSuccessFactorsWrapperUrl(rawUrl: string): boolean {
  return Boolean(wrapperIdentity(rawUrl));
}

export function successFactorsApplicationUrlFromWrapperMarkup(
  wrapperUrl: string,
  html: string,
): string | undefined {
  const wrapper = wrapperIdentity(wrapperUrl);
  if (!wrapper || html.length > MAX_WRAPPER_HTML_CHARS) return undefined;
  if (!exactApplyAnchors(html, wrapper.externalJobId)) return undefined;

  const scripts = elements(html, 'script');
  if (hasComputedJ2wInitAccess(scripts)) return undefined;
  const root = oneCallObject(scripts, ['j2w', '.', 'init', '(',]);
  const apply = oneCallObject(scripts, ['j2w', '.', 'Apply', '.', 'init', '(']);
  const sso = oneCallObject(scripts, ['j2w', '.', 'SSO', '.', 'init', '(']);
  if (!root || !apply || !sso) return undefined;

  const company = stringValue(root, 'ssoCompanyId');
  const tenantUrl = stringValue(root, 'ssoUrl');
  const tenantHost = tenantUrl ? exactTenantOrigin(tenantUrl) : undefined;
  if (!company || !/^[A-Za-z0-9_-]+$/.test(company) || !tenantHost) return undefined;
  if (booleanValue(root, 'useSSL') !== true || booleanValue(root, 'isUsingSSL') !== true) return undefined;
  if (!loginBindingAgrees(oneWindowLocationHref(scripts), tenantHost, company)) return undefined;

  const applyExternalId = numericValue(apply, 'jobID');
  const applyLocale = stringValue(apply, 'locale');
  const sourceId = stringValue(apply, 'sourceId');
  const linkedIn = objectValue(apply, 'applyWithLinkedIn2Config');
  const internalId = linkedIn ? stringValue(linkedIn, 'internalId') : undefined;
  if (applyExternalId !== wrapper.externalJobId || applyLocale !== 'en_US') return undefined;
  if (sourceId !== `JATS-${company}` || booleanValue(apply, 'useOnPageBusinessCard') !== true) return undefined;
  const requisitionId = internalId?.match(/^(\d+)-en_US$/)?.[1];
  if (!requisitionId || structuralRequisitionId(html) !== requisitionId) return undefined;

  const ssoExternalId = stringValue(sso, 'jobID') ?? numericValue(sso, 'jobID');
  if (ssoExternalId !== wrapper.externalJobId || stringValue(sso, 'locale') !== applyLocale) return undefined;
  if (booleanValue(sso, 'usingRD') !== true) return undefined;

  return `https://${tenantHost}/sfcareer/jobreqcareer?jobId=${encodeURIComponent(requisitionId)}`
    + `&company=${encodeURIComponent(company)}`;
}

export async function resolveSuccessFactorsWrapperApplicationUrl(
  wrapperUrl: string,
  fetchImpl: SuccessFactorsWrapperFetch = fetch,
): Promise<string | undefined> {
  if (!isTrustedSuccessFactorsWrapperUrl(wrapperUrl)) return undefined;
  try {
    const response = await fetchImpl(wrapperUrl, {
      redirect: 'error',
      headers: { accept: 'text/html' },
      signal: AbortSignal.timeout(10_000),
    });
    if (
      !response.ok
      || response.status !== 200
      || !sameTrustedSuccessFactorsWrapperIdentity(wrapperUrl, response.url)
    ) return undefined;
    if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'text/html') {
      return undefined;
    }
    return successFactorsApplicationUrlFromWrapperMarkup(wrapperUrl, await response.text());
  } catch {
    return undefined;
  }
}
