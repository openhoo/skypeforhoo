import assert from 'node:assert/strict';
import test from 'node:test';
import { ProtocolError } from '../src/errors.js';
import {
  ScreenSharingController,
  MediaCleanupTimeoutError,
  UnsupportedMediaError,
  type MediaCapability,
  type MediaEngine,
  type MediaEngineCapabilities,
  type MediaEngineContext,
  type MediaEngineScreenSharing,
  type ScreenSharingRequest,
} from '../src/media-engine.js';
import { SkypeForBusinessMedia } from '../src/media.js';
import { ResourceClient, type ResourceReference } from '../src/resources.js';
import type { Transport, UcwaEventBatch } from '../src/types.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const conversation: ResourceReference = { url: 'https://pool.example.com/conversations/one', data: {} };
const anotherConversation: ResourceReference = { url: 'https://pool.example.com/conversations/two', data: {} };
const application: ResourceReference = { url: 'https://pool.example.com/applications/one', data: {} };
const transport: Transport = { request: async () => { throw new Error('No HTTP or native media should be used by lifecycle fixtures.'); } };
class SignalingFixture extends ResourceClient {
  async communication(): Promise<ResourceReference> { return conversation; }
}
const context = {
  application,
  signaling: new SkypeForBusinessMedia(new SignalingFixture(transport)),
  sipAddress: 'alice@example.com',
};

const publishing: MediaCapability = { feature: 'screenSharing', direction: 'send', captureSources: ['desktop', 'window'] };
const viewing: MediaCapability = { feature: 'screenSharing', direction: 'receive' };

function fixture(overrides: Partial<MediaEngine> = {}) {
  const events: string[] = [];
  const requests: ScreenSharingRequest[] = [];
  const contexts: MediaEngineContext[] = [];
  let sequence = 0;
  const engine: MediaEngine = {
    id: 'synthetic-media-fixture',
    capabilities: () => ({ available: true, capabilities: [publishing, viewing] }),
    startScreenSharing: async (request, engineContext) => {
      const id = `fixture-${++sequence}`;
      requests.push(request);
      contexts.push(engineContext);
      events.push(`start:${id}`);
      return { id, stop: () => { events.push(`stop:${id}`); } };
    },
    close: () => { events.push('close'); },
    ...overrides,
  };
  const controller = new ScreenSharingController({ context, engineFactory: () => engine });
  return { controller, engine, events, requests, contexts };
}

test('an absent engine reports unavailable and never treats capture or signaling as screen support', async () => {
  const controller = new ScreenSharingController({ context });
  const capabilities = await controller.capabilities();
  assert.equal(capabilities.available, false);
  assert.deepEqual(capabilities.capabilities, []);
  assert.equal(await controller.supports({ feature: 'screenSharing', direction: 'send', captureSource: 'desktop' }), false);
  assert.equal(await controller.supports({ feature: 'audio', direction: 'receive' }), false);
  await assert.rejects(controller.startScreenSharing(conversation, { source: { kind: 'desktop' } }), UnsupportedMediaError);
  await assert.rejects(controller.receiveScreenSharing(conversation), UnsupportedMediaError);
  await controller.close();
});

test('factory initialization is shared and one cancelled capability waiter does not cancel the account engine', async () => {
  const { engine } = fixture();
  const initialized = deferred<MediaEngine>();
  const entered = deferred<void>();
  let calls = 0;
  let factoryContext: MediaEngineContext | undefined;
  const controller = new ScreenSharingController({
    context,
    engineFactory: (value) => { calls += 1; factoryContext = value; entered.resolve(); return initialized.promise; },
  });
  const cancelled = new AbortController();
  const first = controller.capabilities(undefined, cancelled.signal);
  const second = controller.capabilities(conversation);
  await entered.promise;
  cancelled.abort();
  await assert.rejects(first, { name: 'AbortError' });
  assert.equal(factoryContext?.signal.aborted, false);
  initialized.resolve(engine);
  assert.equal((await second).available, true);
  assert.equal(calls, 1);
  assert.equal(factoryContext?.sipAddress, 'alice@example.com');
  await controller.close();
});

