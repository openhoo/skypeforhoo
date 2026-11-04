import assert from 'node:assert/strict';
import test from 'node:test';
import { passwordAuth, SkypeForHoo, type Fetch } from '../src/index.js';

test('public client connects with separate credentials, exchanges UCWA operations and events, and shuts down', async () => {
  const discovery = 'https://lyncdiscover.example.test/';
  const pool = 'https://pool.example.test';
  const issuer = 'https://identity.example.test';
  const userUrl = `${pool}/discovery/opaque-user?originalDomain=example.test`;
  const tokenUrl = `${issuer}/issue-access-token`;
  const applicationsUrl = `${pool}/service/custom-registrations`;
  const applicationUrl = `${pool}/service/application/not-a-numeric-id`;
  const firstCursor = `${pool}/event-stream?ack=opaque-zero`;
  const nextCursor = `${pool}/continuation/unpredictable?ack=opaque-next&checkpoint=leave-intact`;
  const loginUsername = 'CORP\\login.name';
  const password = 'synthetic-password-for-fixtures';
  const token = 'synthetic-access-token';
  const operationId = 'outgoing-invitation-42';
  const calls: { url: string; method: string; headers: Headers; body: BodyInit | null | undefined }[] = [];
  let available = false;
  let startInvitation!: () => void;
  const invitationStarted = new Promise<void>((resolve) => { startInvitation = resolve; });
  let startPolling!: () => void;
  const pollingStarted = new Promise<void>((resolve) => { startPolling = resolve; });
  let startSecondPoll!: () => void;
  const secondPollStarted = new Promise<void>((resolve) => { startSecondPoll = resolve; });
  const json = (data: unknown, status = 200, headers: HeadersInit = {}) => Response.json(data, { status, headers });

  const fetch: Fetch = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : input.toString();
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    calls.push({ url, method, headers, body: init.body });
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'manual');

    if (url === discovery) {
      assert.equal(headers.get('Authorization'), null);
      assert.equal(init.body, undefined);
      return json({ _links: { self: { href: discovery }, user: { href: userUrl } } });
    }
    if (url === tokenUrl) {
      assert.equal(method, 'POST');
      assert.equal(headers.get('Authorization'), null);
      const credentials = new URLSearchParams(String(init.body));
      assert.equal(credentials.get('username'), loginUsername);
      assert.notEqual(credentials.get('username'), 'sip.identity@example.test');
      assert.equal(credentials.get('password'), password);
      assert.equal(credentials.get('grant_type'), 'password');
      return json({ access_token: token, token_type: 'Bearer', expires_in: 3600 });
    }
    if (url === userUrl) {
      if (!headers.has('Authorization')) {
        return new Response(null, { status: 401, headers: { 'WWW-Authenticate': `MsRtcOAuth href="${tokenUrl}", grant_type="password,urn:microsoft.rtc:windows"` } });
      }
      assert.equal(headers.get('Authorization'), `Bearer ${token}`);
      return json({ _links: { self: { href: userUrl }, applications: { href: applicationsUrl } } });
    }

    assert.equal(headers.get('Authorization'), `Bearer ${token}`);
    assert.ok(!String(init.body ?? '').includes(password), 'Only the token issuer receives the password');
    if (url === applicationsUrl) {
      assert.equal(method, 'POST');
      assert.deepEqual(JSON.parse(String(init.body)), { userAgent: 'integration-fixture/1', culture: 'en-US', endpointId: 'fixture-endpoint' });
      return json({
        _links: { self: { href: applicationUrl }, events: { href: firstCursor } },
        _embedded: {
          me: { _links: { self: { href: '/identity' }, makeMeAvailable: { href: '/capabilities/receive-messages' } } },
          people: { _links: { self: { href: '/directory' }, myContacts: { href: '/my-advertised-contacts' } } },
          communication: { _links: { self: { href: '/communication-hub' } } },
        },
      }, 201, { location: applicationUrl });
    }
    if (url === `${pool}/my-advertised-contacts`) {
      assert.equal(method, 'GET');
      return json({ _embedded: { contact: [{ name: 'Synthetic Colleague', uri: 'sip:colleague@example.test' }] } });
    }
    if (url === firstCursor) {
      startPolling();
      await invitationStarted;
      return json({
        _links: { next: { href: nextCursor } },
        sender: [{
          rel: 'communication',
          href: '/communication-hub',
          events: [{
            type: 'updated',
            link: { rel: 'messagingInvitation', href: '/operation-results/invitation-42' },
            _embedded: { messagingInvitation: { operationId, state: 'Connected' } },
          }],
        }],
      });
    }
    if (url === `${pool}/capabilities/receive-messages`) {
      assert.equal(method, 'POST');
      assert.equal((JSON.parse(String(init.body)) as { signInAs: string }).signInAs, 'Online');
      available = true;
      return new Response(null, { status: 204 });
    }
    if (url === `${pool}/communication-hub`) {
      assert.ok(available);
      return json({ _links: { self: { href: '/communication-hub' }, startMessaging: { href: '/custom-operations/invite-chat' } } });
    }
    if (url === `${pool}/custom-operations/invite-chat`) {
      assert.equal(method, 'POST');
      const body = JSON.parse(String(init.body)) as { operationId: string; to: string; _links: { message: { href: string } } };
      assert.equal(body.operationId, operationId);
      assert.equal(body.to, 'sip:colleague@example.test');
      assert.equal(new TextDecoder().decode(Uint8Array.from(atob(body._links.message.href.split(',')[1]!), (char) => char.charCodeAt(0))), 'Hello from the SDK');
      startInvitation();
      return new Response(null, { status: 201, headers: { location: '/operation-results/invitation-42' } });
    }
    if (url === nextCursor) {
      startSecondPoll();
      return new Promise<Response>((_resolve, reject) => {
        const signal = init.signal;
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        if (signal?.aborted) reject(signal.reason);
      });
    }
    if (url === applicationUrl && method === 'DELETE') return new Response(null, { status: 204 });
    assert.fail(`Unexpected request: ${method} ${url}`);
  };

  const skype = new SkypeForHoo({
    sipAddress: 'sip.identity@example.test',
    discoveryUrls: [discovery],
    trustedOrigins: [pool, issuer],
    auth: passwordAuth({ username: loginUsername, password }),
    fetch,
  });
  const session = await skype.connect({ userAgent: 'integration-fixture/1', endpointId: 'fixture-endpoint', culture: 'en-US' });
  const contacts = await session.contacts();
  assert.equal((contacts.data._embedded?.contact as { name: string }[])[0]?.name, 'Synthetic Colleague');
  const events = session.events();
  const pendingBatch = events.next();
  await pollingStarted;
  await session.makeAvailable({ signInAs: 'Online' });
  const invitation = await session.startMessaging({ to: 'sip:colleague@example.test', message: 'Hello from the SDK', operationId });
  assert.equal(invitation.response.status, 201);
  const batch = await pendingBatch;
  const confirmation = batch.value?.sender?.[0]?.events?.[0]?._embedded?.messagingInvitation as { operationId: string; state: string };
  assert.equal(confirmation.operationId, operationId);
  assert.equal(confirmation.state, 'Connected');

  const pendingNextBatch = events.next();
  await secondPollStarted;
  assert.equal(session.eventCursor, nextCursor);
  await session.close();
  assert.equal((await pendingNextBatch).done, true);
  assert.equal(calls.filter((call) => call.url === tokenUrl).length, 1);
  assert.equal(calls.filter((call) => call.url === nextCursor).length, 1);
  assert.equal(calls.at(-1)?.url, applicationUrl);
  assert.equal(calls.at(-1)?.method, 'DELETE');
});
