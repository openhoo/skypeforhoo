import assert from 'node:assert/strict';
import test from 'node:test';
import { MissingLinkError, ProtocolError } from '../src/errors.js';
import { decodeSdpDataUri, encodeSdpDataUri, mediaDescription, SkypeForBusinessMedia, type MediaSignalingSession } from '../src/media.js';
import { ResourceClient, type ResourceReference } from '../src/resources.js';
import type { HttpResult, RequestOptions, Transport } from '../src/types.js';

const origin = 'https://media.example.test';
const offer = 'v=0\r\no=- 1234 1 IN IP4 192.0.2.1\r\ns=Grüße 👋\r\n';

function resource(links: Record<string, string>, path = '/resource'): ResourceReference {
  return { url: `${origin}${path}`, data: { _links: Object.fromEntries(Object.entries(links).map(([rel, href]) => [rel, { href }])) } };
}

interface Call { url: string; options: RequestOptions }
class FakeTransport implements Transport {
  readonly calls: Call[] = [];
  constructor(private readonly reply: (call: Call) => { data?: unknown; status?: number; headers?: HeadersInit } = () => ({ status: 204 })) {}
  async request<T>(url: string, options: RequestOptions = {}): Promise<HttpResult<T>> {
    const call = { url, options };
    this.calls.push(call);
    const reply = this.reply(call);
    return {
      data: reply.data as T | undefined, url,
      response: new Response(null, { status: reply.status ?? 200, ...(reply.headers ? { headers: reply.headers } : {}) }),
    };
  }
}

class FakeSession extends ResourceClient implements MediaSignalingSession {
  closed = false;
  constructor(transport: Transport, private readonly hub = resource({ startAudio: '/call/audio', startVideo: '/call/video', startAudioVideo: '/call/av' })) { super(transport); }
  protected override assertUsable(): void { if (this.closed) throw new ProtocolError('Session closed.'); }
  async communication(): Promise<ResourceReference> { this.assertUsable(); return this.hub; }
}

test('media call invitation encodes an SDP external resource and preserves acceptance metadata', async () => {
  const transport = new FakeTransport(() => ({ status: 201, headers: { location: '/invitation/42' } }));
  const media = new SkypeForBusinessMedia(new FakeSession(transport));
  const abort = new AbortController();
  const result = await media.startAudioVideo({ to: 'sip:alex@example.test', operationId: 'call-42', mediaOffer: offer, sessionContext: 'endpoint-a', joinAudioMuted: true, joinVideoMuted: false, subject: 'Project', signal: abort.signal });
  assert.equal(result.response.status, 201);
  assert.equal(result.response.headers.get('location'), '/invitation/42');
  assert.equal(result.data, undefined);
  assert.deepEqual(transport.calls[0], {
    url: `${origin}/call/av`, options: {
      method: 'POST', signal: abort.signal,
      json: { to: 'sip:alex@example.test', operationId: 'call-42', sessionContext: 'endpoint-a', joinAudioMuted: true, joinVideoMuted: false, subject: 'Project', _links: { mediaOffer: { href: encodeSdpDataUri(offer) } } },
    },
  });
});

test('single modalities and conversation escalation use only their advertised operation links', async () => {
  const transport = new FakeTransport();
  const media = new SkypeForBusinessMedia(new FakeSession(transport));
  const audioVideo = resource({ addAudio: 'relative/audio', addVideo: '/upgrades/video', addAudioVideo: '/upgrades/av' }, '/opaque/current');
  await media.startAudio({ to: 'sip:alex@example.test', joinAudioMuted: true });
  await media.startVideo({ to: 'sip:alex@example.test', joinVideoMuted: true });
  await media.addAudio(audioVideo, { to: 'sip:alex@example.test', operationId: 'add-a', mediaOffer: offer });
  await media.addVideo(audioVideo, { to: 'sip:alex@example.test', operationId: 'add-v', mediaOffer: offer });
  await media.addAudioVideo(audioVideo, { to: 'sip:alex@example.test', operationId: 'add-av', mediaOffer: offer });
  assert.deepEqual(transport.calls.map((call) => call.url), [
    `${origin}/call/audio`, `${origin}/call/video`, `${origin}/opaque/relative/audio`, `${origin}/upgrades/video`, `${origin}/upgrades/av`,
  ]);
  const audioBody = transport.calls[0]?.options.json as { operationId: string; joinAudioMuted: boolean };
  assert.equal(audioBody.joinAudioMuted, true);
  assert.match(audioBody.operationId, /^[0-9a-f-]{36}$/);
  assert.equal((transport.calls[1]?.options.json as { joinVideoMuted: boolean }).joinVideoMuted, true);
});