test('capability queries distinguish direction, capture kind, account policy and remote control', async () => {
  const supported: MediaCapability[] = [{ feature: 'screenSharing', direction: 'send', captureSources: ['desktop'] }];
  let available = true;
  const { controller, requests } = fixture({ capabilities: (value) => {
    assert.equal(value.conversation, conversation);
    return { available, capabilities: supported, reason: 'Synthetic policy' };
  } });
  const snapshot = await controller.capabilities(conversation);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.capabilities), true);
  assert.equal(Object.isFrozen(snapshot.capabilities[0]?.captureSources), true);
  supported.push(viewing);
  assert.equal(snapshot.capabilities.length, 1);
  assert.equal(await controller.supports({ feature: 'screenSharing', direction: 'send', captureSource: 'desktop' }, conversation), true);
  assert.equal(await controller.supports({ feature: 'screenSharing', direction: 'send', captureSource: 'window' }, conversation), false);
  assert.equal(await controller.supports({ feature: 'remoteControl', direction: 'send' }, conversation), false);
  await assert.rejects(controller.startScreenSharing(conversation, { source: { kind: 'window' } }), UnsupportedMediaError);
  available = false;
  await assert.rejects(controller.startScreenSharing(conversation, { source: { kind: 'desktop' } }), /Synthetic policy/);
  assert.equal(requests.length, 0);
  await controller.close();
});

test('publishing passes the actual conversation, source and signaling context; stop is idempotent', async () => {
  const { controller, events, requests, contexts } = fixture();
  const share = await controller.startScreenSharing(conversation, { source: { kind: 'window', id: 'opaque-window-4' } });
  assert.equal(share.state, 'active');
  assert.equal(share.direction, 'send');
  assert.deepEqual(requests[0], { conversation, direction: 'send', source: { kind: 'window', id: 'opaque-window-4' } });
  assert.equal(contexts[0]?.application, application);
  assert.equal(contexts[0]?.signaling, context.signaling);
  assert.equal(contexts[0]?.signal.aborted, false);
  assert.equal(controller.sessions[0], share);
  const first = share.stop();
  assert.equal(first, share.stop());
  await first;
  await share.stop();
  assert.deepEqual(await share.finished, { reason: 'stopped' });
  assert.equal(share.state, 'stopped');
  assert.equal(contexts[0]?.signal.aborted, true);
  assert.deepEqual(controller.sessions, []);
  assert.deepEqual(events, ['start:fixture-1', 'stop:fixture-1']);
  await controller.close();
});

test('viewing has its own capability and duplicates cannot start another capture for the same direction', async () => {
  const { controller, requests } = fixture();
  const first = await controller.startScreenSharing(conversation, { source: { kind: 'desktop' } });
  await assert.rejects(controller.startScreenSharing(conversation, { source: { kind: 'window' } }), ProtocolError);
  const viewer = await controller.receiveScreenSharing(conversation);
  assert.equal(viewer.direction, 'receive');
  assert.equal('source' in requests[1]!, false);
  await assert.rejects(controller.receiveScreenSharing(conversation), ProtocolError);
  await first.stop();
  const replacement = await controller.startScreenSharing(conversation, { source: { kind: 'window' } });
  assert.equal(replacement.state, 'active');
  await controller.close();
  assert.equal(viewer.state, 'stopped');
  assert.equal(replacement.state, 'stopped');
});

test('an already cancelled start never initializes a backend', async () => {
  let factories = 0;
  const { engine } = fixture();
  const controller = new ScreenSharingController({ context, engineFactory: () => { factories += 1; return engine; } });
  const cancellation = new AbortController();
  cancellation.abort();
  await assert.rejects(controller.startScreenSharing(conversation, { source: { kind: 'desktop' }, signal: cancellation.signal }), { name: 'AbortError' });
  assert.equal(factories, 0);
  await controller.close();
});

test('cancelling a running share releases resources and records the cancellation trigger', async () => {
  const { controller, events } = fixture();
  const cancellation = new AbortController();
  const share = await controller.startScreenSharing(conversation, { source: { kind: 'desktop' }, signal: cancellation.signal });
  const reason = new Error('Synthetic caller cancellation');
  cancellation.abort(reason);
  assert.deepEqual(await share.finished, { reason: 'cancelled', error: reason });
  assert.equal(share.state, 'stopped');
  assert.deepEqual(events, ['start:fixture-1', 'stop:fixture-1']);
  await controller.close();
});

test('cancelled startup rejects promptly, and a late media handle is stopped before account cleanup finishes', async () => {
  const entered = deferred<void>();
  const backendStarted = deferred<MediaEngineScreenSharing>();
  const events: string[] = [];
  const { controller } = fixture({
    startScreenSharing: async (_request, value) => {
      entered.resolve();
      const handle = await backendStarted.promise;
      assert.equal(value.signal.aborted, true);
      return handle;
    },
    close: () => { events.push('close'); },
  });
  const cancellation = new AbortController();
  const start = controller.startScreenSharing(conversation, { source: { kind: 'desktop' }, signal: cancellation.signal });
  await entered.promise;
  cancellation.abort();
  await assert.rejects(start, { name: 'AbortError' });
  const closing = controller.close();
  assert.equal(closing, controller.close());
  assert.equal(events.length, 0);
  backendStarted.resolve({ id: 'late-handle', stop: () => { events.push('stop:late'); } });
  await closing;
  assert.equal(events.filter((event) => event === 'stop:late').length, 1);
  assert.equal(events.includes('close'), true);
  assert.deepEqual(controller.sessions, []);
});

