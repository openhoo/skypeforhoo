import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpError, MissingLinkError, ProtocolError } from '../src/errors.js';
import type { ResourceReference } from '../src/resources.js';
import { UcwaSession } from '../src/session.js';
import type { HttpResult, RequestOptions, Transport, UcwaResource } from '../src/types.js';

const origin = 'https://session-smoke.example.test';
const applicationsUrl = `${origin}/advertised/application-collection`;
const applicationUrl = `${origin}/registered/app-smoke`;
const firstCursor = `${origin}/poll?ack=one&opaque=a%2Bb%3D`;

interface Call { url: string; options: RequestOptions }
type Handler = (call: Call) => unknown | Promise<unknown>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(handler: Handler = () => undefined, customize?: (resource: UcwaResource) => void) {
  const calls: Call[] = [];
  const application: UcwaResource = {
    _links: { self: { href: applicationUrl }, events: { href: firstCursor } },
    _embedded: {
      me: { _links: { self: { href: '/me' }, makeMeAvailable: { href: '/advertised/make-available' } } },
      communication: { _links: { self: { href: '/communication' }, startMessaging: { href: '/advertised/start-messaging' } } },
      people: { _links: { self: { href: '/people' }, search: { href: '/directory/find?scope=all' } } },
    },
  };
  customize?.(application);
  const transport: Transport = {
    async request<T>(url: string, options: RequestOptions = {}): Promise<HttpResult<T>> {
      const call = { url, options };
      calls.push(call);
      const data = url === applicationsUrl && options.method === 'POST'
        ? structuredClone(application)
        : await handler(call);
      return { url, data: data as T | undefined, response: new Response(null, { status: data === undefined ? 204 : 200 }) };
    },
  };
  return {
    calls,
    create: () => UcwaSession.create(transport, applicationsUrl, { userAgent: 'heavy-session-smoke', endpointId: 'synthetic-session-smoke' }),
  };
}

test('smoke events: 256 opaque batches preserve every sender/event and acknowledge only on resume', async () => {
  let polls = 0;
  let concurrent = 0;
  let peak = 0;
  const setup = fixture(async ({ url }) => {
    if (!url.includes('/poll')) return undefined;
    peak = Math.max(peak, ++concurrent);
    await Promise.resolve();
    const index = polls++;
    if (index === 0) assert.equal(url, firstCursor);
    else assert.equal(url, `${origin}/poll?opaque=${index}%2Btoken&ack=${index}&same=1&same=2`);
    concurrent--;
    return {
      index,
      ...(index === 255 ? {} : { _links: { next: { href: `/poll?opaque=${index + 1}%2Btoken&ack=${index + 1}&same=1&same=2` } } }),
      sender: [
        { rel: 'communication', events: [{ type: 'updated', message: `Grüße ${index} 👋` }, { type: 'added', operationId: `op-${index}` }] },
        { rel: 'people', events: [{ type: 'deleted', href: `/contact/${index}` }] },
      ],
    };
  });
  const session = await setup.create();
  const batches = [];
  for await (const batch of session.events()) {
    assert.equal(polls, batches.length + 1);
    assert.equal(batch.index, batches.length);
    assert.equal(batch.sender?.[0]?.events?.[0]?.message, `Grüße ${batches.length} 👋`);
    assert.equal(batch.sender?.[1]?.events?.[0]?.type, 'deleted');
    batches.push(batch);
  }
  assert.equal(batches.length, 256);
  assert.equal(peak, 1);
  assert.equal(session.eventCursor, undefined);
  await session.close();
});

test('smoke events: application handler failure releases poll ownership and replays the same batch', async () => {
  const failure = new Error('synthetic persistence failed');
  const setup = fixture(({ url }) => url === firstCursor ? { sender: [{ events: [{ type: 'added', messageId: 'stable-1' }] }], _links: { next: { href: '/poll?ack=two' } } } : { sender: [] });
  const session = await setup.create();
  await assert.rejects((async () => {
    for await (const _batch of session.events()) throw failure;
  })(), (error) => error === failure);
  assert.equal(session.eventCursor, firstCursor);
  const retry = session.events();
  assert.equal((await retry.next()).value?.sender?.[0]?.events?.[0]?.messageId, 'stable-1');
  await retry.return();
  assert.equal(session.eventCursor, firstCursor);
  assert.equal(setup.calls.filter(({ url }) => url === firstCursor).length, 2);
  await session.close();
});

test('smoke events: a suspended yielded batch still prevents a second poller', async () => {
  const setup = fixture(() => ({ sender: [] }));
  const session = await setup.create();
  const first = session.events();
  await first.next();
  const count = setup.calls.length;
  await assert.rejects(session.events().next(), ProtocolError);
  assert.equal(setup.calls.length, count);
  await first.return();
  const retry = session.events();
  await retry.next();
  await retry.return();
  await session.close();
});

