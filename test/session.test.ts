import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpError, MissingLinkError, ProtocolError } from '../src/errors.js';
import { getLink, getLinks, ResourceClient, type ResourceReference } from '../src/resources.js';
import { UcwaSession } from '../src/session.js';
import type { HttpResult, RequestOptions, Transport, UcwaResource } from '../src/types.js';

const origin = 'https://pool.example.test';
const applications = `${origin}/advertised/registrations`;
const applicationUrl = `${origin}/registrations/app-42`;
const application: UcwaResource = {
  _links: { self: { href: applicationUrl }, events: { href: '/notifications?ack=one' } },
  _embedded: {
    me: { _links: { self: { href: '/identity' }, makeMeAvailable: { href: '/capabilities/available' }, presence: { href: '/identity/presence' } } },
    people: { _links: { self: { href: '/directory' }, myContacts: { href: '/contacts' }, search: { href: '/find?scope=enterprise' } } },
    communication: { _links: { self: { href: '/conversations' }, startMessaging: { href: '/capabilities/start-chat' } } },
  },
};

interface Call { url: string; options: RequestOptions }
interface Reply { data?: unknown; status?: number; headers?: HeadersInit }
type Handler = (call: Call) => Reply | Promise<Reply>;

class FakeTransport implements Transport {
  readonly calls: Call[] = [];
  constructor(private readonly handler: Handler = () => ({})) {}
  async request<T>(url: string, options: RequestOptions = {}): Promise<HttpResult<T>> {
    const call = { url, options };
    this.calls.push(call);
    const reply = this.calls.length === 1 && options.method === 'POST' && url === applications
      ? { data: structuredClone(application), status: 201 }
      : await this.handler(call);
    return {
      data: reply.data as T | undefined,
      response: new Response(null, { status: reply.status ?? 200, ...(reply.headers ? { headers: reply.headers } : {}) }),
      url,
    };
  }
}

async function session(transport: Transport = new FakeTransport()): Promise<UcwaSession> {
  return UcwaSession.create(transport, applications, { userAgent: 'skypeforhoo-test/1', endpointId: 'test-device', culture: 'en-US' });
}

test('application registration uses supplied collection URL and requires usable metadata', async () => {
  const transport = new FakeTransport();
  const sdk = await session(transport);
  assert.equal(sdk.application.url, applicationUrl);
  assert.deepEqual(transport.calls[0], {
    url: applications,
    options: { method: 'POST', json: { userAgent: 'skypeforhoo-test/1', endpointId: 'test-device', culture: 'en-US' } },
  });
  await assert.rejects(UcwaSession.create(transport, applications, { userAgent: '' }), TypeError);
});

test('embedded hubs avoid extra requests while contacts and search follow capabilities', async () => {
  const transport = new FakeTransport(({ url }) => ({ data: { _links: { self: { href: url } }, _embedded: { contact: [] } } }));
  const sdk = await session(transport);
  await sdk.people();
  assert.equal(transport.calls.length, 1);
  await sdk.contacts();
  const results = await sdk.searchContacts('Alex & Engineering', { limit: 20 });
  assert.equal(transport.calls[1]?.url, `${origin}/contacts`);
  const search = new URL(results.url);
  assert.equal(search.pathname, '/find');
  assert.equal(search.searchParams.get('scope'), 'enterprise');
  assert.equal(search.searchParams.get('query'), 'Alex & Engineering');
  assert.equal(search.searchParams.get('limit'), '20');
  await assert.rejects(sdk.searchContacts('x', { limit: 101 }), TypeError);
});

test('makeAvailable defaults to messaging and later fetches fresh hub links', async () => {
  const transport = new FakeTransport(({ url }) => url === `${origin}/identity`
    ? { data: { _links: { self: { href: '/identity' }, presence: { href: '/identity/new-presence' } } } }
    : { status: 204 });
  const sdk = await session(transport);
  await sdk.makeAvailable({ signInAs: 'Busy' });
  await sdk.setPresence('Away');
  assert.deepEqual(transport.calls[1], {
    url: `${origin}/capabilities/available`,
    options: { method: 'POST', json: { supportedModalities: ['Messaging'], supportedMessageFormats: ['Plain'], signInAs: 'Busy' } },
  });
  assert.equal(transport.calls[2]?.url, `${origin}/identity`);
  assert.deepEqual(transport.calls[3], { url: `${origin}/identity/new-presence`, options: { method: 'POST', json: { availability: 'Away' } } });
});

