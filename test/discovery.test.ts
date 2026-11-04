import assert from 'node:assert/strict';
import test from 'node:test';
import { discover, getSipDomain, normalizeSipAddress } from '../src/discovery.js';
import { AuthenticationError, HttpError, ProtocolError, UntrustedOriginError } from '../src/errors.js';
import type { RequestOptions, Transport, UcwaResource } from '../src/types.js';

type Handler = (url: string, options?: RequestOptions) => UcwaResource | Promise<UcwaResource>;
function transport(handler: Handler): Transport {
  return {
    async request<T>(url: string, options?: RequestOptions) {
      const data = await handler(url, options);
      return { data: data as T, response: Response.json(data), url };
    },
  };
}

test('SIP addresses preserve the user name and normalize discovery domains', () => {
  assert.equal(normalizeSipAddress(' SIP:Alice@EXAMPLE.COM '), 'Alice@example.com');
  assert.equal(getSipDomain('alice@bücher.example'), 'xn--bcher-kva.example');
  for (const address of ['', 'alice', '@example.com', 'alice@', 'alice@@example.com', 'alice@example.com/path', 'alice@bad_domain.example', 'alice@example.com:443']) {
    assert.throws(() => normalizeSipAddress(address), ProtocolError);
  }
});

test('discovery tries internal DNS first and falls back to external after a network failure', async () => {
  const calls: { url: string; authenticated?: boolean }[] = [];
  const result = await discover(transport((url, options) => {
    calls.push({ url, ...(options?.authenticated !== undefined ? { authenticated: options.authenticated } : {}) });
    if (url.startsWith('https://lyncdiscoverinternal.')) throw new TypeError('DNS lookup failed');
    if (url === 'https://lyncdiscover.example.com/') return { _links: { user: { href: 'https://pool.example.net/root/user?originalDomain=example.com' } } };
    return { _links: { applications: { href: '/ucwa/oauth/v1/applications' } } };
  }), { sipAddress: 'sip:alice@example.com' });
  assert.equal(result.applicationsUrl, 'https://pool.example.net/ucwa/oauth/v1/applications');
  assert.deepEqual(calls.map((call) => call.authenticated), [false, false, true]);
  assert.equal(calls[2]!.url, 'https://pool.example.net/root/user?originalDomain=example.com');
});

test('discovery follows root and authenticated home-pool redirects without reconstructing paths', async () => {
  const calls: { url: string; authenticated: boolean | undefined }[] = [];
  const resources: Record<string, UcwaResource> = {
    'https://discover.example.com/': { _links: { redirect: { href: '/canonical' } } },
    'https://discover.example.com/canonical': { _links: { user: { href: 'https://pool.example.net/root/user' } } },
    'https://pool.example.net/root/user': { _links: { redirect: { href: 'https://home.example.net/user' } } },
    'https://home.example.net/user': { _links: { applications: { href: '/ucwa/v1/applications' } } },
  };
  const result = await discover(transport((url, options) => {
    calls.push({ url, authenticated: options?.authenticated });
    return resources[url]!;
  }), { sipAddress: 'alice@example.com', urls: ['https://discover.example.com/'] });
  assert.equal(result.rootUrl, 'https://discover.example.com/canonical');
  assert.equal(result.userUrl, 'https://home.example.net/user');
  assert.equal(result.applicationsUrl, 'https://home.example.net/ucwa/v1/applications');
  assert.deepEqual(calls.map((call) => call.authenticated), [false, false, true, true]);
});

test('embedded user resources can supply their application link', async () => {
  const result = await discover(transport(() => ({
    _links: { self: { href: '/root' } },
    _embedded: { user: { _links: { self: { href: '/root/user' }, applications: { href: '/apps' } } } },
  })), { sipAddress: 'alice@example.com', urls: ['https://discover.example.com/'] });
  assert.equal(result.rootUrl, 'https://discover.example.com/root');
  assert.equal(result.userUrl, 'https://discover.example.com/root/user');
  assert.equal(result.applicationsUrl, 'https://discover.example.com/apps');
});

test('authentication failure does not silently try another discovery server', async () => {
  let calls = 0;
  await assert.rejects(discover(transport((_url, options) => {
    calls += 1;
    if (!options?.authenticated) return { _links: { user: { href: '/user' } } };
    throw new AuthenticationError('Fixture authentication failure');
  }), { sipAddress: 'alice@example.com' }), AuthenticationError);
  assert.equal(calls, 2);
});

test('origin policy rejection is preserved instead of being hidden by fallback', async () => {
  let calls = 0;
  await assert.rejects(discover(transport(() => {
    calls += 1;
    throw new UntrustedOriginError('https://discover.example.com');
  }), { sipAddress: 'alice@example.com' }), UntrustedOriginError);
  assert.equal(calls, 1);
});

test('404 discovery failure can fall back; exhaustion reports all endpoint failures', async () => {
  const visited: string[] = [];
  await assert.rejects(discover(transport((url) => {
    visited.push(url);
    throw new HttpError(404, url, new Response(null, { status: 404 }));
  }), { sipAddress: 'alice@example.com' }), (error: unknown) => {
    assert(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    return true;
  });
  assert.equal(visited.length, 2);
});

test('redirect loops, unsafe links and exhausted hop limits fail clearly', async () => {
  const options = { sipAddress: 'alice@example.com', urls: ['https://discover.example.com/'] };
  await assert.rejects(discover(transport(() => ({ _links: { redirect: { href: '/' } } })), options), /loop/);
  await assert.rejects(discover(transport(() => ({ _links: { user: { href: 'http://pool.example.com/user' } } })), options), /HTTPS/);
  let index = 0;
  await assert.rejects(discover(transport(() => ({ _links: { redirect: { href: `/hop/${++index}` } } })), { ...options, maxHops: 2 }), /2-hop/);
});

test('discovery propagates cancellation and validates every configured URL before making requests', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const fake = transport(() => { calls += 1; return {}; });
  await assert.rejects(discover(fake, { sipAddress: 'alice@example.com', signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(discover(fake, { sipAddress: 'alice@example.com', urls: ['https://discover.example.com/', 'http://invalid.example.com/'] }), ProtocolError);
  assert.equal(calls, 0);
});