test('smoke events: pre-aborted consumption performs no poll and does not lock out recovery', async () => {
  const setup = fixture(() => ({ sender: [] }));
  const session = await setup.create();
  const failure = new Error('already stopped');
  const stopped = new AbortController();
  stopped.abort(failure);
  await assert.rejects(session.events({ signal: stopped.signal }).next(), (error) => error === failure);
  assert.equal(setup.calls.length, 1);
  const retry = session.events();
  assert.equal((await retry.next()).done, false);
  await retry.return();
  await session.close();
});

test('smoke events: transient failure after an acknowledged batch resumes from the second cursor', async () => {
  const secondCursor = `${origin}/poll?ack=two&opaque=x%2Fy`;
  let secondAttempts = 0;
  const setup = fixture(({ url }) => {
    if (url === firstCursor) return { sender: [], _links: { next: { href: secondCursor } } };
    if (url === secondCursor && ++secondAttempts === 1) throw new HttpError(503, url, new Response(null, { status: 503 }));
    return { sender: [{ events: [{ type: 'added', messageId: 'message-2' }] }] };
  });
  const session = await setup.create();
  const first = session.events();
  await first.next();
  await assert.rejects(first.next(), (error) => error instanceof HttpError && error.status === 503);
  assert.equal(session.eventCursor, secondCursor);
  const retry = session.events();
  assert.equal((await retry.next()).value?.sender?.[0]?.events?.[0]?.messageId, 'message-2');
  await retry.next();
  assert.equal(setup.calls.filter(({ url }) => url === firstCursor).length, 1);
  assert.equal(secondAttempts, 2);
  await session.close();
});

test('smoke events: malformed next links surface without acknowledging the current batch', async () => {
  let replies = 0;
  const setup = fixture(() => ++replies === 1
    ? { sender: [], _links: { next: [{ href: '/poll?a=1' }, { href: '/poll?a=2' }] } }
    : { sender: [] });
  const session = await setup.create();
  await assert.rejects(session.events().next(), ProtocolError);
  assert.equal(session.eventCursor, firstCursor);
  const retry = session.events();
  await retry.next();
  await retry.return();
  assert.equal(setup.calls.filter(({ url }) => url === firstCursor).length, 2);
  await session.close();
});

test('smoke events: close discards a late transport response without yielding it', { timeout: 5_000 }, async () => {
  const poll = deferred<unknown>();
  const started = deferred<void>();
  const setup = fixture(({ url }) => {
    if (url !== firstCursor) return undefined;
    started.resolve();
    return poll.promise;
  });
  const session = await setup.create();
  const next = session.events().next();
  await started.promise;
  await session.close();
  poll.resolve({ sender: [{ events: [{ type: 'added' }] }] });
  assert.deepEqual(await next, { done: true, value: undefined });
  assert.equal(setup.calls.filter(({ options }) => options.method === 'DELETE').length, 1);
});

test('smoke lifecycle: deletion failure keeps the session closed while allowing one coordinated retry', async () => {
  let deletes = 0;
  const setup = fixture(({ options, url }) => {
    if (options.method === 'DELETE' && ++deletes === 1) throw new HttpError(503, url, new Response(null, { status: 503 }));
    return undefined;
  });
  const session = await setup.create();
  const first = session.close();
  assert.equal(session.close(), first);
  await assert.rejects(first, HttpError);
  const count = setup.calls.length;
  await assert.rejects(session.startMessaging({ to: 'sip:synthetic@example.test' }), ProtocolError);
  await assert.rejects(session.events().next(), ProtocolError);
  assert.equal(setup.calls.length, count);
  const retry = session.close();
  assert.equal(session.close(), retry);
  await retry;
  assert.equal(deletes, 2);
});

test('smoke lifecycle: already removed application registrations close successfully for 404 and 410', async () => {
  for (const status of [404, 410]) {
    const setup = fixture(({ options, url }) => {
      if (options.method === 'DELETE') throw new HttpError(status, url, new Response(null, { status }));
      return undefined;
    });
    const session = await setup.create();
    await session.close();
    await session.close();
    assert.equal(setup.calls.filter(({ options }) => options.method === 'DELETE').length, 1);
  }
});

