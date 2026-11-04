import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthenticationError, HttpError, ProtocolError, UntrustedOriginError } from '../src/errors.js';
import { UcwaTransport } from '../src/transport.js';
import type { AuthProvider, Fetch } from '../src/types.js';

const origin = 'https://pool.example.com';
const json = (body: unknown, status = 200, headers: HeadersInit = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', ...headers },
});

test('uses scoped authorization and preserves JSON, no-content, 304, and text responses', async () => {
  const responses = [json({ ok: true }), new Response(null, { status: 204 }), new Response(null, { status: 304 }), new Response('hello', { headers: { 'Content-Type': 'text/plain' } })];
  const seen: RequestInit[] = [];
  const fetch: Fetch = async (_input, init) => { seen.push(init ?? {}); return responses.shift()!; };
  const transport = new UcwaTransport({ trustedOrigins: [origin], fetch, auth: { async getAuthorization() { return 'Bearer example'; } } });
  assert.deepEqual((await transport.request(`${origin}/resource`, { method: 'POST', json: { value: 1 } })).data, { ok: true });
  assert.equal(seen[0]?.body, '{"value":1}');
  assert.equal(new Headers(seen[0]?.headers).get('Authorization'), 'Bearer example');
  assert.equal(seen[0]?.redirect, 'manual');
  assert.equal(seen[0]?.credentials, 'omit');
  assert.equal((await transport.request(`${origin}/empty`)).data, undefined);
  assert.equal((await transport.request(`${origin}/cached`)).response.status, 304);
  assert.equal((await transport.request<string>(`${origin}/plain`)).data, 'hello');
});

test('rejects untrusted endpoints and HTTP downgrades before sending credentials', async () => {
  let requests = 0;
  const fetch: Fetch = async () => { requests++; return json({}); };
  const transport = new UcwaTransport({ trustedOrigins: [origin], fetch });
  await assert.rejects(transport.request('https://other.example.com/private'), UntrustedOriginError);
  await assert.rejects(transport.request('http://pool.example.com/private'), ProtocolError);
  await assert.rejects(transport.request('https://user:password@pool.example.com/private'), ProtocolError);
  assert.equal(requests, 0);
});

test('does not attach authentication to public discovery requests', async () => {
  const fetch: Fetch = async (_input, init) => {
    assert.equal(new Headers(init?.headers).get('Authorization'), null);
    return json({});
  };
  const transport = new UcwaTransport({ trustedOrigins: [origin], fetch, auth: { async getAuthorization() { throw new Error('must not authenticate'); } } });
  await transport.request(`${origin}/`, { authenticated: false });
});

