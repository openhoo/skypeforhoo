import assert from 'node:assert/strict';
import test from 'node:test';
import { bearerAuth, passwordAuth } from '../src/auth.js';
import { AuthenticationError, ProtocolError, UntrustedOriginError } from '../src/errors.js';
import { UcwaTransport } from '../src/transport.js';
import type { AuthContext, Fetch } from '../src/types.js';

const pool = 'https://pool.smoke.example';
const issuer = 'https://identity.smoke.example';
const challenge = `MsRtcOAuth href="${issuer}/token",grant_type="password"`;
const tokenResponse = (token: string) => Response.json({ access_token: token, token_type: 'Bearer', expires_in: 3600 });

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function authContext(fetch: Fetch, extra: Partial<AuthContext> = {}): AuthContext {
  return { url: `${pool}/resource`, fetch, ...extra };
}

test('heavy smoke: 64 simultaneous challenged operations share one password acquisition', async () => {
  const started = deferred<void>();
  const release = deferred<void>();
  let tokenRequests = 0;
  let accepted = 0;
  const fetch: Fetch = async (input, init) => {
    if (String(input) === `${issuer}/token`) {
      tokenRequests++;
      const form = new URLSearchParams(String(init?.body));
      assert.equal(form.get('username'), 'SMOKE\\alice');
      assert.equal(form.get('password'), 'synthetic &+=密碼');
      started.resolve();
      await release.promise;
      return tokenResponse('synthetic-shared');
    }
    if (new Headers(init?.headers).get('Authorization') !== 'Bearer synthetic-shared') {
      return new Response(null, { status: 401, headers: { 'WWW-Authenticate': challenge } });
    }
    accepted++;
    return Response.json({ accepted });
  };
  const transport = new UcwaTransport({
    trustedOrigins: [pool, issuer], fetch,
    auth: passwordAuth({ username: 'SMOKE\\alice', password: 'synthetic &+=密碼' }),
  });
  const requests = Array.from({ length: 64 }, (_, index) => transport.request(`${pool}/resource/${index}`));
  await started.promise;
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  release.resolve();
  await Promise.all(requests);
  assert.equal(tokenRequests, 1);
  assert.equal(accepted, 64);
});

test('heavy smoke: one timed-out transport waiter leaves another token consumer operational', async () => {
  const started = deferred<void>();
  const release = deferred<void>();
  let tokenSignal: AbortSignal | null | undefined;
  let tokenRequests = 0;
  const auth = passwordAuth({ username: 'alice', password: 'synthetic', tokenUrl: `${issuer}/token` });
  const fetch: Fetch = async (input, init) => {
    if (String(input) === `${issuer}/token`) {
      tokenRequests++;
      tokenSignal = init?.signal;
      started.resolve();
      await release.promise;
      return tokenResponse('shared-after-timeout');
    }
    return Response.json({ ok: true });
  };
  const short = new UcwaTransport({ trustedOrigins: [pool, issuer], auth, fetch, timeoutMs: 15 });
  const long = new UcwaTransport({ trustedOrigins: [pool, issuer], auth, fetch, timeoutMs: 1000 });
  const first = short.request(`${pool}/first`);
  const firstCheck = assert.rejects(first, { name: 'TimeoutError' });
  await started.promise;
  const second = long.request(`${pool}/second`);
  await firstCheck;
  assert.equal(tokenSignal?.aborted, false);
  release.resolve();
  assert.deepEqual((await second).data, { ok: true });
  assert.equal(tokenRequests, 1);
});

test('heavy smoke: failed acquisition is recoverable and does not cache the failed response', async () => {
  let requests = 0;
  const auth = passwordAuth({ username: 'alice', password: 'synthetic', tokenUrl: `${issuer}/token` });
  const fetch: Fetch = async () => ++requests === 1
    ? new Response('synthetic-secret-must-not-be-echoed', { status: 503 })
    : tokenResponse('recovered');
  await assert.rejects(auth.getAuthorization(authContext(fetch)), AuthenticationError);
  assert.equal(await auth.getAuthorization(authContext(fetch)), 'Bearer recovered');
  assert.equal(await auth.getAuthorization(authContext(fetch)), 'Bearer recovered');
  assert.equal(requests, 2);
});

