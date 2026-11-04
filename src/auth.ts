import { AuthenticationError, ProtocolError } from './errors.js';
import type { AuthContext, AuthProvider } from './types.js';

export type BearerToken = string | ((context: AuthContext) => string | Promise<string>);

/** Supply an access token, or delegate token renewal to the host application. */
export function bearerAuth(token: BearerToken): AuthProvider {
  return {
    async getAuthorization(context) {
      const value = typeof token === 'function' ? await token(context) : token;
      return `Bearer ${validateToken(value)}`;
    },
  };
}

export interface PasswordAuthOptions {
  /** The advanced login name, which can differ from the SIP sign-in address. */
  username: string;
  password: string;
  /** Optional, administrator-confirmed OAuth password endpoint. Never guessed. */
  tokenUrl?: string;
}

interface CachedToken {
  token: string;
  usableUntil: number;
}

interface Acquisition {
  promise: Promise<string>;
  controller: AbortController;
  waiters: number;
  settled: boolean;
  endpoint: string;
}

/**
 * UCWA's documented on-premises MsRtcOAuth password grant.
 * This does not implement Windows integrated authentication, WS-Trust or AD FS.
 */
export function passwordAuth(options: PasswordAuthOptions): AuthProvider {
  if (!options.username || !options.password) {
    throw new AuthenticationError('passwordAuth requires a login username and password.');
  }
  const configuredEndpoint = options.tokenUrl ? httpsUrl(options.tokenUrl).href : undefined;
  const cache = new Map<string, CachedToken>();
  const pending = new Map<string, Acquisition>();

  return {
    invalidate(url) {
      const origin = httpsUrl(url).origin;
      cache.delete(origin);
    },

    async getAuthorization(context) {
      context.signal?.throwIfAborted();
      const origin = httpsUrl(context.url).origin;
      const cached = cache.get(origin);
      if (cached && Date.now() < cached.usableUntil) return `Bearer ${cached.token}`;

      // A challenge is necessary unless the caller explicitly selected an endpoint.
      if (!configuredEndpoint && !context.challenge) return undefined;
      const endpoint = configuredEndpoint ?? passwordEndpoint(context.challenge!, context.url);
      let acquisition = pending.get(origin);
      if (!acquisition || acquisition.endpoint !== endpoint || acquisition.controller.signal.aborted) {
        const controller = new AbortController();
        const current: Acquisition = {
          controller,
          waiters: 0,
          settled: false,
          endpoint,
          promise: Promise.resolve(''),
        };
        current.promise = acquireToken(context, endpoint, options, controller.signal)
          .then(({ token, lifetimeMs }) => {
            // An adapter can finish after cancellation or after a newer endpoint wins.
            if (lifetimeMs > 0 && !controller.signal.aborted && pending.get(origin) === current) {
              const skew = Math.min(30_000, lifetimeMs / 10);
              cache.set(origin, { token, usableUntil: Date.now() + lifetimeMs - skew });
            }
            return token;
          })
          .finally(() => {
            current.settled = true;
            if (pending.get(origin) === current) pending.delete(origin);
          });
        pending.set(origin, current);
        acquisition = current;
      }
      return `Bearer ${await joinAcquisition(acquisition, context.signal)}`;
    },
  };
}

function validateToken(token: unknown): string {
  if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) {
    throw new AuthenticationError('The token provider returned an invalid access token.');
  }
  return token;
}

function httpsUrl(value: string, base?: string): URL {
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    throw new ProtocolError('Authentication URLs must be valid HTTPS URLs.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new ProtocolError('Authentication URLs must use HTTPS and contain no user information or fragment.');
  }
  return url;
}