test('makeAvailable refreshes initially unavailable startMessaging capability', async () => {
  const initial = structuredClone(application);
  initial._embedded!.communication = { _links: { self: { href: '/conversations' } } };
  const calls: Call[] = [];
  const transport: Transport = {
    async request<T>(url: string, options: RequestOptions = {}): Promise<HttpResult<T>> {
      calls.push({ url, options });
      const data = url === applications ? initial : url === `${origin}/conversations`
        ? { _links: { self: { href: '/conversations' }, startMessaging: { href: '/new-chat-operation' } } }
        : undefined;
      return { data: data as T | undefined, url, response: new Response(null, { status: data ? 200 : 204 }) };
    },
  };
  const sdk = await session(transport);
  await sdk.makeAvailable();
  await sdk.startMessaging({ to: 'sip:alex@example.test' });
  assert.equal(calls[2]?.url, `${origin}/conversations`);
  assert.equal(calls[3]?.url, `${origin}/new-chat-operation`);
});

test('setPresence without availability resets presence using an empty body', async () => {
  const transport = new FakeTransport(() => ({ status: 204 }));
  const sdk = await session(transport);
  await sdk.setPresence();
  assert.deepEqual(transport.calls[1], { url: `${origin}/identity/presence`, options: { method: 'POST' } });
});

test('startMessaging sends UTF-8 external message data with operation correlation', async () => {
  const transport = new FakeTransport(() => ({ status: 201, headers: { location: '/invitation/9' } }));
  const sdk = await session(transport);
  const result = await sdk.startMessaging({ to: 'sip:alex@example.test', message: 'Hi 👋 Grüße', operationId: 'invite-9' });
  assert.equal(result.response.status, 201);
  assert.equal(transport.calls[1]?.url, `${origin}/capabilities/start-chat`);
  const body = transport.calls[1]?.options.json as UcwaResource;
  assert.equal(body.to, 'sip:alex@example.test');
  assert.equal(body.operationId, 'invite-9');
  const href = (body._links?.message as { href: string }).href;
  assert.equal(new TextDecoder().decode(Uint8Array.from(atob(href.split(',')[1]!), (char) => char.charCodeAt(0))), 'Hi 👋 Grüße');
  assert.equal(body.message, undefined);
});