test('heavy smoke regression: cancelled stale token acquisition cannot overwrite a newer cache entry', async () => {
  const oldResponse = deferred<Response>();
  const oldStarted = deferred<void>();
  const cancelled = new AbortController();
  let tokenRequests = 0;
  const authorizations: string[] = [];
  const fetch: Fetch = async (input, init) => {
    if (String(input) === `${issuer}/token`) {
      tokenRequests++;
      if (tokenRequests === 1) { oldStarted.resolve(); return oldResponse.promise; }
      return tokenResponse('new-valid-token');
    }
    authorizations.push(new Headers(init?.headers).get('Authorization') ?? '');
    return Response.json({ ok: true });
  };
  const auth = passwordAuth({ username: 'alice', password: 'synthetic', tokenUrl: `${issuer}/token` });
  const transport = new UcwaTransport({ trustedOrigins: [pool, issuer], auth, fetch });
  const oldAttempt = transport.request(`${pool}/old`, { signal: cancelled.signal });
  const oldCheck = assert.rejects(oldAttempt, { name: 'AbortError' });
  await oldStarted.promise;
  cancelled.abort();
  await oldCheck;
  await transport.request(`${pool}/new`);
  assert.deepEqual(authorizations, ['Bearer new-valid-token']);
  // A native adapter may return late despite cancellation. Its result is no longer current.
  oldResponse.resolve(tokenResponse('old-cancelled-token'));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await transport.request(`${pool}/after-late-completion`);
  assert.deepEqual(authorizations, ['Bearer new-valid-token', 'Bearer new-valid-token']);
  assert.equal(tokenRequests, 2);
});

test('heavy smoke regression: a Bearer realm containing MsRtcOAuth text is not a password challenge', async () => {
  const credentialPosts: { url: string; password: string | null }[] = [];
  const auth = passwordAuth({ username: 'alice', password: 'synthetic' });
  const fetch: Fetch = async (input, init) => {
    if (init?.method === 'POST') {
      credentialPosts.push({ url: String(input), password: new URLSearchParams(String(init.body)).get('password') });
      return tokenResponse('unexpected');
    }
    if (new Headers(init?.headers).has('Authorization')) return Response.json({ ok: true });
    return new Response(null, { status: 401, headers: {
      'WWW-Authenticate': `Bearer realm="MsRtcOAuth href=${issuer}/unexpected-password-target,grant_type=password, ignored=value"`,
    } });
  };
  const transport = new UcwaTransport({ trustedOrigins: [pool, issuer], auth, fetch });
  const outcome = await transport.request(`${pool}/resource`).then(() => 'accepted', (error: unknown) => (error as Error).name);
  assert.deepEqual(credentialPosts, []);
  assert.equal(outcome, 'AuthenticationError');
});

