import assert from 'node:assert/strict';
import test from 'node:test';
import { bearerAuth, passwordAuth } from '../src/auth.js';
import { AuthenticationError, ProtocolError } from '../src/errors.js';
import type { AuthContext, Fetch } from '../src/types.js';

const challenge = 'MsRtcOAuth href=https://pool.example.com/WebTicket/oauthtoken,grant_type="urn:microsoft.rtc:windows,password"';
const response = () => Response.json({ access_token: 'cwt=fixture-token', token_type: 'Bearer', expires_in: 3600 });
const context = (fetch: Fetch, extra: Partial<AuthContext> = {}): AuthContext => ({
  url: 'https://pool.example.com/Autodiscover/root/user', fetch, ...extra,
});

test('bearerAuth supports static tokens and host-controlled renewal', async () => {
  const calls: string[] = [];
  const ctx = context(async () => { throw new Error('Unexpected request'); });
  assert.equal(await bearerAuth('fixture').getAuthorization(ctx), 'Bearer fixture');
  const provider = bearerAuth(async ({ url }) => { calls.push(url); return 'renewed'; });
  assert.equal(await provider.getAuthorization(ctx), 'Bearer renewed');
  assert.deepEqual(calls, [ctx.url]);
  await assert.rejects(bearerAuth('\r\ninvalid').getAuthorization(ctx), AuthenticationError);
});

test('passwordAuth waits for a password-capable challenge and preserves the advanced login name', async () => {
  const requests: { url: string; options?: RequestInit }[] = [];
  const fetch: Fetch = async (input, options) => { requests.push({ url: String(input), ...(options ? { options } : {}) }); return response(); };
  const provider = passwordAuth({ username: 'EXAMPLE\\alice', password: 'fixture&secret=1' });
  assert.equal(await provider.getAuthorization(context(fetch)), undefined);
  assert.equal(requests.length, 0);
  assert.equal(await provider.getAuthorization(context(fetch, { challenge })), 'Bearer cwt=fixture-token');
  assert.equal(requests[0]!.url, 'https://pool.example.com/WebTicket/oauthtoken');
  const body = new URLSearchParams(String(requests[0]!.options!.body));
  assert.equal(body.get('username'), 'EXAMPLE\\alice');
  assert.equal(body.get('password'), 'fixture&secret=1');
  assert.equal(body.get('grant_type'), 'password');
  assert.equal(requests[0]!.options!.redirect, 'manual');
  assert.equal(requests[0]!.options!.credentials, 'omit');
  assert.equal(await provider.getAuthorization(context(fetch)), 'Bearer cwt=fixture-token');
  assert.equal(requests.length, 1);
});

test('passwordAuth accepts quoted relative href and does not read parameters from another scheme', async () => {
  let url = '';
  const fetch: Fetch = async (input) => { url = String(input); return response(); };
  const provider = passwordAuth({ username: 'alice@example.com', password: 'fixture' });
  await provider.getAuthorization(context(fetch, {
    challenge: 'Bearer realm="first", MsRtcOAuth href="/token",grant_type="password", Bearer href="https://other.example/token"',
  }));
  assert.equal(url, 'https://pool.example.com/token');
});

test('Bearer-only and Windows-only servers require a different authentication provider', async () => {
  let calls = 0;
  const fetch: Fetch = async () => { calls += 1; return response(); };
  const provider = passwordAuth({ username: 'alice', password: 'fixture' });
  await assert.rejects(provider.getAuthorization(context(fetch, { challenge: 'Bearer trusted_issuers="fixture"' })), /custom AuthProvider/);
  await assert.rejects(provider.getAuthorization(context(fetch, { challenge: 'MsRtcOAuth href="/token",grant_type="urn:microsoft.rtc:windows"' })), /password grant/);
  assert.equal(calls, 0);
});

test('token endpoints must use HTTPS even if the challenge or explicit configuration asks otherwise', async () => {
  const fetch: Fetch = async () => { throw new Error('A downgrade must not reach fetch'); };
  assert.throws(() => passwordAuth({ username: 'alice', password: 'fixture', tokenUrl: 'http://pool.example.com/token' }), ProtocolError);
  await assert.rejects(passwordAuth({ username: 'alice', password: 'fixture' }).getAuthorization(context(fetch, {
    challenge: 'MsRtcOAuth href="http://pool.example.com/token",grant_type="password"',
  })), ProtocolError);
});