test('wider option objects do not send fields belonging to another media operation', async () => {
  const transport = new FakeTransport();
  const media = new SkypeForBusinessMedia(new FakeSession(transport, resource({
    startAudio: '/audio', startAudioVideo: '/av', startApplicationSharing: '/sharing',
  })));
  const options = { to: 'sip:alex@example.test', operationId: 'operation-1', subject: 'Call', threadId: 'thread-1', joinAudioMuted: true, joinVideoMuted: true, telemetryId: 'telemetry-1', mediaOffer: offer, unrelated: 'host-only' };
  await media.startAudio(options);
  await media.startAudioVideo(options);
  await media.startApplicationSharing(options);
  await media.addAudioVideo(resource({ addAudioVideo: '/add-av' }), options);
  await media.addApplicationSharing(resource({ addApplicationSharing: '/add-sharing' }), options);
  const bodies = transport.calls.map((call) => call.options.json as Record<string, unknown>);
  assert.equal(bodies[0]?.joinVideoMuted, undefined);
  assert.equal(bodies[1]?.joinAudioMuted, true);
  assert.equal(bodies[1]?.joinVideoMuted, true);
  assert.equal(bodies[1]?.telemetryId, undefined);
  assert.equal(bodies[2]?.joinAudioMuted, undefined);
  assert.equal(bodies[2]?.joinVideoMuted, undefined);
  assert.equal(bodies[2]?.telemetryId, 'telemetry-1');
  assert.equal(bodies[3]?.subject, undefined);
  assert.equal(bodies[3]?.threadId, undefined);
  assert.equal(bodies[4]?.to, undefined);
  assert.equal(bodies[4]?.subject, undefined);
  assert.equal(bodies[4]?.joinAudioMuted, undefined);
  assert.equal(bodies[4]?.telemetryId, 'telemetry-1');
  assert.ok(bodies.every((body) => body.unrelated === undefined));
});

test('media answer and provisional answer use raw SDP with required encoded session context', async () => {
  const transport = new FakeTransport();
  const media = new SkypeForBusinessMedia(new FakeSession(transport));
  const invitation = resource({ acceptWithAnswer: '/accept?server=one', sendProvisionalAnswer: '/provisional' });
  await media.acceptWithAnswer(invitation, { sessionContext: 'device/a & b', mediaAnswer: offer, processedOfferId: 'offer+42' });
  await media.sendProvisionalAnswer(invitation, { sessionContext: 'device-a', mediaAnswer: offer });
  const accepted = transport.calls[0]!;
  const url = new URL(accepted.url);
  assert.equal(url.pathname, '/accept');
  assert.equal(url.searchParams.get('server'), 'one');
  assert.equal(url.searchParams.get('sessionContext'), 'device/a & b');
  assert.equal(url.searchParams.get('processedOfferId'), 'offer+42');
  assert.deepEqual(accepted.options, { method: 'POST', body: offer, headers: { 'Content-Type': 'application/sdp' } });
  assert.equal(transport.calls[1]?.url, `${origin}/provisional?sessionContext=device-a`);
  assert.equal(transport.calls[1]?.options.body, offer);
});

test('decline, cancellation, modality stop and conversation termination keep their distinct wire semantics', async () => {
  const transport = new FakeTransport();
  const media = new SkypeForBusinessMedia(new FakeSession(transport));
  const invitation = resource({ decline: '/decline', cancel: '/cancel' });
  const audioVideo = resource({ stopAudio: '/stop-a', stopVideo: '/stop-v', stopAudioVideo: '/stop-av?scope=local' });
  await media.decline(invitation);
  await media.decline(invitation, { reason: 'CodecMismatch' });
  await media.cancel(invitation);
  await media.stopAudio(audioVideo);
  await media.stopVideo(audioVideo);
  await media.stopAudioVideo(audioVideo, { reason: 'UserInitiatedAction' });
  await media.endConversation(resource({ self: '/conversations/opaque-id' }));
  assert.deepEqual(transport.calls.map((call) => call.options), [
    { method: 'POST' }, { method: 'POST', json: { reason: 'CodecMismatch' } },
    { method: 'POST' }, { method: 'POST' }, { method: 'POST' }, { method: 'POST' }, { method: 'DELETE' },
  ]);
  assert.equal(transport.calls[5]?.url, `${origin}/stop-av?scope=local&reason=UserInitiatedAction`);
  assert.equal(transport.calls[6]?.url, `${origin}/conversations/opaque-id`);
});

