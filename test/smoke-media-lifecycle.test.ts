import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ProtocolError,
  ScreenSharingController,
  SkypeForBusinessMedia,
  UcwaTransport,
  UnsupportedMediaError,
  decodeSdpDataUri,
  encodeSdpDataUri,
  type MediaEngine,
  type MediaEngineCapabilities,
  type MediaEngineContext,
  type MediaEngineScreenSharing,
  type ResourceReference,
  type UcwaEventBatch,
} from '../src/index.js';
import { ResourceClient } from '../src/resources.js';

const origin = 'https://media.smoke.example.test';
const application: ResourceReference = { url: `${origin}/applications/smoke`, data: {} };
const conversation = (id: string): ResourceReference => ({ url: `${origin}/conversations/${id}`, data: {} });
const capabilities: MediaEngineCapabilities = {
  available: true,
  capabilities: [
    { feature: 'screenSharing', direction: 'send', captureSources: ['desktop', 'window'] },
    { feature: 'screenSharing', direction: 'receive' },
  ],
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(overrides: Partial<MediaEngine> = {}) {
  const transport = new UcwaTransport({ trustedOrigins: [origin], fetch: async () => { throw new Error('Lifecycle smoke must not contact a network.'); } });
  class Session extends ResourceClient { async communication() { return application; } }
  const context = { application, signaling: new SkypeForBusinessMedia(new Session(transport)) };
  let starts = 0;
  let closes = 0;
  const stops = new Map<string, number>();
  const engine: MediaEngine = {
    id: 'smoke-engine', capabilities: () => capabilities,
    startScreenSharing: async () => {
      const id = `share-${++starts}`;
      return { id, stop: () => { stops.set(id, (stops.get(id) ?? 0) + 1); } };
    },
    close: () => { closes += 1; },
    ...overrides,
  };
  const controller = new ScreenSharingController({ context, engineFactory: () => engine });
  return { controller, context, engine, stops, get starts() { return starts; }, get closes() { return closes; } };
}

test('smoke media: sixty-four concurrent initialization failures retry as one shared engine acquisition', async () => {
  const { context, engine } = fixture();
  const failed = deferred<MediaEngine>();
  let acquisitions = 0;
  const controller = new ScreenSharingController({ context, engineFactory: () => ++acquisitions === 1 ? failed.promise : engine });
  const first = Array.from({ length: 64 }, () => controller.capabilities());
  const results = Promise.allSettled(first);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const failure = new Error('Synthetic media installation temporarily unavailable');
  failed.reject(failure);
  assert.ok((await results).every((result) => result.status === 'rejected' && result.reason === failure));
  assert.equal(acquisitions, 1);
  const recovered = await Promise.all(Array.from({ length: 64 }, () => controller.capabilities()));
  assert.ok(recovered.every((result) => result.available && result.engineId === engine.id));
  assert.equal(acquisitions, 2);
  await controller.close();
});

test('smoke media: 640 capture/view lifecycles release reservations and reuse one account backend', async () => {
  const state = fixture();
  for (let round = 0; round < 20; round += 1) {
    const handles = await Promise.all(Array.from({ length: 16 }, (_, index) => {
      const target = conversation(`soak-${index}`);
      return Promise.all([
        state.controller.startScreenSharing(target, { source: { kind: index % 2 ? 'window' : 'desktop' } }),
        state.controller.receiveScreenSharing(target),
      ]);
    }));
    assert.equal(state.controller.sessions.length, 32);
    await assert.rejects(state.controller.receiveScreenSharing(conversation('soak-0')), ProtocolError);
    await state.controller.stopScreenSharing();
    assert.equal(state.controller.sessions.length, 0);
    const terminations = await Promise.all(handles.flat().map((handle) => handle.finished));
    assert.ok(terminations.every((termination) => termination.reason === 'stopped'));
  }
  await state.controller.close();
  assert.equal(state.starts, 640);
  assert.equal(state.stops.size, 640);
  assert.ok([...state.stops.values()].every((count) => count === 1));
  assert.equal(state.closes, 1);
});

test('smoke media: stop-all failures retain every failed handle and a second attempt releases them', async () => {
  let sequence = 0;
  const attempts = new Map<string, number>();
  const failures = Array.from({ length: 12 }, (_, index) => new Error(`Synthetic stop failure ${index + 1}`));
  const { controller } = fixture({ startScreenSharing: async () => {
    const index = sequence++;
    const id = String(index);
    return { id, stop: () => {
      const attempt = (attempts.get(id) ?? 0) + 1;
      attempts.set(id, attempt);
      if (attempt === 1) throw failures[index];
    } };
  } });
  const handles = await Promise.all(failures.map((_, index) => controller.receiveScreenSharing(conversation(`retry-${index}`))));
  await assert.rejects(controller.stopScreenSharing(), (error: unknown) => error instanceof AggregateError &&
    error.errors.length === failures.length && failures.every((failure) => error.errors.includes(failure)));
  assert.equal(controller.sessions.length, 12);
  assert.ok(handles.every((handle) => handle.state === 'failed'));
  await controller.stopScreenSharing();
  assert.equal(controller.sessions.length, 0);
  assert.ok([...attempts.values()].every((count) => count === 2));
  await Promise.all(handles.map((handle) => handle.finished));
  await controller.close();
});

test('smoke media: remote end, caller cancellation, explicit stop and account close coalesce cleanup', async () => {
  const end = deferred<void>();
  const release = deferred<void>();
  let stops = 0;
  const { controller } = fixture({ startScreenSharing: async () => ({
    id: 'four-way-race', ended: end.promise,
    stop: async () => { stops += 1; await release.promise; },
  }) });
  const cancellation = new AbortController();
  const share = await controller.startScreenSharing(conversation('race'), { source: { kind: 'window' }, signal: cancellation.signal });
  end.resolve();
  cancellation.abort(new Error('Synthetic account UI cancellation'));
  const stopped = share.stop();
  const closing = controller.close();
  release.resolve();
  await Promise.all([stopped, closing]);
  assert.equal(stops, 1);
  assert.equal(share.state, 'stopped');
  assert.equal(controller.sessions.length, 0);
  assert.ok(['stopped', 'cancelled', 'ended'].includes((await share.finished).reason));
});

test('smoke media: invalid native handles are stopped before retry and do not reserve the conversation forever', async () => {
  let starts = 0;
  let invalidStopped = 0;
  const { controller } = fixture({ startScreenSharing: async () => {
    if (++starts === 1) return { id: '', stop: () => { invalidStopped += 1; } };
    return { id: 'valid-retry', stop: () => {} };
  } });
  const target = conversation('invalid-handle');
  await assert.rejects(controller.receiveScreenSharing(target), ProtocolError);
  assert.equal(invalidStopped, 1);
  assert.equal(controller.sessions.length, 0);
  const recovered = await controller.receiveScreenSharing(target);
  assert.equal(recovered.state, 'active');
  await controller.close();
});

test('smoke media: policy is reevaluated for each new share without changing established handles', async () => {
  let allowed = false;
  let starts = 0;
  const { controller } = fixture({
    capabilities: () => ({ ...capabilities, available: allowed, reason: 'Synthetic account policy' }),
    startScreenSharing: async () => ({ id: `policy-${++starts}`, stop: () => {} }),
  });
  await assert.rejects(controller.receiveScreenSharing(conversation('policy')), UnsupportedMediaError);
  assert.equal(starts, 0);
  allowed = true;
  const existing = await controller.receiveScreenSharing(conversation('policy'));
  allowed = false;
  await assert.rejects(controller.receiveScreenSharing(conversation('policy-other')), UnsupportedMediaError);
  assert.equal(starts, 1);
  assert.equal(existing.state, 'active');
  await controller.close();
});

test('smoke media: operation cancellation during a shared capability query leaves the other waiter usable', async () => {
  const entered = deferred<void>();
  const values = deferred<MediaEngineCapabilities>();
  const { controller } = fixture({ capabilities: async () => { entered.resolve(); return values.promise; } });
  const cancellation = new AbortController();
  const cancelled = controller.capabilities(undefined, cancellation.signal);
  const retained = controller.capabilities();
  await entered.promise;
  cancellation.abort(new DOMException('Synthetic cancelled policy check', 'AbortError'));
  await assert.rejects(cancelled, { name: 'AbortError' });
  values.resolve(capabilities);
  assert.equal((await retained).available, true);
  const share = await controller.receiveScreenSharing(conversation('after-policy-cancel'));
  assert.equal(share.state, 'active');
  await controller.close();
});

test('smoke media: a backend event failure can replay while its established capture stays owned', async () => {
  let events = 0;
  const failed = new Error('Synthetic event negotiation failure');
  const observed: UcwaEventBatch[] = [];
  const { controller } = fixture({ handleEvents: (batch) => {
    observed.push(batch);
    if (++events === 1) throw failed;
  } });
  const share = await controller.receiveScreenSharing(conversation('event-replay'));
  const batch: UcwaEventBatch = { sender: [{ rel: 'audioVideo', events: [{ type: 'updated' }] }] };
  await assert.rejects(controller.handleEvents(batch), (error: unknown) => error === failed);
  assert.equal(share.state, 'active');
  await controller.handleEvents(batch);
  assert.deepEqual(observed, [batch, batch]);
  await controller.close();
});

test('smoke media: capture sources are immutable snapshots across asynchronous native startup', async () => {
  const entered = deferred<void>();
  const complete = deferred<MediaEngineScreenSharing>();
  let requested: unknown;
  const { controller } = fixture({ startScreenSharing: async (request) => { requested = request.source; entered.resolve(); return complete.promise; } });
  const source = { kind: 'window' as const, id: 'original-window' };
  const start = controller.startScreenSharing(conversation('source-snapshot'), { source });
  await entered.promise;
  source.id = 'different-window';
  complete.resolve({ id: 'immutable-source', stop: () => {} });
  const share = await start;
  assert.deepEqual(requested, { kind: 'window', id: 'original-window' });
  assert.deepEqual(share.source, requested);
  assert.equal(Object.isFrozen(share.source), true);
  await controller.close();
});

test('smoke media: closing one account neither aborts nor releases another account backend', async () => {
  const { context } = fixture();
  const contexts: MediaEngineContext[] = [];
  const disposed: number[] = [];
  const factory = (value: MediaEngineContext): MediaEngine => {
    const account = contexts.push(value);
    return { id: `account-${account}`, capabilities: () => capabilities,
      startScreenSharing: async () => ({ id: `account-share-${account}`, stop: () => {} }),
      close: () => { disposed.push(account); },
    };
  };
  const first = new ScreenSharingController({ context, engineFactory: factory });
  const second = new ScreenSharingController({ context: { ...context, application: { url: `${origin}/applications/other`, data: {} } }, engineFactory: factory });
  const handles = await Promise.all([first.receiveScreenSharing(conversation('same')), second.receiveScreenSharing(conversation('same'))]);
  await first.close();
  assert.equal(handles[0]?.state, 'stopped');
  assert.equal(handles[1]?.state, 'active');
  assert.equal(contexts[0]?.signal.aborted, true);
  assert.equal(contexts[1]?.signal.aborted, false);
  assert.deepEqual(disposed, [1]);
  await second.close();
  assert.deepEqual(disposed, [1, 2]);
});

test('smoke media: SDP signaling survives real transport encoding and one authentication replay', async () => {
  const requests: { url: string; body: string; headers: Headers }[] = [];
  const sdp = `v=0\r\ns=Unicode 🦉 Grüße\r\na=label:${'camera-窓 '.repeat(2048)}\r\n`;
  const transport = new UcwaTransport({
    trustedOrigins: [origin],
    auth: { getAuthorization: async ({ challenge }) => challenge ? 'Bearer synthetic-refreshed' : 'Bearer synthetic-old' },
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push({ url: request.url, body: await request.text(), headers: request.headers });
      return requests.length === 1
        ? new Response(null, { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="synthetic"' } })
        : new Response(null, { status: 204 });
    },
  });
  class Session extends ResourceClient {
    async communication(): Promise<ResourceReference> {
      return { url: `${origin}/communication`, data: { _links: { startAudioVideo: { href: '/opaque/call?serverToken=preserve' }, startApplicationSharing: { href: '/opaque/sharing' } } } };
    }
  }
  const media = new SkypeForBusinessMedia(new Session(transport));
  await media.startAudioVideo({ to: 'sip:peer@example.test', operationId: 'media-smoke', mediaOffer: sdp, joinAudioMuted: false, joinVideoMuted: true });
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.body, requests[1]?.body);
  assert.equal(requests[1]?.headers.get('Authorization'), 'Bearer synthetic-refreshed');
  assert.equal(requests[1]?.headers.get('Content-Type'), 'application/json');
  const body = JSON.parse(requests[1]!.body) as { _links: { mediaOffer: { href: string } } };
  assert.equal(decodeSdpDataUri(body._links.mediaOffer.href), sdp);
  const answer: ResourceReference = { url: `${origin}/invitation`, data: { _links: { acceptWithAnswer: { href: '/opaque/accept?serverToken=preserve' } } } };
  await media.acceptWithAnswer(answer, { mediaAnswer: sdp, sessionContext: 'session + /?&', processedOfferId: 'offer/with&delimiters' });
  const sent = requests[2]!;
  assert.equal(sent.body, sdp);
  assert.equal(sent.headers.get('Content-Type'), 'application/sdp');
  const url = new URL(sent.url);
  assert.equal(url.searchParams.get('serverToken'), 'preserve');
  assert.equal(url.searchParams.get('sessionContext'), 'session + /?&');
  assert.equal(url.searchParams.get('processedOfferId'), 'offer/with&delimiters');
  await media.startApplicationSharing({ to: 'sip:peer@example.test', operationId: 'sharing-smoke', mediaOffer: sdp });
  assert.equal(requests[3]?.url, `${origin}/opaque/sharing`);
  assert.equal(decodeSdpDataUri((JSON.parse(requests[3]!.body) as typeof body)._links.mediaOffer.href), sdp);
});

test('smoke media: large UTF-8 SDP roundtrips and malformed inline encodings fail locally', async (t) => {
  const large = `v=0\r\ns=${'窓🦉é'.repeat(32768)}\r\n`;
  assert.equal(decodeSdpDataUri(encodeSdpDataUri(large)), large);
  for (const uri of [
    'https://untrusted.example.test/offer', 'data:text/plain,v%3D0',
    'data:application/sdp;base64,%%%%', 'data:application/sdp;base64,/w==',
    'data:application/sdp,', 'data:application/sdp,%', 'data:application/sdp,%FF',
    'data:application/sdp;base64,IA==', 'file:///tmp/media-offer',
  ]) await t.test(uri, () => { assert.throws(() => decodeSdpDataUri(uri), ProtocolError); });
});