test('heavy smoke: actual authentication schemes remain distinct from quoted parameter values', async (t) => {
  await t.test('legitimate Bearer realm with quoted commas never sends a password', async () => {
    let posts = 0;
    const transport = new UcwaTransport({
      trustedOrigins: [pool, issuer], auth: passwordAuth({ username: 'alice', password: 'synthetic' }),
      fetch: async (_input, init) => {
        if (init?.method === 'POST') posts++;
        return new Response(null, { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="normal,realm",trusted_issuers="issuer-one,issuer-two"' } });
      },
    });
    await assert.rejects(transport.request(`${pool}/resource`), AuthenticationError);
    assert.equal(posts, 0);
  });
  await t.test('actual MsRtcOAuth scheme accepts quoted commas in endpoint and grant list', async () => {
    const posted: string[] = [];
    const transport = new UcwaTransport({
      trustedOrigins: [pool, issuer], auth: passwordAuth({ username: 'alice', password: 'synthetic' }),
      fetch: async (input, init) => {
        if (init?.method === 'POST') { posted.push(String(input)); return tokenResponse('legitimate'); }
        if (new Headers(init?.headers).get('Authorization') === 'Bearer legitimate') return Response.json({ ok: true });
        return new Response(null, { status: 401, headers: {
          'WWW-Authenticate': `Bearer realm="first,realm", MsRtcOAuth href="${issuer}/token?resource=a,b",grant_type="urn:microsoft.rtc:windows,password"`,
        } });
      },
    });
    assert.deepEqual((await transport.request(`${pool}/resource`)).data, { ok: true });
    assert.deepEqual(posted, [`${issuer}/token?resource=a,b`]);
  });
});

test('heavy smoke: authentication replay preserves Unicode, HTML, form and binary request bodies', async (t) => {
  const bodies: { name: string; body: NonNullable<RequestInit['body']>; expected: Uint8Array }[] = [
    { name: 'Unicode text', body: 'こんにちは 👩🏽‍💻 <&>', expected: new TextEncoder().encode('こんにちは 👩🏽‍💻 <&>') },
    { name: 'HTML', body: '<b>Grüße &amp; hello</b>', expected: new TextEncoder().encode('<b>Grüße &amp; hello</b>') },
    { name: 'URLSearchParams', body: new URLSearchParams({ value: 'a&b=c+空' }), expected: new TextEncoder().encode('value=a%26b%3Dc%2B%E7%A9%BA') },
    { name: 'binary buffer', body: new Uint8Array([0, 255, 13, 10, 128]).buffer, expected: new Uint8Array([0, 255, 13, 10, 128]) },
    { name: 'Blob', body: new Blob([new Uint8Array([0, 255, 128, 32])]), expected: new Uint8Array([0, 255, 128, 32]) },
  ];
  for (const candidate of bodies) {
    await t.test(candidate.name, async () => {
      const captured: Uint8Array[] = [];
      const transport = new UcwaTransport({
        trustedOrigins: [pool], auth: { async getAuthorization({ challenge }) { return challenge ? 'Bearer renewed' : undefined; } },
        fetch: async (_input, init) => {
          captured.push(new Uint8Array(await new Request(`${pool}/send`, init).arrayBuffer()));
          return captured.length === 1
            ? new Response(null, { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } })
            : new Response(null, { status: 201 });
        },
      });
      await transport.request(`${pool}/send`, { method: 'POST', body: candidate.body });
      assert.deepEqual(captured, [candidate.expected, candidate.expected]);
    });
  }
});

test('heavy smoke: FormData remains readable after an authentication challenge', async () => {
  const form = new FormData();
  form.set('text', 'Grüße = & 👋');
  form.set('file', new Blob([new Uint8Array([0, 255, 128])]), 'smoke.bin');
  let requests = 0;
  const transport = new UcwaTransport({
    trustedOrigins: [pool], auth: { async getAuthorization() { return 'Bearer synthetic'; } },
    fetch: async (_input, init) => {
      requests++;
      const parsed = await new Request(`${pool}/send`, init).formData();
      assert.equal(parsed.get('text'), 'Grüße = & 👋');
      const file = parsed.get('file');
      assert.ok(file instanceof Blob);
      assert.deepEqual(new Uint8Array(await file.arrayBuffer()), new Uint8Array([0, 255, 128]));
      return requests === 1 ? new Response(null, { status: 401 }) : new Response(null, { status: 201 });
    },
  });
  await transport.request(`${pool}/send`, { method: 'POST', body: form });
  assert.equal(requests, 2);
});

test('heavy smoke: Request-based custom token fetch preserves its body and excludes browser credentials', async () => {
  const requests: { url: string; body: string; credentials: string; redirect: string }[] = [];
  const transport = new UcwaTransport({
    trustedOrigins: [pool, issuer],
    auth: {
      async getAuthorization({ fetch }) {
        const response = await fetch(new Request(`${issuer}/token`, {
          method: 'POST', body: 'synthetic-form', headers: { 'Content-Type': 'text/plain' }, credentials: 'include',
        }));
        assert.equal(await response.text(), 'synthetic-token');
        return 'Bearer synthetic-token';
      },
    },
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push({ url: request.url, body: await request.text(), credentials: request.credentials, redirect: request.redirect });
      return request.url === `${issuer}/token` ? new Response('synthetic-token') : Response.json({ ok: true });
    },
  });
  await transport.request(`${pool}/resource`);
  assert.deepEqual(requests[0], { url: `${issuer}/token`, body: 'synthetic-form', credentials: 'omit', redirect: 'manual' });
});

test('heavy smoke: custom provider token Request cannot smuggle ambient credential headers', async (t) => {
  for (const header of ['Cookie', 'Proxy-Authorization']) {
    await t.test(header, async () => {
      let wireRequests = 0;
      const transport = new UcwaTransport({
        trustedOrigins: [pool, issuer],
        auth: {
          async getAuthorization({ fetch }) {
            await fetch(new Request(`${issuer}/token`, { headers: { [header]: 'synthetic-private' } }));
            return 'Bearer synthetic';
          },
        },
        fetch: async () => { wireRequests++; return Response.json({}); },
      });
      await assert.rejects(transport.request(`${pool}/resource`), TypeError);
      assert.equal(wireRequests, 0);
    });
  }
});

test('heavy smoke: cross-origin redirect trust rejection occurs before the next authorization callback', async () => {
  const authorizationUrls: string[] = [];
  let wireRequests = 0;
  const transport = new UcwaTransport({
    trustedOrigins: [pool],
    auth: { async getAuthorization({ url }) { authorizationUrls.push(url); return 'Bearer synthetic-private'; } },
    fetch: async () => { wireRequests++; return new Response(null, { status: 302, headers: { Location: 'https://attacker.smoke.example/steal' } }); },
  });
  await assert.rejects(transport.request(`${pool}/redirect`), UntrustedOriginError);
  assert.equal(wireRequests, 1);
  assert.deepEqual(authorizationUrls, [`${pool}/redirect`]);
});