test('handles a single authentication challenge and stops after a rejected retry', async () => {
  let requests = 0;
  let invalidated = false;
  const auth: AuthProvider = {
    async getAuthorization(context) { return context.challenge ? 'Bearer fresh' : undefined; },
    invalidate() { invalidated = true; },
  };
  const fetch: Fetch = async (_input, init) => {
    requests++;
    if (requests === 1) assert.equal(new Headers(init?.headers).get('Authorization'), null);
    else assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer fresh');
    return new Response(null, { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="example"' } });
  };
  const transport = new UcwaTransport({ trustedOrigins: [origin], fetch, auth });
  await assert.rejects(transport.request(`${origin}/user`), AuthenticationError);
  assert.equal(requests, 2);
  assert.equal(invalidated, true);
});

test('checks a token issuer against the same origin policy', async () => {
  let requests = 0;
  const fetch: Fetch = async () => { requests++; return new Response(null, { status: 401 }); };
  const auth: AuthProvider = {
    async getAuthorization(context) {
      if (context.challenge !== undefined) await context.fetch('https://untrusted.example.com/token', { method: 'POST', body: 'password=example' });
      return undefined;
    },
  };
  const transport = new UcwaTransport({ trustedOrigins: [origin], fetch, auth });
  await assert.rejects(transport.request(`${origin}/user`), UntrustedOriginError);
  assert.equal(requests, 1);
});

test('obtains fresh origin-scoped authorization after redirects and prevents write replay', async () => {
  const targets: string[] = [];
  const fetch: Fetch = async (input, init) => {
    const url = input.toString(); targets.push(url);
    assert.equal(new Headers(init?.headers).get('Authorization'), url.startsWith(origin) ? 'Bearer pool' : 'Bearer other');
    return url.startsWith(origin) ? new Response(null, { status: 302, headers: { Location: 'https://other.example.com/final' } }) : json({ ok: true });
  };
  const transport = new UcwaTransport({
    trustedOrigins: [origin],
    trustOrigin: (candidate) => candidate === 'https://other.example.com',
    fetch,
    auth: { async getAuthorization({ url }) { return url.startsWith(origin) ? 'Bearer pool' : 'Bearer other'; } },
  });
  assert.deepEqual((await transport.request(`${origin}/redirect`)).data, { ok: true });
  await assert.rejects(transport.request(`${origin}/write`, { method: 'POST', json: { text: 'do not resend' } }), ProtocolError);
  assert.equal(targets.length, 3);
});

test('surfaces status and parsed server error without retrying a failed send', async () => {
  let requests = 0;
  const fetch: Fetch = async () => { requests++; return json({ code: 'busy' }, 503); };
  const transport = new UcwaTransport({ trustedOrigins: [origin], fetch });
  await assert.rejects(transport.request(`${origin}/send`, { method: 'POST', body: 'hello' }), (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 503);
    assert.deepEqual(error.data, { code: 'busy' });
    return true;
  });
  assert.equal(requests, 1);
});

test('cancellation and timeouts abort in-flight fetch', async () => {
  const fetch: Fetch = async (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    if (init?.signal?.aborted) reject(init.signal.reason);
  });
  const transport = new UcwaTransport({ trustedOrigins: [origin], fetch, timeoutMs: 20 });
  await assert.rejects(transport.request(`${origin}/wait`), { name: 'TimeoutError' });
  const controller = new AbortController();
  const promise = transport.request(`${origin}/wait`, { signal: controller.signal });
  controller.abort();
  await assert.rejects(promise, { name: 'AbortError' });
});

test('timeout also bounds noncooperating authentication and trust callbacks', async () => {
  const fetch: Fetch = async () => { throw new Error('must not reach fetch'); };
  const authTransport = new UcwaTransport({
    trustedOrigins: [origin], fetch, timeoutMs: 10,
    auth: { getAuthorization: () => new Promise(() => {}) },
  });
  await assert.rejects(authTransport.request(`${origin}/user`), { name: 'TimeoutError' });
  const trustTransport = new UcwaTransport({ trustedOrigins: [], fetch, timeoutMs: 10, trustOrigin: () => new Promise(() => {}) });
  await assert.rejects(trustTransport.request(`${origin}/user`), { name: 'TimeoutError' });
});

test('a late custom auth provider cannot start a credential request after cancellation', async () => {
  let requests = 0;
  let release: (() => void) | undefined;
  let lateRequest: Promise<unknown> | undefined;
  const controller = new AbortController();
  const transport = new UcwaTransport({
    trustedOrigins: [origin],
    fetch: async () => { requests++; return json({}); },
    auth: {
      async getAuthorization(context) {
        await new Promise<void>((resolve) => { release = resolve; });
        lateRequest = context.fetch(`${origin}/token`);
        await lateRequest;
        return 'Bearer stale';
      },
    },
  });
  const request = transport.request(`${origin}/user`, { signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  await assert.rejects(request, { name: 'AbortError' });
  release!();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await assert.rejects(lateRequest!, { name: 'AbortError' });
  assert.equal(requests, 0);
});

test('rejects explicit ambient credential headers and streaming bodies before networking', async () => {
  let requests = 0;
  const transport = new UcwaTransport({ trustedOrigins: [origin], fetch: async () => { requests++; return json({}); } });
  for (const header of ['Cookie', 'Proxy-Authorization', 'Authorization']) {
    await assert.rejects(transport.request(`${origin}/user`, { headers: { [header]: 'private' } }), TypeError);
  }
  await assert.rejects(transport.request(`${origin}/send`, { method: 'POST', body: new ReadableStream() }), TypeError);
  assert.equal(requests, 0);
});
