export const FORSIGHT_COMEET_WRAPPER_URL =
  'https://forsightrobotics.com/positions/position-35_c68';
export const FORSIGHT_COMEET_APPLICATION_URL =
  'https://www.comeet.co/jobs/E9.008/35.C68/apply?token=9E845581DB8009E83B7027A001DB8';

const FORSIGHT_COMPANY_UID = 'E9.008';
const FORSIGHT_POSITION_UID = '35.C68';
const FORSIGHT_TOKEN = '9E845581DB8009E83B7027A001DB8';
const COMEET_API_SOURCE = '//www.comeet.co/careers-api/api.js';
const MAX_WRAPPER_HTML_CHARS = 1_000_000;

export type ComeetWrapperFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Pick<Response, 'headers' | 'ok' | 'status' | 'text' | 'url'>>;

interface ScriptElement {
  attributes: string;
  body: string;
}

interface JsToken {
  kind: 'identifier' | 'string' | 'punctuation';
  value: string;
  quote?: '"' | "'";
}

function scriptElements(html: string): ScriptElement[] {
  const activeHtml = html.replace(/<!--[\s\S]*?-->/g, '');
  return [...activeHtml.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
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
      tokens.push({
        kind: 'string',
        value: source.slice(index + 1, cursor),
        quote,
      });
      index = cursor + 1;
      continue;
    }
    const identifier = source.slice(index).match(/^[A-Za-z_$][A-Za-z0-9_$]*/)?.[0];
    if (identifier) {
      tokens.push({ kind: 'identifier', value: identifier });
      index += identifier.length;
      continue;
    }
    tokens.push({ kind: 'punctuation', value: current });
    index += 1;
  }
  return tokens;
}

function sequenceAt(tokens: readonly JsToken[], index: number, values: readonly string[]): boolean {
  return values.every((value, offset) => tokens[index + offset]?.value === value);
}

function sequenceIndexes(tokens: readonly JsToken[], values: readonly string[]): number[] {
  return tokens.flatMap((_token, index) => sequenceAt(tokens, index, values) ? [index] : []);
}

function matchingBrace(tokens: readonly JsToken[], openIndex: number): number | undefined {
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index += 1) {
    if (tokens[index]?.value === '{') depth += 1;
    if (tokens[index]?.value === '}') depth -= 1;
    if (depth === 0) return index;
  }
  return undefined;
}

function normalizedIdentityProperty(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function parseIdentityObject(
  tokens: readonly JsToken[],
  openIndex: number,
): { endIndex: number; properties: ReadonlyMap<string, string> } | undefined {
  if (tokens[openIndex]?.value !== '{') return undefined;
  const properties = new Map<string, string>();
  let index = openIndex + 1;
  while (tokens[index]?.value !== '}') {
    const key = tokens[index];
    const separator = tokens[index + 1];
    const value = tokens[index + 2];
    if (key?.kind !== 'string' || key.quote !== '"' || key.value.includes('\\')) return undefined;
    if (separator?.value !== ':') return undefined;
    if (value?.kind !== 'string' || value.quote !== '"' || value.value.includes('\\')) return undefined;
    const normalizedKey = normalizedIdentityProperty(key.value);
    if (!normalizedKey || properties.has(normalizedKey)) return undefined;
    properties.set(normalizedKey, value.value);
    index += 3;
    if (tokens[index]?.value === ',') {
      index += 1;
      if (tokens[index]?.value === '}') break;
      continue;
    }
    if (tokens[index]?.value !== '}') return undefined;
  }
  if (tokens[index]?.value !== '}') return undefined;
  return { endIndex: index, properties };
}

function exactComeetIdentity(scriptBody: string): boolean {
  const tokens = tokenizeJavascript(scriptBody);
  if (!tokens) return false;
  const bindingPattern = ['window', '.', 'comeetInit', '=', 'function', '(', ')', '{'] as const;
  const bindingIndexes = sequenceIndexes(tokens, bindingPattern);
  const initPattern = ['COMEET', '.', 'init', '('] as const;
  const initIndexes = sequenceIndexes(tokens, initPattern);
  if (bindingIndexes.length !== 1 || initIndexes.length !== 1) return false;

  const bindingIndex = bindingIndexes[0]!;
  const bodyStart = bindingIndex + bindingPattern.length;
  const bodyEnd = matchingBrace(tokens, bodyStart - 1);
  const initIndex = initIndexes[0]!;
  if (bodyEnd === undefined || initIndex !== bodyStart || initIndex >= bodyEnd) return false;
  const parsed = parseIdentityObject(tokens, initIndex + initPattern.length);
  if (!parsed || tokens[parsed.endIndex + 1]?.value !== ')') return false;
  let afterCall = parsed.endIndex + 2;
  if (tokens[afterCall]?.value === ';') afterCall += 1;
  if (afterCall !== bodyEnd) return false;
  if (parsed.properties.get('token') !== FORSIGHT_TOKEN) return false;
  if (parsed.properties.get('companyuid') !== FORSIGHT_COMPANY_UID) return false;
  const positionUid = parsed.properties.get('positionuid');
  if (positionUid !== undefined && positionUid !== FORSIGHT_POSITION_UID) return false;

  const apiAssignments: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const isDotAssignment = sequenceAt(tokens, index, ['js', '.', 'src', '=']);
    const isBracketAssignment = tokens[index]?.value === 'js'
      && tokens[index + 1]?.value === '['
      && tokens[index + 2]?.kind === 'string'
      && tokens[index + 2]?.value === 'src'
      && tokens[index + 3]?.value === ']'
      && tokens[index + 4]?.value === '=';
    if (!isDotAssignment && !isBracketAssignment) continue;
    const value = tokens[index + (isDotAssignment ? 4 : 5)];
    if (value?.kind !== 'string') return false;
    apiAssignments.push(value.value);
  }
  return apiAssignments.length === 1 && apiAssignments[0] === COMEET_API_SOURCE;
}

export function isTrustedComeetApplicationUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    const authorityEnd = rawUrl.indexOf('/', rawUrl.indexOf('://') + 3);
    if (authorityEnd < 0) return false;
    const rawOrigin = rawUrl.slice(0, authorityEnd);
    const pathEndCandidates = [rawUrl.indexOf('?', authorityEnd), rawUrl.indexOf('#', authorityEnd)]
      .filter((value) => value >= 0);
    const pathEnd = pathEndCandidates.length > 0 ? Math.min(...pathEndCandidates) : rawUrl.length;
    const rawPath = rawUrl.slice(authorityEnd, pathEnd);
    return (rawOrigin === 'https://www.comeet.co' || rawOrigin === 'https://www.comeet.co:443')
      && url.protocol === 'https:'
      && url.hostname.toLowerCase() === 'www.comeet.co'
      && !url.port
      && !url.username
      && !url.password
      && rawPath === '/jobs/E9.008/35.C68/apply'
      && url.pathname === rawPath
      && !url.hash
      && rawUrl.slice(pathEnd) === `?token=${FORSIGHT_TOKEN}`
      && url.search === `?token=${FORSIGHT_TOKEN}`
      && url.searchParams.getAll('token').length === 1
      && url.searchParams.get('token') === FORSIGHT_TOKEN
      && [...url.searchParams.keys()].length === 1;
  } catch {
    return false;
  }
}

export function isTrustedComeetWrapperUrl(rawUrl: string): boolean {
  if (rawUrl !== FORSIGHT_COMEET_WRAPPER_URL) return false;
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:'
      && url.hostname.toLowerCase() === 'forsightrobotics.com'
      && !url.port
      && !url.username
      && !url.password
      && url.pathname === '/positions/position-35_c68'
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}

export function comeetApplicationUrlFromWrapperMarkup(
  wrapperUrl: string,
  html: string,
): string | undefined {
  if (!isTrustedComeetWrapperUrl(wrapperUrl) || html.length > MAX_WRAPPER_HTML_CHARS) return undefined;
  const wrapperPosition = new URL(wrapperUrl).pathname.match(/^\/positions\/position-(\d+)_([a-z0-9]+)$/i);
  const pathPositionUid = wrapperPosition
    ? `${wrapperPosition[1]}.${wrapperPosition[2]}`.toUpperCase()
    : '';
  if (pathPositionUid !== FORSIGHT_POSITION_UID) return undefined;

  const scripts = scriptElements(html);
  const applyFormMarkers = scripts.filter((script) => /comeet-applyform/i.test(script.attributes));
  if (applyFormMarkers.length !== 1) return undefined;
  const applyFormAttributes = exactQuotedAttributes(applyFormMarkers[0]!.attributes);
  if (!applyFormAttributes) return undefined;
  if (applyFormAttributes.get('type')?.toLowerCase() !== 'comeet-applyform') return undefined;
  if (applyFormAttributes.get('data-position-uid') !== FORSIGHT_POSITION_UID) return undefined;

  const initScripts = scripts.filter((script) => sequenceIndexes(
    tokenizeJavascript(script.body) ?? [],
    ['COMEET', '.', 'init', '('],
  ).length > 0);
  if (initScripts.length !== 1 || !exactComeetIdentity(initScripts[0]!.body)) return undefined;
  return FORSIGHT_COMEET_APPLICATION_URL;
}

export async function resolveTrustedComeetWrapperApplicationUrl(
  wrapperUrl: string,
  fetchImpl: ComeetWrapperFetch = fetch,
): Promise<string | undefined> {
  if (!isTrustedComeetWrapperUrl(wrapperUrl)) return undefined;
  try {
    const response = await fetchImpl(wrapperUrl, {
      redirect: 'error',
      headers: { accept: 'text/html' },
    });
    if (!response.ok || response.status !== 200 || response.url !== FORSIGHT_COMEET_WRAPPER_URL) return undefined;
    if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'text/html') {
      return undefined;
    }
    return comeetApplicationUrlFromWrapperMarkup(wrapperUrl, await response.text());
  } catch {
    return undefined;
  }
}