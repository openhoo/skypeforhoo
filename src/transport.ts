import { AuthenticationError, HttpError, ProtocolError, UntrustedOriginError } from './errors.js';
import type { AuthContext, Fetch, HttpResult, RequestOptions, Transport, TransportOptions, UcwaResource } from './types.js';

export function httpsUrl(value: string, base?: string): URL {
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    throw new ProtocolError('The server returned an invalid URL.');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new ProtocolError('Skype for Business URLs must use HTTPS and must not contain credentials.');
  }
  url.hash = '';
  return url;
}

/** No global logging, cookie storage or automatic retries of failed operations. */
export class UcwaTransport implements Transport {
  readonly #options: TransportOptions;
  readonly #fetch: Fetch;
  readonly #origins = new Set<string>();

  constructor(options: TransportOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    for (const origin of options.trustedOrigins) this.#origins.add(httpsUrl(origin).origin);
    if (!Number.isFinite(options.timeoutMs ?? 200_000) || (options.timeoutMs ?? 200_000) <= 0) {
      throw new RangeError('timeoutMs must be a positive finite number.');
    }
    if (!Number.isInteger(options.maxRedirects ?? 5) || (options.maxRedirects ?? 5) < 0) {
      throw new RangeError('maxRedirects must be a nonnegative integer.');
    }
  }

  async #trust(url: URL, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.#origins.has(url.origin)) return;
    if (await withSignal(Promise.resolve(this.#options.trustOrigin?.(url.origin)), signal)) {
      this.#origins.add(url.origin);
      return;
    }
    throw new UntrustedOriginError(url.origin);
  }

  /** Authentication providers use this to contact token issuers under the same policy. */
  readonly #guardedFetch: Fetch = async (input, init) => {
    const url = httpsUrl(input instanceof Request ? input.url : input.toString());
    // Preserve Request bodies and headers for custom providers, but never browser cookies.
    const request = input instanceof Request ? new Request(input, init) : undefined;
    const signal = init?.signal ?? request?.signal;
    await this.#trust(url, signal ?? undefined);
    rejectAmbientCredentials(new Headers(init?.headers ?? request?.headers));
    return this.#fetch(request ?? url.toString(), {
      ...init,
      redirect: 'manual',
      credentials: 'omit',
    });
  };

  async request<T = UcwaResource>(input: string, options: RequestOptions = {}): Promise<HttpResult<T>> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), this.#options.timeoutMs ?? 200_000);
    try {
      return await this.#request<T>(input, options, controller.signal);
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  async #request<T>(input: string, options: RequestOptions, signal: AbortSignal): Promise<HttpResult<T>> {
    const method = (options.method ?? 'GET').toUpperCase();
    const headers = new Headers(options.headers);
    if (!headers.has('Accept')) headers.set('Accept', 'application/json');
    if (options.json !== undefined && options.body !== undefined) throw new TypeError('Use json or body, not both.');
    let body = options.body;
    if (body && typeof body === 'object' && 'getReader' in body) {
      throw new TypeError('Streaming request bodies cannot be replayed after an authentication challenge. Use a string, Blob, ArrayBuffer, FormData or URLSearchParams.');
    }
    if (options.json !== undefined) {
      body = JSON.stringify(options.json);
      if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    }
    rejectAmbientCredentials(headers);
    const initialAuthorization = headers.get('Authorization');
    if (initialAuthorization) {
      throw new TypeError('Supply credentials through an AuthProvider instead of the Authorization header.');
    }
    let url = httpsUrl(input);
    let redirects = 0;
    let challenged = false;
    let authorization: string | undefined;
    while (true) {
      signal.throwIfAborted();
      await this.#trust(url, signal);
      const auth = options.authenticated === false ? undefined : this.#options.auth;
      const context: AuthContext = {
        url: url.toString(), signal,
        fetch: async (input, init) => {
          signal.throwIfAborted();
          // Password token acquisition can supply its own signal for shared waiters.
          return this.#guardedFetch(input, { ...init, signal: init?.signal ?? signal });
        },
      };
      authorization ??= await withSignal(Promise.resolve(auth?.getAuthorization(context)), signal);
      signal.throwIfAborted();
      if (authorization) headers.set('Authorization', authorization);
      else headers.delete('Authorization');
      const response = await withSignal(this.#guardedFetch(url, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        signal,
      }), signal);
      if (response.type === 'opaqueredirect') {
        throw new ProtocolError('A browser-hidden redirect cannot be followed safely. Use a native fetch adapter.');
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await cancelResponseBody(response, signal);
        const location = response.headers.get('Location');
        if (!location) throw new ProtocolError('The redirect response has no Location header.');
        if (method !== 'GET' && method !== 'HEAD') {
          throw new ProtocolError(`Refusing to replay ${method} after an HTTP redirect.`);
        }
        if (++redirects > (this.#options.maxRedirects ?? 5)) throw new ProtocolError('Too many HTTP redirects.');
        url = httpsUrl(location, url.toString());
        // A different origin must pass trust policy and obtain its own authorization.
        authorization = undefined;
        challenged = false;
        continue;
      }
      if (response.status === 401 && auth && !challenged) {
        challenged = true;
        const challenge = response.headers.get('WWW-Authenticate') ?? '';
        let authorizationFailed = true;
        try {
          auth.invalidate?.(url.toString());
          authorization = await withSignal(auth.getAuthorization({ ...context, challenge, response }), signal);
          if (!authorization) throw new AuthenticationError('The authentication provider did not return authorization for the server challenge.', challenge);
          authorizationFailed = false;
        } finally {
          try {
            await cancelResponseBody(response, signal);
          } catch (error) {
            // Disposal must not hide an existing authentication/cancellation failure.
            if (!authorizationFailed) throw error;
          }
        }
        continue;
      }
      const data = await withSignal(parseResponse(response, method), signal);
      if (response.status === 401) {
        throw new AuthenticationError('The server rejected authentication.', response.headers.get('WWW-Authenticate') ?? undefined);
      }
      if (!response.ok && response.status !== 304) throw new HttpError(response.status, url.toString(), response, data);
      return { data: data as T | undefined, response, url: url.toString() };
    }
  }
}

function rejectAmbientCredentials(headers: Headers): void {
  if (headers.has('Cookie') || headers.has('Proxy-Authorization')) {
    throw new TypeError('Cookie and Proxy-Authorization headers are not supported. Use an origin-scoped AuthProvider.');
  }
}

/** Keep observing late cleanup while cancellation bounds the request's wait. */
function cancelResponseBody(response: Response, signal: AbortSignal): Promise<void> {
  return withSignal(Promise.resolve().then(() => response.body?.cancel()), signal);
}

/** Bound caller-visible latency even when a custom provider ignores cancellation. */
function withSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', abort); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', abort); reject(error); },
    );
    if (signal.aborted) abort();
  });
}

async function parseResponse(response: Response, method: string): Promise<unknown> {
  if (method === 'HEAD' || [204, 205, 304].includes(response.status)) return undefined;
  const text = await response.text();
  if (!text.trim()) return undefined;
  const contentType = response.headers.get('Content-Type') ?? '';
  if (/json/i.test(contentType) || (!contentType && /^[\[{]/.test(text.trim()))) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ProtocolError('The server returned malformed JSON.');
    }
  }
  return text;
}
