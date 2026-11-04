import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultDiscoveryUrls, discover, normalizeSipAddress } from '../src/discovery.js';
import { AuthenticationError, HttpError, MissingLinkError, ProtocolError, UntrustedOriginError } from '../src/errors.js';
import { embeddedResource, getLink, getLinks, hasLink, requireResource } from '../src/resources.js';
import type { HttpResult, RequestOptions, Transport, UcwaResource } from '../src/types.js';

const root = 'https://discover.example.test/discovery/root';
const options = { sipAddress: 'Synthetic@example.test', urls: [root, 'https://external.example.test/'] };

function fixture(handler: (url: string, options: RequestOptions) => unknown | Promise<unknown>): Transport {
  return {
    async request<T>(url: string, request: RequestOptions = {}): Promise<HttpResult<T>> {
      return { url, data: await handler(url, request) as T, response: Response.json({}) };
    },
  };
}

test('smoke: deterministic SIP normalization corpus preserves identities and produces exact discovery origins', () => {
  const domains = ['EXAMPLE.TEST', 'bücher.example', 'xn--bcher-kva.example', 'sub-domain.example.test'];
  for (let i = 0; i < 250; i += 1) {
    const local = `Account.${i}+tag`;
    const domain = domains[i % domains.length]!;
    const expectedDomain = new URL(`https://${domain}`).hostname;
    const result = normalizeSipAddress(` SIP:${local}@${domain} `);
    assert.equal(result, `${local}@${expectedDomain}`);
    assert.equal(normalizeSipAddress(result), result);
    assert.deepEqual(defaultDiscoveryUrls(result), [
      `https://lyncdiscoverinternal.${expectedDomain}/`, `https://lyncdiscover.${expectedDomain}/`,
    ]);
  }
  for (const bad of ['x@bad..test', 'x@-bad.test', 'x@bad-.test', 'x@a_b.test', 'x@a\n.test', 'x@a.test?x=1',
    'x@a.test#fragment', 'x@a.test/path', 'x@a.test:443', 'x@@a.test', 'x\u0000@a.test', 'x@a.test\\evil']) {
    assert.throws(() => normalizeSipAddress(bad), ProtocolError, bad);
  }
});

for (const status of [404, 408, 500, 502, 503, 504]) {
  test(`smoke: unauthenticated discovery recovers from HTTP ${status} using only the next configured candidate`, async () => {
    const calls: string[] = [];
    const result = await discover(fixture((url) => {
      calls.push(url);
      if (url === root) throw new HttpError(status, url, new Response(null, { status }));
      return { _links: { applications: { href: '/advertised-apps?opaque=%2F' } } };
    }), options);
    assert.deepEqual(calls, options.urls);
    assert.equal(result.applicationsUrl, 'https://external.example.test/advertised-apps?opaque=%2F');
  });
}

for (const status of [400, 401, 403, 409, 429]) {
  test(`smoke: discovery preserves HTTP ${status} and does not hide it through failover`, async () => {
    let requests = 0;
    const expected = new HttpError(status, root, new Response(null, { status }));
    await assert.rejects(discover(fixture(() => { requests += 1; throw expected; }), options), (error) => error === expected);
    assert.equal(requests, 1);
  });
}

test('smoke: authentication and trust failures cannot send discovery to another endpoint', async () => {
  for (const expected of [new AuthenticationError('Synthetic denied'), new UntrustedOriginError('https://other.example.test')]) {
    let requests = 0;
    await assert.rejects(discover(fixture(() => { requests += 1; throw expected; }), options), (error) => error === expected);
    assert.equal(requests, 1);
  }
});

test('smoke: authenticated discovery never fails over after an account resource fails', async () => {
  for (const status of [404, 408, 500, 503]) {
    const calls: string[] = [];
    const expected = new HttpError(status, root, new Response(null, { status }));
    await assert.rejects(discover(fixture((url) => {
      calls.push(url);
      if (url === root) return { _links: { user: { href: '/account' } } };
      throw expected;
    }), options), (error) => error === expected);
    assert.deepEqual(calls, [root, 'https://discover.example.test/account']);
  }
});