test('participant audio/video control follows the participant modality resource and has no JSON body', async () => {
  const transport = new FakeTransport(({ url }) => ({ data: url.endsWith('/audio')
    ? { _links: { self: { href: url }, muteAudio: { href: '/mute/a' }, unmuteAudio: { href: '/unmute/a' } } }
    : { _links: { self: { href: url }, muteVideo: { href: '/mute/v' }, unmuteVideo: { href: '/unmute/v' } } } }));
  const media = new SkypeForBusinessMedia(new FakeSession(transport));
  const participant = resource({ participantAudio: '/participant/audio', participantVideo: '/participant/video' });
  const audio = await media.participantAudio(participant);
  const video = await media.participantVideo(participant);
  await media.muteAudio(audio);
  await media.unmuteAudio(audio);
  await media.muteVideo(video);
  await media.unmuteVideo(video);
  assert.deepEqual(transport.calls.slice(2).map((call) => [call.url, call.options]), [
    [`${origin}/mute/a`, { method: 'POST' }], [`${origin}/unmute/a`, { method: 'POST' }],
    [`${origin}/mute/v`, { method: 'POST' }], [`${origin}/unmute/v`, { method: 'POST' }],
  ]);
});

test('sharing inspection and capability reports retain the advertised resource scope', async () => {
  const transport = new FakeTransport(({ url }) => ({ data: url.endsWith('/sharing')
    ? { state: 'Connected', _links: { self: { href: url }, applicationSharer: { href: '/presenter' } } }
    : { name: 'Alex', uri: 'sip:alex@example.test' } }));
  const media = new SkypeForBusinessMedia(new FakeSession(transport));
  const conversation = resource({ applicationSharing: '/sharing' });
  const capabilities = media.capabilities(conversation);
  assert.equal(capabilities.applicationSharing, true);
  assert.equal(capabilities.startAudioVideo, false);
  assert.equal(capabilities.startApplicationSharing, false);
  assert.equal(Object.isFrozen(capabilities), true);
  const sharing = await media.applicationSharing(conversation);
  assert.equal(sharing.data.state, 'Connected');
  const sharer = await media.applicationSharer(sharing);
  assert.equal(sharer.data.uri, 'sip:alex@example.test');
  await assert.rejects(media.stopAudioVideo(conversation), (error: unknown) => error instanceof MissingLinkError && error.relation === 'stopAudioVideo');
  assert.equal(transport.calls.length, 2);
  assert.equal((await media.communicationCapabilities()).startAudioVideo, true);
});

test('native sharing extension emits metadata-derived payloads only through advertised links', async () => {
  const transport = new FakeTransport(() => ({ status: 201, headers: { location: '/sharing/invitation' } }));
  const session = new FakeSession(transport, resource({ startApplicationSharing: '/native/offer-sharing' }));
  const media = new SkypeForBusinessMedia(session);
  const sharing = resource({ addApplicationSharing: '/native/add-sharing', stopApplicationSharing: '/native/stop-sharing' });
  const result = await media.startApplicationSharing({ to: 'sip:alex@example.test', operationId: 'share-1', mediaOffer: offer, sessionContext: 'screen-a', subject: 'Presenting', threadId: 'thread-1', importance: 'Normal', telemetryId: 'telemetry-1' });
  await media.addApplicationSharing(sharing, { operationId: 'share-2', mediaOffer: offer, sessionContext: 'screen-b', telemetryId: 'telemetry-2' });
  await media.stopApplicationSharing(sharing);
  assert.equal(result.response.headers.get('location'), '/sharing/invitation');
  assert.deepEqual(transport.calls, [
    { url: `${origin}/native/offer-sharing`, options: { method: 'POST', json: {
      to: 'sip:alex@example.test', operationId: 'share-1', sessionContext: 'screen-a', subject: 'Presenting', threadId: 'thread-1', importance: 'Normal', telemetryId: 'telemetry-1', _links: { mediaOffer: { href: encodeSdpDataUri(offer) } },
    } } },
    { url: `${origin}/native/add-sharing`, options: { method: 'POST', json: {
      operationId: 'share-2', sessionContext: 'screen-b', telemetryId: 'telemetry-2', _links: { mediaOffer: { href: encodeSdpDataUri(offer) } },
    } } },
    { url: `${origin}/native/stop-sharing`, options: { method: 'POST' } },
  ]);
  assert.equal((await media.communicationCapabilities()).startApplicationSharing, true);
  assert.equal(media.capabilities(sharing).stopApplicationSharing, true);
});

test('native sharing extensions reject absent links without constructing or contacting guessed endpoints', async () => {
  const transport = new FakeTransport();
  const media = new SkypeForBusinessMedia(new FakeSession(transport, resource({})));
  for (const [relation, work] of [
    ['startApplicationSharing', () => media.startApplicationSharing({ to: 'sip:alex@example.test', mediaOffer: offer })],
    ['addApplicationSharing', () => media.addApplicationSharing(resource({}), { mediaOffer: offer })],
    ['stopApplicationSharing', () => media.stopApplicationSharing(resource({}))],
  ] as const) {
    await assert.rejects(work(), (error: unknown) => error instanceof MissingLinkError && error.relation === relation);
  }
  assert.equal(transport.calls.length, 0);
});

