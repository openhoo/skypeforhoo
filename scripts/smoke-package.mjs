#!/usr/bin/env node
/**
 * Real-network consumer smoke for the packed SDK. No enterprise credentials or peers are used.
 * Usage: node scripts/smoke-package.mjs [--accounts 8] [--rounds 6] [--messages 3]
 *        [--output /absolute/path/package-smoke.json]
 * Requires npm and openssl. All network listeners and SDK requests use 127.0.0.1;
 * the clean consumer uses the SDK's default Fetch and verifies a short-lived TLS certificate.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = { accounts: 8, rounds: 6, messages: 3, output: undefined };
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === '--help') {
    console.log('Usage: node scripts/smoke-package.mjs [--accounts 8] [--rounds 6] [--messages 3] [--output /absolute/path/summary.json]');
    process.exit(0);
  }
  const key = argument?.replace(/^--/, '');
  if (!['accounts', 'rounds', 'messages', 'output'].includes(key) || args[index + 1] === undefined) throw new Error(`Unknown or incomplete argument: ${argument}`);
  const value = args[++index];
  if (key === 'output') config.output = resolve(value);
  else {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1 || number > 100 || (key === 'accounts' && number > 64)) throw new Error(`${argument} must be an integer from 1 to ${key === 'accounts' ? 64 : 100}.`);
    config[key] = number;
  }
}

const started = new Date();
const temporary = await mkdtemp(join(tmpdir(), 'skypeforhoo-package-smoke-'));
const isolatedEnvironment = {
  ...process.env,
  PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
  npm_config_cache: join(temporary, 'npm-cache'),
  npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false',
  NODE_USE_ENV_PROXY: '0',
};
for (const key of ['NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete isolatedEnvironment[key];
const summary = {
  status: 'running', startedAt: started.toISOString(), node: process.version,
  configuration: { accounts: config.accounts, rounds: config.rounds, messagesPerCycle: config.messages },
  isolation: { listener: '127.0.0.1', tlsVerification: true, defaultSdkFetch: true, npmInstallOffline: true, syntheticCredentialsOnly: true },
  counts: { requests: 0, tokenRequests: 0, authenticationChallenges: 0, registrations: 0, deletedRegistrations: 0, invitations: 0, messages: 0, eventBatches: 0, eventReplays: 0, abortedPolls: 0, injectedDeleteFailures: 0 },
  httpStatusCounts: {}, routeCounts: {}, serverFailures: [],
};
const logs = [];
const sockets = new Set();
let server;
let packageFile;
let failure;

async function command(executable, arguments_, options = {}) {
  return new Promise((yes, no) => {
    const child = spawn(executable, arguments_, { cwd: options.cwd ?? root, env: options.env ?? isolatedEnvironment, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); no(new Error(`${executable} exceeded the smoke harness deadline.`)); }, 180_000);
    child.stdout.setEncoding('utf8').on('data', (value) => { stdout += value; });
    child.stderr.setEncoding('utf8').on('data', (value) => { stderr += value; });
    child.once('error', (error) => { clearTimeout(timer); no(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      logs.push({ command: [executable, ...arguments_], exitCode: code, signal, stdout, stderr });
      if (code === 0) yes({ stdout, stderr });
      else no(new Error(`${executable} exited with ${code ?? signal}.\n${stderr || stdout}`));
    });
  });
}

function send(response, status, data, headers = {}) {
  summary.httpStatusCounts[status] = (summary.httpStatusCounts[status] ?? 0) + 1;
  response.writeHead(status, data === undefined ? headers : { 'Content-Type': 'application/json', ...headers });
  response.end(data === undefined ? undefined : JSON.stringify(data));
}

async function requestBody(request) {
  let value = '';
  for await (const chunk of request) {
    value += chunk;
    if (value.length > 1_048_576) throw new Error('Unexpectedly large synthetic request body.');
  }
  return value;
}

async function consumer() {
  const assert = (await import('node:assert/strict')).default;
  const { readFile } = await import('node:fs/promises');
  const diagnostics = await import('node:diagnostics_channel');
  const { SkypeForHoo, passwordAuth, UcwaTransport, UntrustedOriginError, HttpError } = await import('skypeforhoo');
  const settings = JSON.parse(await readFile(new URL('./configuration.json', import.meta.url), 'utf8'));
  const observedOrigins = new Set();
  let networkRequests = 0;
  const observe = ({ request }) => {
    const actual = new URL(String(request.origin)).origin;
    observedOrigins.add(actual);
    networkRequests += 1;
    assert.equal(actual, settings.origin, 'Only the loopback fixture may receive network traffic.');
  };
  diagnostics.subscribe('undici:request:create', observe);
  const received = [];
  let completedCycles = 0;
  let deletionRetries = 0;
  const activeSessions = new Set();
  const deadline = AbortSignal.timeout(60_000);
  const clients = Array.from({ length: settings.accounts }, (_, account) => new SkypeForHoo({
    sipAddress: `sip-identity-${account}@smoke.invalid`,
    auth: passwordAuth({ username: `SMOKE\\user-${account}`, password: `synthetic-package-smoke-${account}` }),
    discoveryUrls: [`${settings.origin}/discover/user-${account}`],
    trustedOrigins: [settings.origin], timeoutMs: 15_000,
  }));
  const correlation = (batch) => batch.sender?.flatMap((sender) => sender.events ?? [])
    .flatMap((event) => Object.values(event._embedded ?? {})).find((event) => event?.operationId);
  async function nextEvent(iterator, expected) {
    const result = await iterator.next();
    assert.equal(result.done, false);
    const event = correlation(result.value);
    assert.equal(event?.operationId, expected, 'Server events must correlate to the exact submitted operation.');
    received.push(expected);
    return event;
  }
  try {
    const blocked = new UcwaTransport({ trustedOrigins: [settings.origin] });
    const beforeBlocked = networkRequests;
    await assert.rejects(blocked.request('https://must-never-be-contacted.invalid/'), UntrustedOriginError);
    assert.equal(networkRequests, beforeBlocked, 'An untrusted origin must be rejected before networking.');
    for (let round = 0; round < settings.rounds; round += 1) {
      await Promise.all(clients.map(async (client, account) => {
        const session = await client.connect({ userAgent: 'skypeforhoo-package-smoke/1', endpointId: `smoke-${round}-${account}`, culture: 'en-US' }, deadline);
        activeSessions.add(session);
        try {
          const contacts = await session.contacts(deadline);
          assert.equal(contacts.data._embedded.contact[0].name, 'Synthetic smoke contact');
          const search = await session.searchContacts('Grüße + 窓', { limit: 7, signal: deadline });
          assert.equal(search.data.query, 'Grüße + 窓');
          await session.setPresence('Busy', deadline);
          const presence = await session.presence(deadline);
          assert.equal(presence.data.availability, 'Busy');
          await session.reportActivity(deadline);
          const events = session.events({ signal: deadline });
          const inviteOperation = `invite-${round}-${account}`;
          const firstEvent = nextEvent(events, inviteOperation);
          await session.makeAvailable({ signInAs: 'Online' }, deadline);
          const invitation = await session.startMessaging({ to: 'sip:synthetic-peer@smoke.invalid', operationId: inviteOperation, message: `Synthetic hello 🦉 ${round}/${account}`, signal: deadline });
          assert.equal(invitation.response.status, 201);
          assert.equal((await firstEvent).state, 'Connected');
          const conversation = await session.read(new URL(invitation.response.headers.get('location'), settings.origin).href, deadline);
          for (let message = 0; message < settings.messages; message += 1) {
            const operationId = `message-${round}-${account}-${message}`;
            const event = nextEvent(events, operationId);
            await session.setTyping(conversation, deadline);
            const response = await session.sendMessage(conversation, `Synthetic message ${round}/${account}/${message} Grüße 窓 🦉`, { operationId, signal: deadline });
            assert.equal(response.response.status, 201);
            assert.equal((await event).status, 'Success');
          }
          // The control endpoint waits until the actual HTTPS long poll reaches the server.
          const pending = events.next();
          const readiness = new URL('/__smoke/poll-ready', settings.origin);
          readiness.searchParams.set('application', new URL(session.application.url).pathname.split('/').at(-1));
          readiness.searchParams.set('ack', String(settings.messages + 1));
          const ready = await fetch(readiness, { signal: deadline });
          assert.equal(ready.status, 204);
          try { await session.close(); }
          catch (error) {
            assert.ok(error instanceof HttpError && error.status === 503, 'Only the deliberately injected DELETE failure is retryable here.');
            deletionRetries += 1;
            await session.close();
          }
          assert.equal((await pending).done, true, 'Closing must abort and finish the outstanding event poll.');
          await assert.rejects(session.contacts(), /session is closed/);
          activeSessions.delete(session);
          completedCycles += 1;
        } finally {
          if (activeSessions.has(session)) {
            await session.close().catch(() => {});
            activeSessions.delete(session);
          }
        }
      }));
    }
    assert.equal(completedCycles, settings.accounts * settings.rounds);
    assert.equal(received.length, completedCycles * (settings.messages + 1));
    assert.equal(new Set(received).size, received.length);
    assert.deepEqual([...observedOrigins], [settings.origin]);
    console.log(JSON.stringify({ marker: 'SKYPEFORHOO_PACKAGE_SMOKE', node: process.version, completedCycles, correlatedEvents: received.length, deletionRetries, networkRequests, observedOrigins: [...observedOrigins], activeSessions: activeSessions.size }));
  } finally {
    await Promise.allSettled([...activeSessions].map((session) => session.close()));
    diagnostics.unsubscribe('undici:request:create', observe);
  }
}

try {
  const certFile = join(temporary, 'localhost.crt');
  const keyFile = join(temporary, 'localhost.key');
  const certConfig = join(temporary, 'localhost.cnf');
  await writeFile(certConfig, '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=extensions\n[dn]\nCN=localhost\n[extensions]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyCertSign,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=@names\n[names]\nDNS.1=localhost\nIP.1=127.0.0.1\nIP.2=::1\n');
  await command('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '1', '-config', certConfig]);
  const packed = await command('npm', ['pack', '--json', '--silent', '--cache', join(temporary, 'npm-cache'), '--pack-destination', temporary]);
  const metadata = JSON.parse(packed.stdout);
  assert.equal(metadata.length, 1);
  packageFile = join(temporary, metadata[0].filename);
  const bytes = await readFile(packageFile);
  const packagedPaths = metadata[0].files.map((entry) => entry.path);
  assert.ok(packagedPaths.every((path) => /^(?:dist\/|docs\/|README\.md$|LICENSE$|package\.json$)/.test(path)), 'The packed artifact must contain only declared distributable files.');
  assert.ok(packagedPaths.every((path) => !/(?:^|\/)(?:src|test|node_modules|\.git)(?:\/|$)|(?:^|\/)\.env(?:$|\.)/.test(path)), 'The packed artifact must exclude source/test trees, dependencies and environment files.');
  summary.package = { name: metadata[0].name, version: metadata[0].version, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), fileCount: packagedPaths.length, contentAllowlistPassed: true, files: packagedPaths };
  const consumerDirectory = join(temporary, 'consumer');
  await mkdir(consumerDirectory);
  await writeFile(join(consumerDirectory, 'package.json'), JSON.stringify({ name: 'skypeforhoo-isolated-smoke-consumer', version: '0.0.0', private: true, type: 'module' }));
  await command('npm', ['install', packageFile, '--cache', join(temporary, 'npm-cache'), '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock'], { cwd: consumerDirectory });

  const accounts = new Map(Array.from({ length: config.accounts }, (_, index) => [`user-${index}`, { index, token: undefined, tokens: 0 }]));
  const applications = new Map();
  let origin;
  function challenge(response, account) {
    summary.counts.authenticationChallenges += 1;
    send(response, 401, undefined, { 'WWW-Authenticate': `MsRtcOAuth href="${origin}/tokens/user-${account.index}", grant_type="password,urn:microsoft.rtc:windows"` });
  }
  function deliver(application_) {
    if (!application_.poll || application_.queue.length === 0) return;
    const { response, ack } = application_.poll;
    application_.poll = undefined;
    const batch = { _links: { next: { href: `/applications/${application_.id}/events?ack=${ack + 1}&checkpoint=preserve-${application_.id}` } }, sender: [{ rel: 'communication', events: application_.queue.splice(0) }] };
    application_.batches.set(ack, batch);
    summary.counts.eventBatches += 1;
    send(response, 200, batch);
  }
  function links(application_, relation) {
    const prefix = `/applications/${application_.id}`;
    if (relation === 'me') return { self: { href: `${prefix}/me` }, makeMeAvailable: { href: `${prefix}/available` }, presence: { href: `${prefix}/presence` }, reportMyActivity: { href: `${prefix}/activity` } };
    if (relation === 'people') return { self: { href: `${prefix}/people` }, myContacts: { href: `${prefix}/contacts` }, search: { href: `${prefix}/search?serverToken=preserve` } };
    return { self: { href: `${prefix}/communication` }, ...(application_.available ? { startMessaging: { href: `${prefix}/invite` } } : {}) };
  }
  async function handle(request, response) {
    assert.equal(request.socket.remoteAddress, '127.0.0.1', 'The fixture accepts only loopback clients.');
    const url = new URL(request.url, origin);
    const segments = url.pathname.split('/').filter(Boolean);
    const route = `${request.method} /${segments[0] ?? ''}/${segments[0] === 'applications' ? ':application/' + (segments[2] ?? '') : segments[0] === '__smoke' ? segments[1] : ':account'}`;
    summary.counts.requests += 1;
    summary.routeCounts[route] = (summary.routeCounts[route] ?? 0) + 1;
    assert.equal(request.headers.cookie, undefined);
    assert.equal(request.headers['proxy-authorization'], undefined);
    const body = await requestBody(request);
    if (segments[0] !== 'tokens') assert.ok(!body.includes('synthetic-package-smoke-'), 'Passwords may be submitted only to the token endpoint.');
    if (segments[0] === 'discover') {
      assert.equal(request.method, 'GET');
      assert.equal(request.headers.authorization, undefined);
      assert.ok(accounts.has(segments[1]));
      send(response, 200, { _links: { self: { href: url.href }, user: { href: `/users/${segments[1]}` } } });
      return;
    }
    if (segments[0] === 'tokens') {
      const account = accounts.get(segments[1]);
      assert.ok(account);
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.authorization, undefined);
      const parameters = new URLSearchParams(body);
      assert.equal(parameters.get('grant_type'), 'password');
      assert.equal(parameters.get('username'), `SMOKE\\user-${account.index}`);
      assert.equal(parameters.get('password'), `synthetic-package-smoke-${account.index}`);
      account.token = `synthetic-access-token-${account.index}-${++account.tokens}`;
      summary.counts.tokenRequests += 1;
      send(response, 200, { access_token: account.token, token_type: 'Bearer', expires_in: 3600 });
      return;
    }
    if (segments[0] === '__smoke' && segments[1] === 'poll-ready') {
      const application_ = applications.get(url.searchParams.get('application'));
      assert.ok(application_ && !application_.deleted);
      const ack = Number(url.searchParams.get('ack'));
      if (application_.poll?.ack === ack) send(response, 204);
      else application_.waiters.push({ ack, response });
      return;
    }
    const account = segments[0] === 'applications' ? applications.get(segments[1])?.account : accounts.get(segments[1]);
    assert.ok(account, 'Every synthetic account URL must resolve to a configured fixture account.');
    if (request.headers.authorization !== `Bearer ${account.token}` || !account.token) { challenge(response, account); return; }
    if (segments[0] === 'users') {
      send(response, 200, { _links: { self: { href: url.href }, applications: { href: `/registrations/${segments[1]}` } } });
      return;
    }
    if (segments[0] === 'registrations') {
      assert.equal(request.method, 'POST');
      const registration = JSON.parse(body);
      assert.equal(registration.userAgent, 'skypeforhoo-package-smoke/1');
      const [, round, index] = /^smoke-(\d+)-(\d+)$/.exec(registration.endpointId) ?? [];
      assert.equal(Number(index), account.index);
      const id = `application-${++summary.counts.registrations}`;
      const application_ = { id, account, round: Number(round), available: false, deleted: false, presence: 'Online', queue: [], batches: new Map(), waiters: [], forceRefresh: Number(round) % 3 === 1, failDelete: Number(round) === 0 };
      applications.set(id, application_);
      send(response, 201, { _links: { self: { href: `/applications/${id}` }, events: { href: `/applications/${id}/events?ack=0&checkpoint=preserve-${id}` }, me: { href: `/applications/${id}/me` }, people: { href: `/applications/${id}/people` }, communication: { href: `/applications/${id}/communication` } }, _embedded: Object.fromEntries(['me', 'people', 'communication'].map((relation) => [relation, { _links: links(application_, relation) }])) }, { Location: `/applications/${id}` });
      return;
    }
    const application_ = applications.get(segments[1]);
    assert.ok(application_ && !application_.deleted);
    const operation = segments[2];
    if (request.method === 'DELETE' && !operation) {
      if (application_.failDelete) {
        application_.failDelete = false;
        summary.counts.injectedDeleteFailures += 1;
        send(response, 503, { error: 'Synthetic one-shot deletion failure' });
      } else {
        application_.deleted = true;
        summary.counts.deletedRegistrations += 1;
        send(response, 204);
      }
      return;
    }
    if (['me', 'people', 'communication'].includes(operation)) { send(response, 200, { _links: links(application_, operation) }); return; }
    if (operation === 'contacts') {
      if (application_.forceRefresh) { application_.forceRefresh = false; challenge(response, account); return; }
      send(response, 200, { _embedded: { contact: [{ name: 'Synthetic smoke contact', uri: 'sip:synthetic-peer@smoke.invalid' }] } });
      return;
    }
    if (operation === 'search') {
      assert.equal(url.searchParams.get('limit'), '7');
      assert.equal(url.searchParams.get('serverToken'), 'preserve');
      send(response, 200, { query: url.searchParams.get('query'), _embedded: { contact: [] } }); return;
    }
    if (operation === 'presence') {
      if (request.method === 'POST') { application_.presence = JSON.parse(body).availability; send(response, 204); }
      else send(response, 200, { availability: application_.presence });
      return;
    }
    if (operation === 'activity' || operation === 'typing') { assert.equal(request.method, 'POST'); assert.equal(body, ''); send(response, 204); return; }
    if (operation === 'available') {
      assert.equal(JSON.parse(body).signInAs, 'Online'); application_.available = true; send(response, 204); return;
    }
    if (operation === 'invite') {
      assert.ok(application_.available);
      const invitation = JSON.parse(body);
      assert.equal(invitation.to, 'sip:synthetic-peer@smoke.invalid');
      const decoded = Buffer.from(invitation._links.message.href.split(',')[1], 'base64').toString('utf8');
      assert.equal(decoded, `Synthetic hello 🦉 ${application_.round}/${account.index}`);
      summary.counts.invitations += 1;
      application_.queue.push({ type: 'updated', _embedded: { messagingInvitation: { operationId: invitation.operationId, state: 'Connected' } } });
      send(response, 201, undefined, { Location: `/applications/${application_.id}/conversation` });
      deliver(application_); return;
    }
    if (operation === 'conversation') { send(response, 200, { _links: { self: { href: url.pathname }, messaging: { href: `/applications/${application_.id}/messaging` } } }); return; }
    if (operation === 'messaging') { send(response, 200, { _links: { self: { href: url.pathname }, sendMessage: { href: `/applications/${application_.id}/send?serverToken=preserve` }, setIsTyping: { href: `/applications/${application_.id}/typing` } } }); return; }
    if (operation === 'send') {
      assert.equal(request.method, 'POST');
      assert.equal(url.searchParams.get('serverToken'), 'preserve');
      assert.match(body, /^Synthetic message \d+\/\d+\/\d+ Grüße 窓 🦉$/u);
      assert.equal(request.headers['content-type'], 'text/plain; charset=utf-8');
      summary.counts.messages += 1;
      application_.queue.push({ type: 'updated', _embedded: { message: { operationId: url.searchParams.get('operationId'), status: 'Success' } } });
      send(response, 201); deliver(application_); return;
    }
    if (operation === 'events') {
      assert.equal(url.searchParams.get('checkpoint'), `preserve-${application_.id}`);
      const ack = Number(url.searchParams.get('ack'));
      if (application_.batches.has(ack)) { summary.counts.eventReplays += 1; send(response, 200, application_.batches.get(ack)); return; }
      assert.equal(application_.poll, undefined, 'Only one poll may be active for an application.');
      application_.poll = { response, ack };
      response.once('close', () => {
        if (!response.writableEnded) summary.counts.abortedPolls += 1;
        if (application_.poll?.response === response) application_.poll = undefined;
      });
      application_.waiters = application_.waiters.filter((waiter) => {
        if (waiter.ack !== ack) return true;
        send(waiter.response, 204); return false;
      });
      deliver(application_); return;
    }
    throw new Error(`Unexpected synthetic fixture route: ${request.method} ${url.pathname}`);
  }
  server = createServer({ key: await readFile(keyFile), cert: await readFile(certFile) }, (request, response) => {
    void handle(request, response).catch((error) => {
      summary.serverFailures.push({ method: request.method, path: new URL(request.url, origin).pathname, error: error.message });
      if (!response.headersSent) send(response, 500, { error: 'Synthetic fixture validation failed; see smoke summary.' });
      else response.destroy(error);
    });
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((yes, no) => { server.once('error', no); server.listen({ host: '127.0.0.1', port: 0 }, yes); });
  origin = `https://127.0.0.1:${server.address().port}`;
  summary.isolation.origin = origin;
  const certificateProbe = await command(process.execPath, ['--input-type=module', '-e', `try { await fetch(${JSON.stringify(origin)}); throw new Error('The untrusted certificate was unexpectedly accepted.'); } catch (error) { if (!['DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN'].includes(error.cause?.code)) throw error; console.log(JSON.stringify({rejectedUntrustedCertificate:true,code:error.cause.code})); }`], { env: { ...isolatedEnvironment, NODE_EXTRA_CA_CERTS: '' } });
  summary.tlsNegativeControl = JSON.parse(certificateProbe.stdout);
  await writeFile(join(consumerDirectory, 'configuration.json'), JSON.stringify({ origin, accounts: config.accounts, rounds: config.rounds, messages: config.messages }));
  await writeFile(join(consumerDirectory, 'consumer.mjs'), `await (${consumer.toString()})();\n`);
  const result = await command(process.execPath, [join(consumerDirectory, 'consumer.mjs')], { cwd: consumerDirectory, env: { ...isolatedEnvironment, NODE_EXTRA_CA_CERTS: certFile } });
  const consumerResult = result.stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line)).find((value) => value.marker === 'SKYPEFORHOO_PACKAGE_SMOKE');
  assert.ok(consumerResult, 'The clean consumer must report completed test evidence.');
  summary.consumer = consumerResult;
  summary.cleanup = {
    activeRegistrations: [...applications.values()].filter((application_) => !application_.deleted).length,
    pendingEventPolls: [...applications.values()].filter((application_) => application_.poll).length,
    pendingControlRequests: [...applications.values()].reduce((total, application_) => total + application_.waiters.length, 0),
  };
  const cycles = config.accounts * config.rounds;
  assert.equal(summary.serverFailures.length, 0);
  assert.equal(summary.counts.registrations, cycles);
  assert.equal(summary.counts.deletedRegistrations, cycles);
  assert.equal(summary.counts.invitations, cycles);
  assert.equal(summary.counts.messages, cycles * config.messages);
  assert.equal(summary.counts.eventBatches, cycles * (config.messages + 1));
  assert.equal(summary.counts.injectedDeleteFailures, config.accounts);
  assert.equal(consumerResult.deletionRetries, config.accounts);
  assert.equal(consumerResult.networkRequests, summary.counts.requests, 'Every observed consumer HTTP request must reach the loopback fixture.');
  assert.ok([...applications.values()].every((application_) => application_.deleted && !application_.poll && !application_.waiters.length));
  summary.status = 'passed';
} catch (error) {
  failure = error;
  summary.status = 'failed';
  summary.failure = { name: error.name, message: error.message, stack: error.stack };
} finally {
  try {
    if (server) {
      server.closeAllConnections();
      await new Promise((yes) => server.close(yes));
    }
    summary.finishedAt = new Date().toISOString();
    summary.durationMs = Date.now() - started.getTime();
    summary.isolation.openSocketsAfterClose = sockets.size;
    if (config.output) {
      await mkdir(dirname(config.output), { recursive: true });
      if (packageFile && summary.package) {
        const preservedPackage = join(dirname(config.output), `${summary.package.name}-${summary.package.version}-smoke.tgz`);
        await copyFile(packageFile, preservedPackage);
        summary.package.file = preservedPackage;
      }
      const logPath = config.output.replace(/\.json$/i, '') + '.log.json';
      await writeFile(logPath, JSON.stringify(logs, null, 2) + '\n');
      summary.commandLog = logPath;
      await writeFile(config.output, JSON.stringify(summary, null, 2) + '\n');
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
    console.log(JSON.stringify(summary, null, 2));
  }
}
if (failure) process.exitCode = 1;