test('sendMessage resolves conversation messaging link, sends plain body, and preserves operationId query', async () => {
  const transport = new FakeTransport(({ url }) => url === `${origin}/chat/messaging`
    ? { data: { _links: { self: { href: '/chat/messaging' }, sendMessage: { href: '/operations/send?existing=1' }, setIsTyping: { href: '/operations/typing' } } } }
    : { status: 201 });
  const sdk = await session(transport);
  const conversation: ResourceReference = { data: { _links: { messaging: { href: '/chat/messaging' } } }, url: `${origin}/chat` };
  await sdk.sendMessage(conversation, 'Hello world', { operationId: 'send-42' });
  assert.equal(transport.calls[1]?.url, `${origin}/chat/messaging`);
  assert.deepEqual(transport.calls[2], {
    url: `${origin}/operations/send?existing=1&operationId=send-42`,
    options: { method: 'POST', body: 'Hello world', headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
  });
  await sdk.setTyping(conversation);
  assert.deepEqual(transport.calls[4], { url: `${origin}/operations/typing`, options: { method: 'POST' } });
});

test('missing capabilities fail without constructing guessed endpoint paths', async () => {
  const transport = new FakeTransport();
  const sdk = await session(transport);
  await assert.rejects(sdk.sendMessage({ url: applicationUrl, data: {} }, 'hello'), MissingLinkError);
  assert.equal(transport.calls.length, 1);
});

test('raw resource operations preserve arbitrary binary payloads and follow relative links', async () => {
  const transport = new FakeTransport(() => ({ status: 204 }));
  const client = new ResourceClient(transport);
  const resource = { data: { _links: { upload: { href: 'upload' } } }, url: `${origin}/files/metadata` };
  const body = new Uint8Array([1, 2, 3]);
  await client.invoke(resource, 'upload', { method: 'PUT', body });
  assert.equal(transport.calls[0]?.url, `${origin}/files/upload`);
  assert.equal(transport.calls[0]?.options.body, body);
  assert.deepEqual(getLinks({ _links: { contact: [{ href: '/a' }, { href: '/b' }] } }, 'contact', origin), [`${origin}/a`, `${origin}/b`]);
  assert.throws(() => getLink({ _links: { contact: [{ href: '/a' }, { href: '/b' }] } }, 'contact', origin), ProtocolError);
});

test('events follow opaque next URLs sequentially and stop when no next link is supplied', async () => {
  const transport = new FakeTransport(({ url }) => url.endsWith('ack=one')
    ? { data: { _links: { next: { href: '/opaque-cursor?ack=second&token=opaque' } }, sender: [{ rel: 'communication', events: [{ type: 'added', link: { href: '/message/1' } }] }] } }
    : { data: { sender: [] } });
  const sdk = await session(transport);
  const batches = [];
  for await (const batch of sdk.events()) batches.push(batch);
  assert.equal(batches.length, 2);
  assert.deepEqual(transport.calls.slice(1).map((call) => call.url), [`${origin}/notifications?ack=one`, `${origin}/opaque-cursor?ack=second&token=opaque`]);
  assert.equal(sdk.eventCursor, undefined);
});

test('event poll errors surface with resume cursor intact and no silent retry', async () => {
  const transport = new FakeTransport(({ url }) => {
    if (url.includes('ack=one')) throw new HttpError(410, url, new Response(null, { status: 410 }));
    return {};
  });
  const sdk = await session(transport);
  await assert.rejects(sdk.events().next(), (error: unknown) => error instanceof HttpError && error.status === 410);
  assert.equal(sdk.eventCursor, `${origin}/notifications?ack=one`);
  assert.equal(transport.calls.length, 2);
});

test('an interrupted event consumer replays its unacknowledged batch', async () => {
  const transport = new FakeTransport(() => ({ data: { _links: { next: { href: '/notifications?ack=two' } }, sender: [] } }));
  const sdk = await session(transport);
  for await (const _batch of sdk.events()) break;
  assert.equal(sdk.eventCursor, `${origin}/notifications?ack=one`);
  for await (const _batch of sdk.events()) break;
  assert.deepEqual(transport.calls.slice(1).map((call) => call.url), [`${origin}/notifications?ack=one`, `${origin}/notifications?ack=one`]);
});

test('close aborts an in-flight event poll and deletes registration once for concurrent callers', async () => {
  let started!: () => void;
  const pollingStarted = new Promise<void>((resolve) => { started = resolve; });
  const transport = new FakeTransport(({ url, options }) => {
    if (url.includes('/notifications')) {
      started();
      return new Promise<Reply>((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true }));
    }
    return { status: 204 };
  });
  const sdk = await session(transport);
  const pending = sdk.events().next();
  await pollingStarted;
  await Promise.all([sdk.close(), sdk.close()]);
  assert.deepEqual(await pending, { value: undefined, done: true });
  assert.equal(transport.calls.filter((call) => call.options.method === 'DELETE').length, 1);
  await assert.rejects(sdk.contacts(), ProtocolError);
});

test('consumer AbortSignal cancels polling independently of session close', async () => {
  const transport = new FakeTransport(({ options }) => new Promise<Reply>((_resolve, reject) => {
    options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
  }));
  const sdk = await session(transport);
  const controller = new AbortController();
  const pending = sdk.events({ signal: controller.signal }).next();
  controller.abort(new Error('consumer stopped'));
  await assert.rejects(pending, /consumer stopped/);
});
