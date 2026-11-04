import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthenticationError } from '../src/errors.js';
import { UcwaTransport } from '../src/transport.js';
import type { AuthProvider } from '../src/types.js';

const origin = 'https://cleanup.regression.example.test';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function observeWithin<T>(promise: Promise<T>, milliseconds = 150): Promise<T | 'still-pending'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<'still-pending'>((resolve) => {
      timer = setTimeout(() => resolve('still-pending'), milliseconds);
    })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

test('response cleanup regressions: late redirect and challenge cancellation failures stay handled after timeout', async (t) => {
  for (const status of [302, 401]) await t.test(String(status), async () => {
    const entered = deferred<void>();
    const cleanup = deferred<void>();
    let requests = 0;
    const transport = new UcwaTransport({
      trustedOrigins: [origin], timeoutMs: 20,
      auth: { getAuthorization: async ({ challenge }) => challenge === undefined ? undefined : 'Bearer synthetic-refreshed' },
      fetch: async () => {
        requests += 1;
        return new Response(new ReadableStream<Uint8Array>({ cancel() { entered.resolve(); return cleanup.promise; } }), {
          status, headers: status === 302 ? { Location: '/must-not-be-replayed' } : { 'WWW-Authenticate': 'Bearer' },
        });
      },
    });
    const request = transport.request(`${origin}/resource`).then(() => 'resolved', (error: unknown) => error);
    await entered.promise;
    const outcome = await observeWithin(request);
    cleanup.reject(new Error('Synthetic late body cancellation failure'));
    await request;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(outcome instanceof DOMException && outcome.name === 'TimeoutError');
    assert.equal(requests, 1, 'Timeout must prevent both redirects and authentication replays.');
  });
});

test('response cleanup regressions: a challenge aborted before cleanup still attempts disposal without replaying', async () => {
  const controller = new AbortController();
  const reason = new Error('Synthetic caller cancellation during authorization');
  const cleanup = deferred<void>();
  let cancels = 0;
  let requests = 0;
  const transport = new UcwaTransport({
    trustedOrigins: [origin], timeoutMs: 1000,
    auth: { getAuthorization: async ({ challenge }) => {
      if (challenge === undefined) return undefined;
      controller.abort(reason);
      return 'Bearer must-not-be-replayed';
    } },
    fetch: async () => {
      requests += 1;
      return new Response(new ReadableStream<Uint8Array>({ cancel() {
        assert.equal(controller.signal.aborted, true);
        cancels += 1;
        return cleanup.promise;
      } }), { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } });
    },
  });
  const request = transport.request(`${origin}/resource`, { signal: controller.signal }).then(() => 'resolved', (error: unknown) => error);
  const outcome = await observeWithin(request);
  cleanup.reject(new Error('Synthetic disposal failure after cancellation'));
  await request;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(outcome, reason);
  assert.equal(cancels, 1);
  assert.equal(requests, 1);
});

test('response cleanup regressions: authentication failures remain primary when disposal also fails', async (t) => {
  for (const stage of ['invalidate', 'authorize', 'missing authorization'] as const) await t.test(stage, async () => {
    const authenticationFailure = new Error(`Synthetic ${stage} failure`);
    const cleanupFailure = new Error('Synthetic secondary cleanup failure');
    let cancels = 0;
    let requests = 0;
    const auth: AuthProvider = {
      invalidate: () => { if (stage === 'invalidate') throw authenticationFailure; },
      getAuthorization: async ({ challenge }) => {
        if (challenge === undefined) return undefined;
        if (stage === 'authorize') throw authenticationFailure;
        return undefined;
      },
    };
    const transport = new UcwaTransport({
      trustedOrigins: [origin], auth,
      fetch: async () => {
        requests += 1;
        return new Response(new ReadableStream<Uint8Array>({ cancel() { cancels += 1; return Promise.reject(cleanupFailure); } }), { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } });
      },
    });
    await assert.rejects(transport.request(`${origin}/resource`), (error: unknown) => stage === 'missing authorization'
      ? error instanceof AuthenticationError
      : error === authenticationFailure);
    assert.equal(cancels, 1, 'The challenged response is disposed even when invalidation throws.');
    assert.equal(requests, 1);
  });
});

test('response cleanup regressions: disposal failure after successful authorization stops replay', async () => {
  const cleanupFailure = new Error('Synthetic body cancellation failure');
  let requests = 0;
  const transport = new UcwaTransport({
    trustedOrigins: [origin],
    auth: { getAuthorization: async ({ challenge }) => challenge === undefined ? undefined : 'Bearer synthetic-refreshed' },
    fetch: async () => {
      requests += 1;
      return new Response(new ReadableStream<Uint8Array>({ cancel() { return Promise.reject(cleanupFailure); } }), { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } });
    },
  });
  await assert.rejects(transport.request(`${origin}/resource`), (error: unknown) => error === cleanupFailure);
  assert.equal(requests, 1);
});