test('heavy smoke: every redirect code rejects write replay', async (t) => {
  for (const status of [301, 302, 303, 307, 308]) {
    await t.test(String(status), async () => {
      let requests = 0;
      const transport = new UcwaTransport({ trustedOrigins: [pool], fetch: async () => {
        requests++;
        return new Response(null, { status, headers: { Location: `${pool}/duplicate` } });
      } });
      await assert.rejects(transport.request(`${pool}/send`, { method: 'POST', body: 'synthetic' }), ProtocolError);
      assert.equal(requests, 1);
    });
  }
});

test('heavy smoke: redirect loops stop at the configured limit and preserve the opaque query', async () => {
  const visited: string[] = [];
  const transport = new UcwaTransport({ trustedOrigins: [pool], maxRedirects: 2, fetch: async (input) => {
    visited.push(String(input));
    return new Response(null, { status: 302, headers: { Location: '/loop?ack=%2B%2F%3D&repeated=1&repeated=2#hidden' } });
  } });
  await assert.rejects(transport.request(`${pool}/start`), /Too many HTTP redirects/);
  assert.deepEqual(visited, [`${pool}/start`, `${pool}/loop?ack=%2B%2F%3D&repeated=1&repeated=2`, `${pool}/loop?ack=%2B%2F%3D&repeated=1&repeated=2`]);
});

test('heavy smoke: response body read obeys the transport timeout and a later request still succeeds', async () => {
  const never = new ReadableStream<Uint8Array>({ start() { /* intentionally no chunks or close */ } });
  let requests = 0;
  const transport = new UcwaTransport({ trustedOrigins: [pool], timeoutMs: 15, fetch: async () => {
    requests++;
    return requests === 1 ? new Response(never, { headers: { 'Content-Type': 'application/json' } }) : Response.json({ recovered: true });
  } });
  await assert.rejects(transport.request(`${pool}/stalled-body`), { name: 'TimeoutError' });
  assert.deepEqual((await transport.request(`${pool}/healthy`)).data, { recovered: true });
});

test('heavy smoke regression: request timeout bounds redirect response body cancellation', async () => {
  const cancelStarted = deferred<void>();
  const finishCancel = deferred<void>();
  const transport = new UcwaTransport({ trustedOrigins: [pool], timeoutMs: 15, fetch: async () => new Response(
    new ReadableStream<Uint8Array>({ cancel() { cancelStarted.resolve(); return finishCancel.promise; } }),
    { status: 302, headers: { Location: '/next' } },
  ) });
  const request = transport.request(`${pool}/redirect`).then(() => 'resolved', (error: unknown) => (error as Error).name);
  await cancelStarted.promise;
  const outcome = await Promise.race([request, new Promise<string>((resolve) => setTimeout(() => resolve('still-pending'), 80))]);
  finishCancel.resolve();
  await request;
  assert.equal(outcome, 'TimeoutError');
});

test('heavy smoke regression: cancellation bounds challenged response cleanup', async () => {
  const cancelStarted = deferred<void>();
  const finishCancel = deferred<void>();
  const abort = new AbortController();
  const transport = new UcwaTransport({
    trustedOrigins: [pool], timeoutMs: 1000,
    auth: { async getAuthorization({ challenge }) { return challenge !== undefined ? 'Bearer refreshed' : undefined; } },
    fetch: async () => new Response(new ReadableStream<Uint8Array>({
      cancel() { cancelStarted.resolve(); return finishCancel.promise; },
    }), { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="synthetic"' } }),
  });
  const request = transport.request(`${pool}/challenge`, { signal: abort.signal }).then(() => 'resolved', (error: unknown) => (error as Error).name);
  await cancelStarted.promise;
  abort.abort();
  const outcome = await Promise.race([request, new Promise<string>((resolve) => setTimeout(() => resolve('still-pending'), 80))]);
  finishCancel.resolve();
  await request;
  assert.equal(outcome, 'AbortError');
});

test('heavy smoke: invalid bearer tokens never reach the wire', async (t) => {
  for (const token of ['', '   ', 'token\r\nInjected: synthetic']) {
    await t.test(JSON.stringify(token), async () => {
      let requests = 0;
      const transport = new UcwaTransport({ trustedOrigins: [pool], auth: bearerAuth(token), fetch: async () => { requests++; return Response.json({}); } });
      await assert.rejects(transport.request(`${pool}/resource`), AuthenticationError);
      assert.equal(requests, 0);
    });
  }
});
