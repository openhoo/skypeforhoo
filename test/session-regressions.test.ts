import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpError, ProtocolError } from '../src/errors.js';
import type { ResourceReference } from '../src/resources.js';
import { UcwaSession } from '../src/session.js';
import type { HttpResult, RequestOptions, Transport } from '../src/types.js';

const origin = 'https://session-regressions.example.test';
const applicationUrl = `${origin}/applications/synthetic`;
const communicationUrl = `${origin}/communication`;
const availableUrl = `${origin}/make-available`;
const me = { _links: { self: { href: '/me' }, makeMeAvailable: { href: availableUrl } } };

interface Call { url: string; options: RequestOptions }

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

function communication(version: string) {
  return { _links: { self: { href: communicationUrl }, startMessaging: { href: `/start/${version}` } } };
}

function fixture(handler: (call: Call) => unknown | Promise<unknown>) {
  const calls: Call[] = [];
  const transport: Transport = {
    async request<T>(url: string, options: RequestOptions = {}): Promise<HttpResult<T>> {
      calls.push({ url, options });
      const data = url === `${origin}/applications` && options.method === 'POST'
        ? {
          _links: { self: { href: applicationUrl }, communication: { href: communicationUrl } },
          _embedded: { me },
        }
        : url === `${origin}/me` ? me : await handler({ url, options });
      return { data: data as T | undefined, url, response: new Response(null, { status: data === undefined ? 204 : 200 }) };
    },
  };
  return { calls, create: () => UcwaSession.create(transport, `${origin}/applications`, { userAgent: 'session-regression-tests' }) };
}

test('availability refresh gives an already waiting messaging operation the new capability', { timeout: 5_000 }, async () => {
  const stale = deferred<unknown>();
  const reading = deferred<void>();
  let reads = 0;
  const setup = fixture(({ url }) => {
    if (url !== communicationUrl) return undefined;
    if (++reads === 1) { reading.resolve(); return stale.promise; }
    return communication('current');
  });
  const session = await setup.create();
  try {
    const sending = session.startMessaging({ to: 'sip:synthetic@example.test', operationId: 'waiting-invitation' });
    await reading.promise;
    await session.makeAvailable();
    stale.resolve(communication('stale'));
    await sending;
    assert.equal(reads, 2);
    assert.deepEqual(setup.calls.filter(({ url }) => url.includes('/start/')).map(({ url }) => url), [`${origin}/start/current`]);
  } finally { await session.close(); }
});

test('an older lookup finishing after a fresh lookup reuses the fresh cached resource', { timeout: 5_000 }, async () => {
  const stale = deferred<unknown>();
  const reading = deferred<void>();
  let reads = 0;
  const setup = fixture(({ url }) => {
    if (url !== communicationUrl) return undefined;
    if (++reads === 1) { reading.resolve(); return stale.promise; }
    return communication('current');
  });
  const session = await setup.create();
  try {
    const older = session.communication();
    await reading.promise;
    await session.makeAvailable();
    const fresh = await session.communication();
    stale.resolve(communication('stale'));
    assert.equal(await older, fresh);
    assert.equal(await session.communication(), fresh);
    assert.equal(reads, 2);
  } finally { await session.close(); }
});

test('repeated availability changes also invalidate a replacement lookup already in flight', { timeout: 5_000 }, async () => {
  const first = deferred<unknown>();
  const second = deferred<unknown>();
  const firstStarted = deferred<void>();
  const secondStarted = deferred<void>();
  let reads = 0;
  const setup = fixture(({ url }) => {
    if (url !== communicationUrl) return undefined;
    if (++reads === 1) { firstStarted.resolve(); return first.promise; }
    if (reads === 2) { secondStarted.resolve(); return second.promise; }
    return communication('latest');
  });
  const session = await setup.create();
  try {
    const sending = session.startMessaging({ to: 'sip:synthetic@example.test', operationId: 'repeated-refresh' });
    await firstStarted.promise;
    await session.makeAvailable();
    first.resolve(communication('before-first-refresh'));
    await secondStarted.promise;
    await session.makeAvailable();
    second.resolve(communication('before-second-refresh'));
    await sending;
    assert.equal(reads, 3);
    assert.deepEqual(setup.calls.filter(({ url }) => url.includes('/start/')).map(({ url }) => url), [`${origin}/start/latest`]);
  } finally { await session.close(); }
});

