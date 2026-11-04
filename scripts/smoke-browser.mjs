#!/usr/bin/env node
// Browser qualification of the packed SDK against synthetic loopback HTTPS services.
// Usage: node scripts/smoke-browser.mjs <playwright-module> [output-directory]
// SKYPEFORHOO_BROWSER_CHANNEL selects an installed browser (default: chrome).
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const project = fileURLToPath(new URL('..', import.meta.url));
const modulePath = process.argv[2];
if (!modulePath) throw new Error('Pass the installed Playwright module path as the first argument.');
const output = path.resolve(process.argv[3] ?? path.join(project, 'artifacts/smoke/2026-11-04/browser'));
const temporary = await mkdtemp(path.join(os.tmpdir(), 'skypeforhoo-browser-smoke-'));
const accounts = 12;
const batchCount = 24;
const states = new Map();
const errors = [];
const methods = {};
const statuses = {};
let browser;
let service;
let origin;
let pool;
let requests = 0;
let preflights = 0;
let tokenRequests = 0;
let invitationPosts = 0;
let messagePosts = 0;
let eventBatches = 0;
let deletes = 0;
let unexpectedPasswordPosts = 0;

function json(response, status, value, headers = {}) {
  statuses[status] = (statuses[status] ?? 0) + 1;
  response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  response.end(value === undefined ? undefined : JSON.stringify(value));
}