test('explicit token endpoints use guarded fetch and refresh after invalidation', async () => {
  let calls = 0;
  const fetch: Fetch = async () => { calls += 1; return response(); };
  const provider = passwordAuth({ username: 'alice', password: 'fixture', tokenUrl: 'https://auth.example.com/token' });
  await provider.getAuthorization(context(fetch));
  await provider.getAuthorization(context(fetch));
  assert.equal(calls, 1);
  provider.invalidate?.('https://pool.example.com/resource');
  await provider.getAuthorization(context(fetch));
  assert.equal(calls, 2);
});

test('token cache is scoped to the resource origin', async () => {
  let calls = 0;
  const fetch: Fetch = async () => { calls += 1; return response(); };
  const provider = passwordAuth({ username: 'alice', password: 'fixture', tokenUrl: 'https://auth.example.com/token' });
  await provider.getAuthorization(context(fetch));
  await provider.getAuthorization(context(fetch, { url: 'https://other.example.com/user' }));
  assert.equal(calls, 2);
});

test('token requests are deduplicated and one cancelled waiter does not cancel another', async () => {
  let calls = 0;
  let complete!: () => void;
  let tokenSignal: AbortSignal | undefined;
  const fetch: Fetch = async (_input, options) => {
    calls += 1;
    tokenSignal = options?.signal ?? undefined;
    await new Promise<void>((resolve) => { complete = resolve; });
    return response();
  };
  const provider = passwordAuth({ username: 'alice', password: 'fixture', tokenUrl: 'https://auth.example.com/token' });
  const firstAbort = new AbortController();
  const first = provider.getAuthorization(context(fetch, { signal: firstAbort.signal }));
  const second = provider.getAuthorization(context(fetch));
  firstAbort.abort();
  await assert.rejects(first, { name: 'AbortError' });
  assert.equal(tokenSignal?.aborted, false);
  complete();
  assert.equal(await second, 'Bearer cwt=fixture-token');
  assert.equal(calls, 1);
});

test('simultaneous unauthorized requests can invalidate the cache without duplicating token acquisition', async () => {
  let calls = 0;
  let complete!: () => void;
  const fetch: Fetch = async () => {
    calls += 1;
    await new Promise<void>((resolve) => { complete = resolve; });
    return response();
  };
  const provider = passwordAuth({ username: 'alice', password: 'fixture' });
  provider.invalidate?.('https://pool.example.com/first');
  const first = provider.getAuthorization(context(fetch, { challenge }));
  provider.invalidate?.('https://pool.example.com/second');
  const second = provider.getAuthorization(context(fetch, { challenge }));
  complete();
  assert.deepEqual(await Promise.all([first, second]), ['Bearer cwt=fixture-token', 'Bearer cwt=fixture-token']);
  assert.equal(calls, 1);
});

test('cancelling all token waiters aborts the shared token request', async () => {
  let tokenSignal: AbortSignal | undefined;
  const fetch: Fetch = async (_input, options) => {
    tokenSignal = options?.signal ?? undefined;
    return new Promise<Response>((_resolve, reject) => {
      tokenSignal?.addEventListener('abort', () => reject(tokenSignal?.reason), { once: true });
    });
  };
  const provider = passwordAuth({ username: 'alice', password: 'fixture', tokenUrl: 'https://auth.example.com/token' });
  const controller = new AbortController();
  const pending = provider.getAuthorization(context(fetch, { signal: controller.signal }));
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(tokenSignal?.aborted, true);
});

test('invalid and failed token responses do not expose arbitrary response bodies', async () => {
  const provider = () => passwordAuth({ username: 'alice', password: 'fixture-secret', tokenUrl: 'https://auth.example.com/token' });
  await assert.rejects(provider().getAuthorization(context(async () => new Response('fixture-secret', { status: 400 }))), (error: unknown) => {
    assert(error instanceof AuthenticationError);
    assert.equal(error.message.includes('fixture-secret'), false);
    return true;
  });
  for (const value of [null, [], {}, { access_token: '' }, { access_token: 'fixture', token_type: 'Basic' }]) {
    await assert.rejects(provider().getAuthorization(context(async () => Response.json(value))), AuthenticationError);
  }
});

test('token responses without an advertised lifetime are not cached indefinitely', async () => {
  let calls = 0;
  const fetch: Fetch = async () => { calls += 1; return Response.json({ access_token: 'fixture' }); };
  const provider = passwordAuth({ username: 'alice', password: 'fixture', tokenUrl: 'https://auth.example.com/token' });
  await provider.getAuthorization(context(fetch));
  await provider.getAuthorization(context(fetch));
  assert.equal(calls, 2);
});
