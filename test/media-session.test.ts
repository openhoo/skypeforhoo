import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpError, ProtocolError } from '../src/errors.js';
import { MediaCleanupTimeoutError, type MediaEngine, type MediaEngineContext } from '../src/media-engine.js';
import type { ResourceReference } from '../src/resources.js';
import { UcwaSession, type UcwaSessionOptions } from '../src/session.js';
import type { HttpResult, RequestOptions, Transport, UcwaEventBatch } from '../src/types.js';

const origin = 'https://pool.example.test';
const applicationUrl = `${origin}/registered/application`;
const firstCursor = `${origin}/opaque-events?ack=first`;
const conversation: ResourceReference = { url: `${origin}/conversation/opaque`, data: {} };
interface Call { url: string; options: RequestOptions }

function fixture(options: UcwaSessionOptions = {}, handler?: (call: Call) => unknown | Promise<unknown>) {
  const calls: Call[] = [];
  const transport: Transport = {
    async request<T>(url: string, requestOptions: RequestOptions = {}): Promise<HttpResult<T>> {
      const call = { url, options: requestOptions };
      calls.push(call);
      const data: unknown = requestOptions.method === 'POST' && url === `${origin}/applications`
        ? {
          _links: { self: { href: applicationUrl }, events: { href: firstCursor } },
          _embedded: { me: { _links: { self: { href: '/me' }, reportMyActivity: { href: '/advertised/report-activity' } } } },
        }
        : await handler?.(call);
      return { url, data: data as T | undefined, response: new Response(null, { status: data === undefined ? 204 : 200 }) };
    },
  };
  return {
    calls,
    transport,
    create: () => UcwaSession.create(transport, `${origin}/applications`, { userAgent: 'media-integration-test' }, undefined, options),
  };
}

function engine(overrides: Partial<MediaEngine> = {}): MediaEngine {
  return {
    id: 'synthetic-engine',
    capabilities: () => ({
      available: true,
      capabilities: [{ feature: 'screenSharing', direction: 'send', captureSources: ['desktop', 'window'] }],
    }),
    startScreenSharing: async () => ({ id: 'synthetic-share', stop() {} }),
    close() {},
    ...overrides,
  };
}

test('media backend receives account-scoped context lazily and closes with its UCWA registration', async () => {
  const contexts: MediaEngineContext[] = [];
  let stops = 0;
  let closes = 0;
  const setup = fixture({
    sipAddress: 'user@example.test',
    mediaEngine: (value) => {
      contexts.push(value);
      return engine({
        startScreenSharing: async () => ({ id: 'native-handle', stop() { stops++; } }),
        close() { closes++; },
      });
    },
  });
  const session = await setup.create();
  assert.equal(contexts.length, 0);
  const share = await session.screenSharing.startScreenSharing(conversation, { source: { kind: 'window', id: 'opaque-window-id' } });
  const context = contexts[0]!;
  assert.equal(context.sipAddress, 'user@example.test');
  assert.equal(context.application, session.application);
  assert.equal(context.signaling, session.media);
  assert.equal(context.signal.aborted, false);
  assert.equal(share.state, 'active');
  const closing = session.close();
  assert.equal(session.close(), closing);
  await closing;
  assert.equal(stops, 1);
  assert.equal(closes, 1);
  assert.equal(share.state, 'stopped');
  assert.equal(context.signal.aborted, true);
  assert.equal(setup.calls.filter(({ options }) => options.method === 'DELETE').length, 1);
  assert.deepEqual(Object.keys(setup.calls[0]!.options.json as object).sort(), ['culture', 'endpointId', 'userAgent']);
  await assert.rejects(session.media.communicationCapabilities(), ProtocolError);
});

test('invalid native cleanup options fail before creating a server registration', async () => {
  for (const mediaCleanupTimeoutMs of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
    const setup = fixture({ mediaCleanupTimeoutMs });
    await assert.rejects(setup.create(), TypeError);
    assert.equal(setup.calls.length, 0);
  }
});

test('ordinary event polling does not initialize a media backend', async () => {
  let factories = 0;
  const setup = fixture({ mediaEngine: () => { factories++; return engine(); } }, () => ({ sender: [] }));
  const session = await setup.create();
  const batches = [];
  for await (const batch of session.events()) batches.push(batch);
  assert.equal(batches.length, 1);
  assert.equal(factories, 0);
  await session.close();
  assert.equal(factories, 0);
});