try {
  await mkdir(output, { recursive: true });
  await exec('npm', ['pack', '--json', '--pack-destination', temporary, '--cache', path.join(temporary, 'npm-cache')], { cwd: project, maxBuffer: 4 * 1024 * 1024 });
  const tarball = path.join(temporary, (await readdir(temporary)).find((name) => name.endsWith('.tgz')));
  const packageSha256 = createHash('sha256').update(await readFile(tarball)).digest('hex');
  await exec('tar', ['-xzf', tarball, '-C', temporary]);
  const certificate = path.join(temporary, 'certificate.pem');
  const key = path.join(temporary, 'key.pem');
  await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key,
    '-out', certificate, '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1']);

  service = https.createServer({ key: await readFile(key), cert: await readFile(certificate) }, async (request, response) => {
    try {
      requests++;
      methods[request.method] = (methods[request.method] ?? 0) + 1;
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      response.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, Location');
      response.setHeader('Vary', 'Origin');
      if (request.method === 'OPTIONS') { preflights++; json(response, 204); return; }
      const url = new URL(request.url, origin);
      if (url.pathname === '/browser' || url.pathname === '/favicon.ico') {
        response.writeHead(200, { 'Content-Type': 'text/html' });
        response.end('<!doctype html><title>SkypeForHoo browser smoke</title><p>Synthetic SDK qualification</p>');
        return;
      }
      if (url.pathname === '/cors-negative-control') {
        response.removeHeader('Access-Control-Allow-Origin');
        json(response, 200, { synthetic: true });
        return;
      }
      if (url.pathname === '/password-challenge-negative-control') {
        json(response, request.headers.authorization ? 200 : 401, {}, {
          'WWW-Authenticate': `Bearer realm="MsRtcOAuth href=${pool}/unexpected-password-target,grant_type=password, ignored=value"`,
        });
        return;
      }
      if (url.pathname === '/unexpected-password-target') {
        unexpectedPasswordPosts++;
        json(response, 200, { access_token: 'synthetic-must-not-be-issued', token_type: 'Bearer', expires_in: 3600 });
        return;
      }
      if (/^\/sdk\/[a-z-]+\.js$/.test(url.pathname)) {
        response.writeHead(200, { 'Content-Type': 'text/javascript' });
        response.end(await readFile(path.join(temporary, 'package/dist', path.basename(url.pathname))));
        return;
      }
      let body = '';
      for await (const chunk of request) body += chunk;
      const account = url.searchParams.get('account');
      if (url.pathname === '/discover') {
        assert.equal(request.headers.authorization, undefined);
        json(response, 200, { _links: { user: { href: `${pool}/user?account=${account}` } } });
        return;
      }
      if (url.pathname === '/token') {
        assert.equal(request.method, 'POST');
        assert.equal(request.headers.authorization, undefined);
        const form = new URLSearchParams(body);
        assert.equal(form.get('username'), `SMOKE\\browser-${account}`);
        assert.equal(form.get('password'), 'synthetic &+=密碼');
        assert.equal(form.get('grant_type'), 'password');
        tokenRequests++;
        json(response, 200, { access_token: `browser-${account}`, token_type: 'Bearer', expires_in: 3600 });
        return;
      }
      if (url.pathname === '/user' && !request.headers.authorization) {
        json(response, 401, {}, { 'WWW-Authenticate': `MsRtcOAuth href="${pool}/token?account=${account}", grant_type="password"` });
        return;
      }
      if (url.pathname === '/user') {
        assert.equal(request.headers.authorization, `Bearer browser-${account}`);
        json(response, 200, { _links: { applications: { href: `${pool}/applications?account=${account}` } } });
        return;
      }
      if (url.pathname === '/applications') {
        assert.equal(request.method, 'POST');
        assert.equal(request.headers.authorization, `Bearer browser-${account}`);
        assert.equal(JSON.parse(body).endpointId, `browser-${account}`);
        assert.ok(!states.has(account));
        states.set(account, { available: false, invitation: undefined, message: undefined });
        const base = `/apps/${account}`;
        json(response, 201, { _links: { self: { href: base }, events: { href: `${base}/events?index=0&opaque=%2B%2F` } },
          _embedded: {
            me: { _links: { self: { href: `${base}/me` }, makeMeAvailable: { href: `${base}/available` }, presence: { href: `${base}/presence` } } },
            people: { _links: { self: { href: `${base}/people` }, myContacts: { href: `${base}/contacts` }, search: { href: `${base}/search?scope=all` } } },
            communication: { _links: { self: { href: `${base}/communication` } } },
          } }, { Location: `${pool}${base}` });
        return;
      }
      const match = /^\/apps\/(\d+)(?:\/(.*))?$/.exec(url.pathname);
      assert.ok(match, `Unexpected path: ${url.pathname}`);
      const id = match[1];
      const action = match[2];
      const state = states.get(id);
      assert.ok(state, 'The application must be registered');
      assert.equal(request.headers.authorization, `Bearer browser-${id}`);
      const base = `/apps/${id}`;
      if (!action && request.method === 'DELETE') { deletes++; states.delete(id); json(response, 204); return; }
      if (action === 'contacts') { json(response, 200, { _embedded: { contact: [{ displayName: 'Synthetic 👋', uri: `sip:browser-${id}@example.test` }] } }); return; }
      if (action === 'search') { assert.equal(url.searchParams.get('query'), 'Grüße +&?'); assert.equal(url.searchParams.get('scope'), 'all'); json(response, 200, { _embedded: { contact: [] } }); return; }
      if (action === 'presence') { json(response, request.method === 'POST' ? 204 : 200, request.method === 'POST' ? undefined : { availability: 'Online' }); return; }
      if (action === 'available') { assert.equal(request.method, 'POST'); state.available = true; json(response, 204); return; }
      if (action === 'communication') { assert.equal(state.available, true); json(response, 200, { _links: { startMessaging: { href: `${base}/invite` } } }); return; }
      if (action === 'invite') {
        const payload = JSON.parse(body);
        assert.equal(payload.to, 'sip:synthetic-peer@example.test');
        assert.equal(Buffer.from(payload._links.message.href.split(',')[1], 'base64').toString('utf8'), 'Hello مرحبا 👩🏽‍💻');
        state.invitation = payload.operationId;
        invitationPosts++;
        json(response, 201, undefined, { Location: `${base}/invitation` });
        return;
      }
      if (action === 'messaging') { json(response, 200, { _links: { sendMessage: { href: `${base}/send?opaque=%2B%2F` }, setIsTyping: { href: `${base}/typing` } } }); return; }
      if (action === 'send') {
        assert.equal(request.method, 'POST');
        assert.equal(url.searchParams.get('opaque'), '+/');
        assert.equal(body, '<b>Grüße & 👋</b>');
        assert.equal(request.headers['content-type'], 'text/html; charset=utf-8');
        state.message = url.searchParams.get('operationId');
        messagePosts++;
        json(response, 201);
        return;
      }
      if (action === 'typing') { assert.equal(request.method, 'POST'); assert.equal(body, ''); json(response, 204); return; }
      if (action === 'events') {
        const index = Number(url.searchParams.get('index'));
        assert.equal(url.searchParams.get('opaque'), '+/');
        eventBatches++;
        json(response, 200, { index,
          ...(index + 1 < batchCount ? { _links: { next: { href: `${base}/events?index=${index + 1}&opaque=%2B%2F` } } } : {}),
          sender: [{ events: [{ type: 'added', account: id, invitationId: state.invitation, messageId: state.message }] }],
        });
        return;
      }
      assert.fail(`Unexpected operation: ${request.method} ${url.pathname}`);
    } catch (error) {
      errors.push(error.stack ?? String(error));
      if (!response.headersSent) json(response, 500, { error: 'Synthetic browser fixture assertion failed' });
      else response.end();
    }
  });
  await new Promise((resolve, reject) => {
    service.once('error', reject);
    service.listen(0, '127.0.0.1', resolve);
  });
  // Both names resolve only to loopback. Distinct origins exercise actual browser CORS.
  origin = `https://127.0.0.1:${service.address().port}`;
  pool = `https://localhost:${service.address().port}`;
  const { chromium } = await import(pathToFileURL(path.resolve(modulePath)).href);
  browser = await chromium.launch({ headless: true, channel: process.env.SKYPEFORHOO_BROWSER_CHANNEL ?? 'chrome' });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const pageErrors = [];
  const externalRequests = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const observedOrigins = new Set();
  page.on('request', (request) => {
    const url = new URL(request.url());
    observedOrigins.add(url.origin);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) externalRequests.push(url.hostname);
  });
  await page.goto(`${origin}/browser`);
  const consumerResult = await page.evaluate(async ({ origin, pool, accounts, batchCount }) => {
    const sdk = await import(`${origin}/sdk/index.js`);
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    // Avoid request interception: Chromium must perform its own preflights and CORS enforcement.
    const corsNegativeControlRejected = await fetch(`${pool}/cors-negative-control`).then(() => false, () => true);
    check(corsNegativeControlRejected, 'A cross-origin response without CORS headers must be rejected');
    const probe = new sdk.UcwaTransport({
      trustedOrigins: [pool],
      auth: sdk.passwordAuth({ username: 'SMOKE\\negative-control', password: 'synthetic-negative-control' }),
      timeoutMs: 15_000,
    });
    const quotedBearerChallengeRejected = await probe.request(`${pool}/password-challenge-negative-control`)
      .then(() => false, (error) => error instanceof sdk.AuthenticationError);
    check(quotedBearerChallengeRejected, 'Quoted Bearer realm text must not trigger password authentication');
    await Promise.all(Array.from({ length: accounts }, async (_, account) => {
      const client = new sdk.SkypeForHoo({ sipAddress: `browser-${account}@example.test`,
        discoveryUrls: [`${origin}/discover?account=${account}`], trustedOrigins: [pool],
        auth: sdk.passwordAuth({ username: `SMOKE\\browser-${account}`, password: 'synthetic &+=密碼' }),
      });
      const session = await client.connect({ userAgent: 'browser-package-smoke', endpointId: `browser-${account}` });
      try {
        const [contacts, presence] = await Promise.all([session.contacts(), session.presence(), session.searchContacts('Grüße +&?')]);
        check(contacts.data._embedded.contact[0].displayName === 'Synthetic 👋', 'Contact encoding');
        check(presence.data.availability === 'Online', 'Presence response');
        await session.setPresence('Busy');
        await session.makeAvailable();
        const invitationId = `invite-${account}`;
        const messageId = `message +/& ${account}`;
        check((await session.startMessaging({ to: 'sip:synthetic-peer@example.test', message: 'Hello مرحبا 👩🏽‍💻', operationId: invitationId })).response.status === 201, 'Invitation acceptance');
        const conversation = { url: `${pool}/apps/${account}/conversation`, data: { _links: { messaging: { href: `/apps/${account}/messaging` } } } };
        await session.sendMessage(conversation, '<b>Grüße & 👋</b>', { operationId: messageId, format: 'Html' });
        await session.setTyping(conversation);
        let batches = 0;
        for await (const batch of session.events()) {
          check(batch.index === batches, 'Event ordering');
          const event = batch.sender[0].events[0];
          check(event.account === String(account), 'Account event isolation');
          check(event.invitationId === invitationId && event.messageId === messageId, 'Operation correlation');
          batches++;
        }
        check(batches === batchCount && session.eventCursor === undefined, 'Event completion');
        check(await session.screenSharing.supports({ feature: 'screenSharing', direction: 'send', captureSource: 'window' }) === false, 'Missing native backend is unavailable');
      } finally { await session.close(); }
    }));
    return { accounts, batches: accounts * batchCount, exports: Object.keys(sdk).length, corsNegativeControlRejected, quotedBearerChallengeRejected };
  }, { origin, pool, accounts, batchCount });
  assert.deepEqual(errors, []);
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(externalRequests, []);
  assert.equal(states.size, 0);
  assert.equal(deletes, accounts);
  assert.equal(tokenRequests, accounts);
  assert.equal(invitationPosts, accounts);
  assert.equal(messagePosts, accounts);
  assert.equal(eventBatches, accounts * batchCount);
  assert.equal(unexpectedPasswordPosts, 0, 'A quoted Bearer realm must never receive a password POST');
  assert.ok(preflights > 0, 'Chromium must perform real CORS preflight requests');
  assert.deepEqual([...observedOrigins].sort(), [origin, pool].sort());
  const summary = { passed: true, timestamp: new Date().toISOString(), node: process.version, browser: await browser.version(),
    packageSha256, packageVersion: JSON.parse(await readFile(path.join(temporary, 'package/package.json'), 'utf8')).version,
    ...consumerResult, requests, methods, statuses, preflights, tokenRequests, invitationPosts, messagePosts, eventBatches, deletes,
    remainingApplications: states.size, unexpectedPasswordPosts, externalRequests, pageErrors, observedOrigins: [...observedOrigins].sort(),
    qualification: 'Real Chromium fetch and CORS against synthetic local HTTPS. Test certificate errors ignored only in this browser context. No live account or native media qualification.',
  };
  await writeFile(path.join(output, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await browser?.close();
  if (service?.listening) {
    service.closeAllConnections();
    await new Promise((resolve) => service.close(resolve));
  }
  await rm(temporary, { recursive: true, force: true });
}