test('smoke messaging: HTML invitations preserve Unicode, supplied correlation ID and operation headers', async () => {
  const setup = fixture(() => undefined);
  const session = await setup.create();
  const message = '<p>مرحبا, Grüße, 👩🏽‍💻 &amp; 你好</p>';
  await session.startMessaging({ to: 'sip:synthetic@example.test', operationId: 'smoke-op-42', message, messageFormat: 'Html', importance: 'Urgent', subject: 'Smoke' });
  const call = setup.calls[1]!;
  assert.equal(call.url, `${origin}/advertised/start-messaging`);
  const body = call.options.json as UcwaResource;
  assert.equal(body.operationId, 'smoke-op-42');
  assert.equal(body.importance, 'Urgent');
  const messageLink = body._links?.message;
  assert.ok(messageLink && !Array.isArray(messageLink));
  assert.match(messageLink.href, /^data:text\/html;charset=utf-8;base64,/);
  assert.equal(Buffer.from(messageLink.href.split(',')[1]!, 'base64').toString('utf8'), message);
  await session.close();
});

test('smoke messaging: encoded operation IDs preserve opaque server query parameters and text payload', async () => {
  const setup = fixture();
  const session = await setup.create();
  const messaging: ResourceReference = {
    url: `${origin}/conversation/messaging`,
    data: { _links: { sendMessage: { href: '/write?opaque=a%2Fb&operationId=old&scope=one&scope=two' } } },
  };
  const operationId = 'id / + & = ? Grüße';
  const message = 'line 1\nline 2\r\nemoji 👋';
  await session.sendMessage(messaging, message, { operationId, format: 'Html' });
  const call = setup.calls[1]!;
  const url = new URL(call.url);
  assert.equal(url.searchParams.get('operationId'), operationId);
  assert.equal(url.searchParams.get('opaque'), 'a/b');
  assert.deepEqual(url.searchParams.getAll('scope'), ['one', 'two']);
  assert.equal(call.options.body, message);
  assert.equal(new Headers(call.options.headers).get('content-type'), 'text/html; charset=utf-8');
  await session.close();
});

test('smoke messaging: missing and ambiguous send capabilities fail without performing a write', async () => {
  const setup = fixture();
  const session = await setup.create();
  await assert.rejects(session.sendMessage({ url: applicationUrl, data: {} }, 'synthetic'), MissingLinkError);
  await assert.rejects(session.sendMessage({ url: applicationUrl, data: { _links: { sendMessage: [{ href: '/write/a' }, { href: '/write/b' }] } } }, 'synthetic'), ProtocolError);
  assert.equal(setup.calls.length, 1);
  await session.close();
});

test('smoke messaging: a delayed capability lookup cannot send a message after session.close()', { timeout: 5_000 }, async () => {
  const messaging = deferred<unknown>();
  const started = deferred<void>();
  const setup = fixture(({ url }) => {
    if (url !== `${origin}/conversation/messaging`) return undefined;
    started.resolve();
    return messaging.promise;
  });
  const session = await setup.create();
  const conversation: ResourceReference = { url: `${origin}/conversation`, data: { _links: { messaging: { href: '/conversation/messaging' } } } };
  const sending = session.sendMessage(conversation, 'synthetic message', { operationId: 'after-close-smoke' });
  await started.promise;
  await session.close();
  messaging.resolve({ _links: { self: { href: '/conversation/messaging' }, sendMessage: { href: '/advertised/send' } } });
  const outcome = await sending.then(() => undefined, (error: unknown) => error);
  assert.equal(setup.calls.filter(({ url, options }) => url.startsWith(`${origin}/advertised/send`) && options.method === 'POST').length, 0, 'must not POST a message after deleting the UCWA application');
  assert.ok(outcome instanceof ProtocolError, 'pending send should reject because the session has closed');
});

test('smoke capabilities: an old in-flight hub read cannot repopulate the cache after makeAvailable()', { timeout: 5_000 }, async () => {
  const oldHub = deferred<unknown>();
  const started = deferred<void>();
  let available = false;
  let communicationReads = 0;
  const setup = fixture(({ url }) => {
    if (url === `${origin}/advertised/make-available`) { available = true; return undefined; }
    if (url === `${origin}/communication`) {
      communicationReads++;
      if (!available) { started.resolve(); return oldHub.promise; }
      return { _links: { self: { href: '/communication' }, startMessaging: { href: '/advertised/new-start' } } };
    }
    return undefined;
  }, (application) => {
    application._links!.communication = { href: '/communication' };
    delete application._embedded!.communication;
  });
  const session = await setup.create();
  const reading = session.communication();
  await started.promise;
  await session.makeAvailable();
  oldHub.resolve({ _links: { self: { href: '/communication' }, startMessaging: { href: '/advertised/stale-start' } } });
  await reading;
  await session.startMessaging({ to: 'sip:synthetic@example.test', operationId: 'post-available-smoke' });
  const start = setup.calls.find(({ url }) => url.includes('/advertised/') && url.endsWith('-start'));
  await session.close();
  assert.equal(start?.url, `${origin}/advertised/new-start`, 'startMessaging must use the capability advertised after makeAvailable');
  assert.equal(communicationReads, 2, 'the pre-availability resource must not remain cached');
});