function passwordEndpoint(challenge: string, base: string): string {
  let fields: string[] | undefined;
  for (const field of authenticationFields(challenge)) {
    const value = field.trim();
    // Optional whitespace before '=' still belongs to an authentication parameter.
    const parameter = /^[!#$%&'*+\-.^_`|~\da-z]+[ \t]*=/i.test(value);
    const scheme = parameter ? null : /^([!#$%&'*+\-.^_`|~\da-z]+)(?:[ \t]+(.*))?$/i.exec(value);
    if (scheme) {
      // A scheme starts at a field boundary, never inside another scheme's value.
      if (fields) break;
      if (scheme[1]!.toLowerCase() === 'msrtcoauth') fields = [scheme[2] ?? ''];
    } else if (fields) {
      fields.push(field);
    }
  }
  if (!fields) {
    throw new AuthenticationError(
      'The server did not advertise an MsRtcOAuth password grant. Use bearerAuth or a custom AuthProvider for its Bearer, Windows, WebTicket or federated sign-in flow.',
      challenge,
    );
  }
  const parameters = new Map<string, string>();
  const pattern = /^\s*([a-z_][a-z0-9_-]*)\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^,\s"]+))\s*$/i;
  for (const value of fields) {
    const field = pattern.exec(value);
    if (!field) throw new AuthenticationError('The MsRtcOAuth challenge has invalid authentication parameters.', challenge);
    const name = field[1]!.toLowerCase();
    if (parameters.has(name)) throw new AuthenticationError('The MsRtcOAuth challenge contains duplicate authentication parameters.', challenge);
    parameters.set(name, (field[2] ?? field[3] ?? '').replace(/\\(.)/g, '$1'));
  }
  const href = parameters.get('href');
  const grants = parameters.get('grant_type')?.split(',').map((grant) => grant.trim().toLowerCase());
  if (!href || !grants?.includes('password')) {
    throw new AuthenticationError('The MsRtcOAuth challenge does not advertise an endpoint supporting the password grant.', challenge);
  }
  return httpsUrl(href, base).href;
}

/** Split challenge/parameter fields while preserving quoted commas and escaped quotes. */
function authenticationFields(challenge: string): string[] {
  const fields: string[] = [];
  let quoted = false;
  let start = 0;
  for (let index = 0; index < challenge.length; index++) {
    const character = challenge[index];
    if (quoted && character === '\\') {
      index++;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (!quoted && character === ',') {
      fields.push(challenge.slice(start, index));
      start = index + 1;
    }
  }
  fields.push(challenge.slice(start));
  return fields;
}

async function acquireToken(
  context: AuthContext,
  endpoint: string,
  options: PasswordAuthOptions,
  signal: AbortSignal,
): Promise<{ token: string; lifetimeMs: number }> {
  const response = await context.fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'password', username: options.username, password: options.password }).toString(),
    redirect: 'manual',
    credentials: 'omit',
    signal,
  });
  if (!response.ok) {
    // Do not include an echoed password, token or arbitrary server response in errors.
    throw new AuthenticationError(`The OAuth token endpoint returned HTTP ${response.status}.`);
  }
  let result: Record<string, unknown>;
  try {
    const value: unknown = await response.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    result = value as Record<string, unknown>;
  } catch {
    throw new AuthenticationError('The OAuth token endpoint did not return a JSON token response.');
  }
  if (result.token_type !== undefined && (typeof result.token_type !== 'string' || result.token_type.toLowerCase() !== 'bearer')) {
    throw new AuthenticationError('The OAuth token endpoint returned an unsupported token type.');
  }
  const token = validateToken(result.access_token);
  const expires = result.expires_in;
  const seconds = typeof expires === 'number' || (typeof expires === 'string' && expires.trim()) ? Number(expires) : 0;
  const lifetimeMs = Number.isFinite(seconds * 1_000) && seconds > 0 ? seconds * 1_000 : 0;
  return { token, lifetimeMs };
}

function joinAcquisition(acquisition: Acquisition, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let finished = false;
    acquisition.waiters += 1;
    const cleanup = () => {
      finished = true;
      acquisition.waiters -= 1;
      signal?.removeEventListener('abort', abort);
    };
    const abort = () => {
      if (finished) return;
      cleanup();
      if (!acquisition.waiters && !acquisition.settled) acquisition.controller.abort();
      reject(signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    acquisition.promise.then(
      (token) => { if (!finished) { cleanup(); resolve(token); } },
      (error: unknown) => { if (!finished) { cleanup(); reject(error); } },
    );
    // Cancellation may occur between the caller's preflight check and subscription.
    if (signal?.aborted) abort();
  });
}