test('SDP helpers preserve UTF-8 and reject remote URLs, wrong media types and invalid encoding without fetching', () => {
  assert.equal(decodeSdpDataUri(encodeSdpDataUri(offer)), offer);
  assert.equal(decodeSdpDataUri(`data:application/sdp;charset=utf-8,${encodeURIComponent(offer)}`), offer);
  assert.equal(mediaDescription(resource({ mediaAnswer: encodeSdpDataUri(offer) }), 'mediaAnswer'), offer);
  assert.throws(() => mediaDescription(resource({}), 'mediaOffer'), MissingLinkError);
  for (const uri of ['https://other.example.test/answer', 'data:text/html;base64,dm89MA==', 'data:application/sdp;base64,%%%invalid', 'data:application/sdp;base64,/w==', 'data:application/sdp,']) {
    assert.throws(() => decodeSdpDataUri(uri), ProtocolError);
  }
  assert.throws(() => encodeSdpDataUri(''), TypeError);
});

test('invalid media operation input fails before sending any HTTP request', async () => {
  const transport = new FakeTransport();
  const media = new SkypeForBusinessMedia(new FakeSession(transport));
  const invitation = resource({ acceptWithAnswer: '/accept' });
  await assert.rejects(media.startAudioVideo({ to: '', mediaOffer: offer }), TypeError);
  await assert.rejects(media.startAudio({ to: 'sip:alex@example.test', subject: 'x'.repeat(251) }), TypeError);
  await assert.rejects(media.startVideo({ to: 'sip:alex@example.test', sessionContext: 'x'.repeat(51) }), TypeError);
  await assert.rejects(media.addAudio(resource({ addAudio: '/add' }), { to: 'sip:alex@example.test', operationId: '', mediaOffer: offer }), TypeError);
  await assert.rejects(media.acceptWithAnswer(invitation, { sessionContext: '', mediaAnswer: offer }), TypeError);
  await assert.rejects(media.acceptWithAnswer(invitation, { sessionContext: 'device', mediaAnswer: '' }), TypeError);
  await assert.rejects(media.acceptWithAnswer(invitation, { sessionContext: 'device', mediaAnswer: offer, processedOfferId: 'x'.repeat(101) }), TypeError);
  assert.equal(transport.calls.length, 0);
});

test('media relays support documented embedded arrays and advertised link collections', async () => {
  const transport = new FakeTransport(({ url }) => ({ data: { host: url.endsWith('/one') ? 'one.example.test' : 'two.example.test' } }));
  const media = new SkypeForBusinessMedia(new FakeSession(transport));
  const embedded: ResourceReference = { url: `${origin}/token`, data: { _embedded: { mediaRelay: [
    { host: 'one.example.test', tcpPort: 443, _links: { self: { href: '/relays/one' } } },
    { host: 'two.example.test', udpPort: 3478, _links: { self: { href: '/relays/two' } } },
  ] } } };
  const relays = await media.mediaRelays(embedded);
  assert.deepEqual(relays.map((relay) => [relay.url, relay.data.host]), [[`${origin}/relays/one`, 'one.example.test'], [`${origin}/relays/two`, 'two.example.test']]);
  assert.equal(transport.calls.length, 0);
  const linked: ResourceReference = { url: `${origin}/token`, data: { _links: { mediaRelay: [{ href: '/relays/one' }, { href: '/relays/two' }] } } };
  assert.deepEqual((await media.mediaRelays(linked)).map((relay) => relay.data.host), ['one.example.test', 'two.example.test']);
  await assert.rejects(media.mediaRelays({ url: `${origin}/token`, data: { _embedded: { mediaRelay: [null] } } }), ProtocolError);
});

test('all media HTTP operations retain the owning session lifecycle checks', async () => {
  const transport = new FakeTransport();
  const session = new FakeSession(transport);
  const media = new SkypeForBusinessMedia(session);
  session.closed = true;
  await assert.rejects(media.startAudio({ to: 'sip:alex@example.test' }), ProtocolError);
  await assert.rejects(media.acceptWithAnswer(resource({ acceptWithAnswer: '/accept' }), { sessionContext: 'device', mediaAnswer: offer }), ProtocolError);
  await assert.rejects(media.stopAudio(resource({ stopAudio: '/stop' })), ProtocolError);
  await assert.rejects(media.endConversation(resource({ self: '/conversation' })), ProtocolError);
  await assert.rejects(media.applicationSharing(resource({ applicationSharing: '/sharing' })), ProtocolError);
  assert.equal(transport.calls.length, 0);
});