test('stop all cancels pending starts and waits for late capture cleanup before permitting another start', async () => {
  const entered = deferred<void>();
  const backendStarted = deferred<MediaEngineScreenSharing>();
  const events: string[] = [];
  const { controller, engine } = fixture({ startScreenSharing: async () => { entered.resolve(); return backendStarted.promise; } });
  const start = controller.startScreenSharing(conversation, { source: { kind: 'desktop' } });
  await entered.promise;
  const stopped = controller.stopScreenSharing();
  assert.equal(stopped, controller.stopScreenSharing());
  await assert.rejects(start, { name: 'AbortError' });
  await assert.rejects(controller.receiveScreenSharing(anotherConversation), /cleanup is in progress/);
  backendStarted.resolve({ id: 'late', stop: () => { events.push('released'); } });
  await stopped;
  assert.deepEqual(events, ['released']);
  engine.startScreenSharing = async () => ({ id: 'new-share', stop: () => {} });
  const replacement = await controller.startScreenSharing(conversation, { source: { kind: 'desktop' } });
  assert.equal(replacement.state, 'active');
  await controller.close();
});

test('the backend end signal releases capture and reports remote termination or failure', async (t) => {
  for (const failed of [false, true]) await t.test(failed ? 'media failure' : 'remote end', async () => {
    const ended = deferred<void>();
    let stops = 0;
    const { controller } = fixture({ startScreenSharing: async () => ({ id: 'natural-end', ended: ended.promise, stop: () => { stops += 1; } }) });
    const share = await controller.startScreenSharing(conversation, { source: { kind: 'desktop' } });
    const error = new Error('Synthetic media failure');
    if (failed) ended.reject(error);
    else ended.resolve();
    assert.deepEqual(await share.finished, failed ? { reason: 'error', error } : { reason: 'ended' });
    assert.equal(stops, 1);
    assert.equal(share.state, 'stopped');
    await controller.close();
  });
});

test('a failed stop retains ownership and can be retried without losing the capture handle', async () => {
  let stops = 0;
  const failure = new Error('Synthetic stop failure');
  const { controller } = fixture({ startScreenSharing: async () => ({ id: 'retry', stop: () => {
    stops += 1;
    if (stops === 1) throw failure;
  } }) });
  const share = await controller.startScreenSharing(conversation, { source: { kind: 'desktop' } });
  await assert.rejects(share.stop(), failure);
  assert.equal(share.state, 'failed');
  assert.equal(share.error, failure);
  assert.equal(controller.sessions[0], share);
  await controller.stopScreenSharing(share);
  assert.equal(stops, 2);
  assert.equal(share.state, 'stopped');
  assert.deepEqual(controller.sessions, []);
  await controller.close();
});

test('close reports backend disposal errors and permits retry after backend failure', async () => {
  let closes = 0;
  const failure = new Error('Synthetic engine close failure');
  const { controller, events } = fixture({ close: () => {
    closes += 1;
    events.push('close');
    if (closes === 1) throw failure;
  } });
  const share = await controller.startScreenSharing(conversation, { source: { kind: 'desktop' } });
  await assert.rejects(controller.close(), (error: unknown) => error instanceof AggregateError && error.errors.includes(failure));
  assert.equal(share.state, 'stopped');
  await controller.close();
  await controller.close();
  assert.equal(closes, 2);
  await assert.rejects(controller.receiveScreenSharing(conversation), /controller is closed/);
  assert.deepEqual(events, ['start:fixture-1', 'stop:fixture-1', 'close', 'close']);
});

test('successful account disposal releases handles even if their individual stop repeatedly fails', async () => {
  const failure = new Error('Synthetic native stream stop failure');
  let disposed = false;
  const { controller } = fixture({
    startScreenSharing: async () => ({ id: 'broken-stop', stop: () => { throw failure; } }),
    close: () => { disposed = true; },
  });
  const share = await controller.startScreenSharing(conversation, { source: { kind: 'desktop' } });
  await assert.rejects(controller.close(), (error: unknown) => error instanceof AggregateError && error.errors.includes(failure));
  assert.equal(disposed, true);
  assert.equal(share.state, 'stopped');
  assert.equal((await share.finished).error, failure);
  assert.deepEqual(controller.sessions, []);
  await controller.close();
});