test('close during a pending hub read rejects its original caller and emits no follow-up operation', { timeout: 5_000 }, async () => {
  const pending = deferred<unknown>();
  const started = deferred<void>();
  const setup = fixture(({ url }) => {
    if (url !== communicationUrl) return undefined;
    started.resolve();
    return pending.promise;
  });
  const session = await setup.create();
  const reading = session.communication();
  await started.promise;
  await session.close();
  pending.resolve(communication('late'));
  await assert.rejects(reading, ProtocolError);
  assert.equal(setup.calls.filter(({ url }) => url === communicationUrl).length, 1);
  assert.equal(setup.calls.filter(({ options }) => options.method === 'DELETE').length, 1);
});

test('caller cancellation prevents retrying an invalidated hub lookup', { timeout: 5_000 }, async () => {
  const pending = deferred<unknown>();
  const started = deferred<void>();
  const cancel = new AbortController();
  const reason = new Error('synthetic caller cancelled');
  let reads = 0;
  const setup = fixture(({ url }) => {
    if (url !== communicationUrl) return undefined;
    reads++;
    started.resolve();
    return pending.promise;
  });
  const session = await setup.create();
  try {
    const reading = session.communication(cancel.signal);
    await started.promise;
    await session.makeAvailable();
    cancel.abort(reason);
    pending.resolve(communication('stale'));
    await assert.rejects(reading, (error) => error === reason);
    assert.equal(reads, 1);
  } finally { await session.close(); }
});

test('a failed availability operation does not invalidate an otherwise current pending hub read', { timeout: 5_000 }, async () => {
  const pending = deferred<unknown>();
  const started = deferred<void>();
  let reads = 0;
  const setup = fixture(({ url }) => {
    if (url === availableUrl) throw new HttpError(503, url, new Response(null, { status: 503 }));
    if (url !== communicationUrl) return undefined;
    reads++;
    started.resolve();
    return pending.promise;
  });
  const session = await setup.create();
  try {
    const reading = session.communication();
    await started.promise;
    await assert.rejects(session.makeAvailable(), HttpError);
    pending.resolve(communication('unchanged'));
    const current = await reading;
    assert.equal(await session.communication(), current);
    await session.startMessaging({ to: 'sip:synthetic@example.test', operationId: 'availability-failed' });
    assert.equal(reads, 1);
    assert.equal(setup.calls.find(({ url }) => url.includes('/start/'))?.url, `${origin}/start/unchanged`);
  } finally { await session.close(); }
});

test('closing before an immediately resolved messaging lookup resumes prevents its POST', async () => {
  const setup = fixture(() => undefined);
  const session = await setup.create();
  const resource: ResourceReference = { url: `${origin}/messaging`, data: { _links: { sendMessage: { href: '/send' } } } };
  const sending = session.sendMessage(resource, 'synthetic', { operationId: 'closed-before-resume' });
  const closing = session.close();
  await assert.rejects(sending, ProtocolError);
  await closing;
  assert.equal(setup.calls.filter(({ url }) => url.startsWith(`${origin}/send`)).length, 0);
});

test('caller cancellation after messaging lookup starts prevents a later message POST', { timeout: 5_000 }, async () => {
  const pending = deferred<unknown>();
  const started = deferred<void>();
  const cancel = new AbortController();
  const reason = new Error('synthetic message cancelled');
  const setup = fixture(({ url }) => {
    if (url !== `${origin}/messaging`) return undefined;
    started.resolve();
    return pending.promise;
  });
  const session = await setup.create();
  try {
    const resource: ResourceReference = { url: `${origin}/conversation`, data: { _links: { messaging: { href: '/messaging' } } } };
    const sending = session.sendMessage(resource, 'synthetic', { operationId: 'cancelled-message', signal: cancel.signal });
    await started.promise;
    cancel.abort(reason);
    pending.resolve({ _links: { sendMessage: { href: '/send' } } });
    await assert.rejects(sending, (error) => error === reason);
    assert.equal(setup.calls.filter(({ url }) => url.startsWith(`${origin}/send`)).length, 0);
  } finally { await session.close(); }
});