test('smoke: discovery cancellation during failed internal resolution cannot begin external discovery', async () => {
  const cancel = new AbortController();
  const expected = new Error('synthetic account cancelled');
  let requests = 0;
  await assert.rejects(discover(fixture(() => {
    requests += 1;
    cancel.abort(expected);
    throw new TypeError('Synthetic DNS failure');
  }), { ...options, signal: cancel.signal }), (error) => error === expected);
  assert.equal(requests, 1);
});

test('smoke: hostile discovery hrefs fail before a second network request', async () => {
  for (const relation of ['redirect', 'user', 'applications', 'self']) {
    for (const href of ['http://pool.example.test/', 'file:///tmp/account', 'javascript:alert(1)',
      'https://user:password@pool.example.test/', 'https://pool.example.test/#fragment']) {
      let requests = 0;
      await assert.rejects(discover(fixture(() => {
        requests += 1;
        return { _links: { ...(relation === 'self' ? { applications: { href: '/apps' } } : {}), [relation]: { href } } };
      }), options), ProtocolError, `${relation}: ${href}`);
      assert.equal(requests, 1);
    }
  }
});

test('smoke: 40 concurrent discoveries retain separate redirect state and opaque application parameters', async () => {
  await Promise.all(Array.from({ length: 40 }, async (_, i) => {
    const entry = `https://discover.example.test/${i}/root`;
    const calls: string[] = [];
    const result = await discover(fixture(async (url, request) => {
      calls.push(url);
      await Promise.resolve();
      if (url === entry) {
        assert.equal(request.authenticated, false);
        return { _links: { user: { href: `../user?account=${i}&token=%2F%2B` } } };
      }
      assert.equal(request.authenticated, true);
      return { _links: { applications: { href: `https://pool.example.test/${i}/apps?opaque=%2B%2F` } } };
    }), { sipAddress: `account${i}@example.test`, urls: [entry] });
    assert.deepEqual(calls, [entry, `https://discover.example.test/user?account=${i}&token=%2F%2B`]);
    assert.equal(result.applicationsUrl, `https://pool.example.test/${i}/apps?opaque=%2B%2F`);
  }));
});

test('smoke: embedded resource helpers preserve each resource scope and reject ambiguous or malformed links', () => {
  const parent = {
    url: 'https://pool.example.test/applications/one',
    data: { _embedded: { people: { _links: { self: { href: '/directory/account/' }, search: { href: 'search?keep=%2F' } } } } },
  };
  const people = embeddedResource(parent, 'people')!;
  assert.equal(people.url, 'https://pool.example.test/directory/account/');
  assert.equal(getLink(people.data, 'search', people.url), 'https://pool.example.test/directory/account/search?keep=%2F');
  const list = { _links: { rel: [{ href: '/one' }, { href: '/two' }] } };
  assert.deepEqual(getLinks(list, 'rel', parent.url), ['https://pool.example.test/one', 'https://pool.example.test/two']);
  assert.throws(() => getLink(list, 'rel', parent.url), ProtocolError);
  assert.throws(() => getLinks({ _links: { rel: [] } }, 'rel', parent.url), MissingLinkError);
  assert.equal(hasLink({ _links: { rel: [] } }, 'rel'), false);
  assert.throws(() => embeddedResource({ ...parent, data: { _embedded: { people: [] } } }, 'people'), ProtocolError);
  for (const data of [undefined, null, 'text', 7, []]) {
    assert.throws(() => requireResource({ data: data as unknown as UcwaResource, url: parent.url, response: Response.json({}) }), ProtocolError);
  }
});

test('smoke: embedded discovery metadata preserves self while hrefs resolve against the response URL', async () => {
  const result = await discover(fixture(() => ({
    _embedded: { user: { _links: {
      self: { href: 'https://pool.example.test/root/user' },
      applications: { href: 'applications?account=one' },
    } } },
  })), { sipAddress: 'one@example.test', urls: [root] });
  assert.equal(result.userUrl, 'https://pool.example.test/root/user');
  // Discovery's documented base is the response URL, including for embedded data.
  assert.equal(result.applicationsUrl, 'https://discover.example.test/discovery/applications?account=one');
});