test('account cancellation propagates to initialization and close releases a late engine', async () => {
  const { engine, events } = fixture();
  const account = new AbortController();
  const initialized = deferred<MediaEngine>();
  const entered = deferred<void>();
  let engineSignal: AbortSignal | undefined;
  const controller = new ScreenSharingController({
    context, signal: account.signal,
    engineFactory: (value) => { engineSignal = value.signal; entered.resolve(); return initialized.promise; },
  });
  const starting = controller.receiveScreenSharing(conversation);
  await entered.promise;
  account.abort();
  await assert.rejects(starting, { name: 'AbortError' });
  assert.equal(engineSignal?.aborted, true);
  const closing = controller.close();
  initialized.resolve(engine);
  await closing;
  assert.deepEqual(events, ['close']);
});

test('capability validation refuses an implicit capture source, and controllers reject foreign handles', async () => {
  const invalid: MediaEngineCapabilities = { available: true, capabilities: [{ feature: 'screenSharing', direction: 'send' }] };
  const malformed = fixture({ capabilities: () => invalid });
  await assert.rejects(malformed.controller.startScreenSharing(conversation, { source: { kind: 'desktop' } }), ProtocolError);
  assert.equal(malformed.requests.length, 0);
  await malformed.controller.close();
  const first = fixture();
  const second = fixture();
  const share = await first.controller.receiveScreenSharing(conversation);
  await assert.rejects(second.controller.stopScreenSharing(share), /another controller/);
  assert.equal(share.state, 'active');
  await first.controller.close();
  await second.controller.close();
});

test('event forwarding does not initialize an unused backend, preserves batches and surfaces failures for replay', async () => {
  const batch: UcwaEventBatch = { sender: [{ rel: 'communication', events: [{ type: 'updated' }] }] };
  const observed: UcwaEventBatch[] = [];
  let factories = 0;
  let fail = true;
  const failure = new Error('Synthetic negotiation event failure');
  const { engine } = fixture({ handleEvents: (value, valueContext) => {
    observed.push(value);
    assert.equal(valueContext.application, application);
    assert.equal(valueContext.signaling, context.signaling);
    if (fail) throw failure;
  } });
  const controller = new ScreenSharingController({ context, engineFactory: () => { factories += 1; return engine; } });
  await controller.handleEvents(batch);
  assert.equal(factories, 0);
  await controller.capabilities();
  await assert.rejects(controller.handleEvents(batch), failure);
  fail = false;
  await controller.handleEvents(batch);
  assert.equal(factories, 1);
  assert.equal(observed.length, 2);
  assert.equal(observed[0], batch);
  assert.equal(observed[1], batch);
  await controller.close();
});

test('an event handler waiting for an already-used engine receives caller cancellation', async () => {
  const batch: UcwaEventBatch = { sender: [] };
  const initialized = deferred<MediaEngine>();
  const initializationEntered = deferred<void>();
  const handlerEntered = deferred<void>();
  const processed = deferred<void>();
  let handlerSignal: AbortSignal | undefined;
  const { engine } = fixture({ handleEvents: async (_value, valueContext) => {
    handlerSignal = valueContext.signal;
    handlerEntered.resolve();
    await processed.promise;
  } });
  const controller = new ScreenSharingController({
    context, engineFactory: () => { initializationEntered.resolve(); return initialized.promise; },
  });
  const capabilities = controller.capabilities();
  await initializationEntered.promise;
  const cancellation = new AbortController();
  const forwarded = controller.handleEvents(batch, cancellation.signal);
  initialized.resolve(engine);
  await capabilities;
  await handlerEntered.promise;
  cancellation.abort();
  await assert.rejects(forwarded, { name: 'AbortError' });
  assert.equal(handlerSignal?.aborted, true);
  processed.resolve();
  await controller.close();
});

test('cleanup has an explicit deadline and a late factory still receives actual disposal', async () => {
  const initialized = deferred<MediaEngine>();
  const entered = deferred<void>();
  const { engine, events } = fixture();
  const controller = new ScreenSharingController({
    context, cleanupTimeoutMs: 10,
    engineFactory: () => { entered.resolve(); return initialized.promise; },
  });
  const starting = controller.receiveScreenSharing(conversation);
  await entered.promise;
  const startingCancelled = assert.rejects(starting, { name: 'AbortError' });
  await assert.rejects(controller.close(), (error: unknown) =>
    error instanceof MediaCleanupTimeoutError && error.operation === 'close' && error.timeoutMs === 10,
  );
  await startingCancelled;
  assert.equal(events.length, 0);
  initialized.resolve(engine);
  await controller.close();
  assert.deepEqual(events, ['close']);
});