test('native event failure keeps the cursor replayable and successful handling precedes yielding', async () => {
  const failure = new Error('synthetic negotiation failure');
  let attempts = 0;
  let handled: UcwaEventBatch | undefined;
  const setup = fixture({ mediaEngine: () => engine({
    async handleEvents(batch) {
      attempts++;
      if (attempts === 1) throw failure;
      handled = batch;
    },
  }) }, ({ url }) => url === firstCursor ? { sender: [] } : undefined);
  const session = await setup.create();
  await session.screenSharing.capabilities();
  await assert.rejects(session.events().next(), (error) => error === failure);
  assert.equal(session.eventCursor, firstCursor);
  const events = session.events();
  const result = await events.next();
  assert.equal(result.done, false);
  assert.equal(handled, result.value);
  assert.equal(attempts, 2);
  assert.equal(session.eventCursor, firstCursor);
  assert.equal((await events.next()).done, true);
  assert.equal(session.eventCursor, undefined);
  assert.equal(setup.calls.filter(({ url }) => url === firstCursor).length, 2);
  await session.close();
});

test('session close cancels a native event handler and still deletes the registration', async () => {
  let started!: () => void;
  const handling = new Promise<void>((resolve) => { started = resolve; });
  const setup = fixture({ mediaEngine: () => engine({
    handleEvents(_batch, context) {
      started();
      return new Promise<void>((_resolve, reject) => {
        context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
      });
    },
  }) }, ({ url }) => url === firstCursor ? { sender: [] } : undefined);
  const session = await setup.create();
  await session.screenSharing.capabilities();
  const next = session.events().next();
  await handling;
  await session.close();
  assert.deepEqual(await next, { value: undefined, done: true });
  assert.equal(setup.calls.filter(({ options }) => options.method === 'DELETE').length, 1);
});

test('native cleanup failures surface independently of registration deletion and can be retried', async () => {
  const failure = new Error('synthetic native close failure');
  let closes = 0;
  const setup = fixture({ mediaEngine: () => engine({ close() { if (++closes === 1) throw failure; } }) }, ({ options, url }) => {
    if (options.method === 'DELETE') throw new HttpError(404, url, new Response(null, { status: 404 }));
    return undefined;
  });
  const session = await setup.create();
  await session.screenSharing.capabilities();
  await assert.rejects(session.close(), (error) => error instanceof AggregateError && error.errors.includes(failure));
  assert.equal(setup.calls.filter(({ options }) => options.method === 'DELETE').length, 1);
  await session.close();
  assert.equal(closes, 2);
  assert.equal(setup.calls.filter(({ options }) => options.method === 'DELETE').length, 2);
});

test('a stalled native close has a deadline while UCWA deletion completes', async () => {
  let finish!: () => void;
  const cleanup = new Promise<void>((resolve) => { finish = resolve; });
  const setup = fixture({ mediaCleanupTimeoutMs: 20, mediaEngine: () => engine({ close: () => cleanup }) });
  const session = await setup.create();
  await session.screenSharing.capabilities();
  try {
    await assert.rejects(session.close(), MediaCleanupTimeoutError);
    assert.equal(setup.calls.filter(({ options }) => options.method === 'DELETE').length, 1);
  } finally {
    finish();
  }
  await session.close();
});

test('a synchronous custom transport failure remains retryable during shutdown', async () => {
  const setup = fixture();
  let deletes = 0;
  const transport: Transport = {
    request<T>(url: string, options: RequestOptions = {}): Promise<HttpResult<T>> {
      if (options.method === 'DELETE' && ++deletes === 1) throw new Error('synthetic transport validation failure');
      return setup.transport.request<T>(url, options);
    },
  };
  const session = await UcwaSession.create(transport, `${origin}/applications`, { userAgent: 'media-integration-test' });
  const first = session.close();
  await assert.rejects(first, /synthetic transport validation failure/);
  const second = session.close();
  assert.notEqual(second, first);
  await second;
  assert.equal(deletes, 2);
});

test('reportActivity follows the advertised action and posts an empty body', async () => {
  const setup = fixture();
  const session = await setup.create();
  await session.reportActivity();
  assert.deepEqual(setup.calls[1], { url: `${origin}/advertised/report-activity`, options: { method: 'POST' } });
  await session.close();
});