test('cleanup attempts backend disposal while an uncooperative capability query remains pending', async () => {
  const queried = deferred<MediaEngineCapabilities>();
  const entered = deferred<void>();
  let closes = 0;
  const { engine } = fixture({
    capabilities: async () => { entered.resolve(); return queried.promise; },
    close: () => { closes += 1; },
  });
  const controller = new ScreenSharingController({ context, engineFactory: () => engine, cleanupTimeoutMs: 10 });
  const capabilities = controller.capabilities();
  await entered.promise;
  const cancelled = assert.rejects(capabilities, { name: 'AbortError' });
  await assert.rejects(controller.close(), MediaCleanupTimeoutError);
  await cancelled;
  assert.equal(closes, 1);
  queried.resolve({ available: true, capabilities: [viewing] });
  await controller.close();
  assert.equal(closes, 1);
});

test('a timed-out native start retains late-result cleanup after the close caller has returned', async () => {
  const started = deferred<MediaEngineScreenSharing>();
  const entered = deferred<void>();
  let stops = 0;
  let closes = 0;
  const { engine } = fixture({
    startScreenSharing: async () => { entered.resolve(); return started.promise; },
    close: () => { closes += 1; },
  });
  const controller = new ScreenSharingController({ context, engineFactory: () => engine, cleanupTimeoutMs: 10 });
  const starting = controller.receiveScreenSharing(conversation);
  await entered.promise;
  const cancelled = assert.rejects(starting, { name: 'AbortError' });
  await assert.rejects(controller.close(), MediaCleanupTimeoutError);
  await cancelled;
  assert.equal(closes, 1);
  started.resolve({ id: 'after-deadline', stop: () => { stops += 1; } });
  await controller.close();
  assert.equal(stops, 1);
  assert.equal(closes, 2);
  assert.deepEqual(controller.sessions, []);
});

test('stuck stop/dispose calls time out without declaring native resources released', async () => {
  const stopped = deferred<void>();
  const disposed = deferred<void>();
  let stops = 0;
  let closes = 0;
  const { engine } = fixture({
    startScreenSharing: async () => ({ id: 'stuck-stop', stop: () => { stops += 1; return stopped.promise; } }),
    close: () => { closes += 1; return disposed.promise; },
  });
  const controller = new ScreenSharingController({ context, engineFactory: () => engine, cleanupTimeoutMs: 10 });
  const share = await controller.receiveScreenSharing(conversation);
  await assert.rejects(controller.close(), MediaCleanupTimeoutError);
  assert.equal(share.state, 'stopping');
  assert.equal(controller.sessions[0], share);
  assert.equal(stops, 1);
  assert.equal(closes, 1);
  stopped.resolve();
  disposed.resolve();
  await controller.close();
  assert.equal(share.state, 'stopped');
  assert.deepEqual(controller.sessions, []);
  assert.equal(closes, 1);
});

test('stop all also has a deadline and can resume waiting for late startup cleanup', async () => {
  const started = deferred<MediaEngineScreenSharing>();
  const entered = deferred<void>();
  let stops = 0;
  const { engine } = fixture({ startScreenSharing: async () => { entered.resolve(); return started.promise; } });
  const controller = new ScreenSharingController({ context, engineFactory: () => engine, cleanupTimeoutMs: 10 });
  const starting = controller.receiveScreenSharing(conversation);
  await entered.promise;
  const cancelled = assert.rejects(starting, { name: 'AbortError' });
  await assert.rejects(controller.stopScreenSharing(), (error: unknown) =>
    error instanceof MediaCleanupTimeoutError && error.operation === 'stopScreenSharing',
  );
  await cancelled;
  await assert.rejects(controller.receiveScreenSharing(anotherConversation), /cleanup is in progress/);
  started.resolve({ id: 'late-stop-all', stop: () => { stops += 1; } });
  await controller.stopScreenSharing();
  assert.equal(stops, 1);
  await controller.close();
});

test('cleanup timeout validation rejects values that JavaScript timers cannot represent safely', () => {
  for (const cleanupTimeoutMs of [0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN, 2_147_483_648]) {
    assert.throws(() => new ScreenSharingController({ context, cleanupTimeoutMs }), TypeError);
  }
});
