import assert from 'node:assert/strict';
import test from 'node:test';
import { passwordAuth } from '../src/auth.js';
import { AuthenticationError } from '../src/errors.js';
import type { AuthContext, Fetch } from '../src/types.js';

const pool = 'https://pool.auth-regression.example';
const token = (value: string) => Response.json({ access_token: value, token_type: 'Bearer', expires_in: 3600 });
const context = (fetch: Fetch, challenge?: string, signal?: AbortSignal): AuthContext => ({
  url: `${pool}/user`, fetch, ...(challenge === undefined ? {} : { challenge }), ...(signal ? { signal } : {}),
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

test('password challenge parser rejects quoted and substring scheme decoys without sending credentials', async (t) => {
  const decoys = [
    'Bearer realm="MsRtcOAuth href=/decoy,grant_type=password, ignored=value"',
    'Digest realm="a, MsRtcOAuth href=/decoy,grant_type=password, ignored=value",nonce="synthetic"',
    'Bearer error_description="escaped \\" quote, MsRtcOAuth href=/decoy,grant_type=password, ignored=value"',
    'X-MsRtcOAuth href="/decoy",grant_type="password"',
    'MsRtcOAuthV2 href="/decoy",grant_type="password"',
    'Bearer realm=MsRtcOAuth href=/decoy,grant_type=password',
    'Bearer realm="unterminated, MsRtcOAuth href=/decoy,grant_type=password',
  ];
  for (const challenge of decoys) {
    await t.test(challenge, async () => {
      let requests = 0;
      const provider = passwordAuth({ username: 'alice', password: 'synthetic' });
      const fetch: Fetch = async () => { requests++; return token('unexpected'); };
      await assert.rejects(provider.getAuthorization(context(fetch, challenge)), AuthenticationError);
      assert.equal(requests, 0);
    });
  }
});

test('password challenge parser finds a genuine scheme after quoted escaped decoys and preserves quoted commas', async () => {
  const urls: string[] = [];
  const fetch: Fetch = async (input) => { urls.push(String(input)); return token('real'); };
  const provider = passwordAuth({ username: 'alice', password: 'synthetic' });
  const challenge = 'Digest realm="escaped \\" quote, MsRtcOAuth href=/decoy,grant_type=password, ignored=value",nonce="n", Negotiate, '
    + 'mSrTcOaUtH href="/real-token?resources=a,b",grant_type="urn:microsoft.rtc:windows,password", '
    + 'Bearer href="/other-scheme",grant_type="password"';
  assert.equal(await provider.getAuthorization(context(fetch, challenge)), 'Bearer real');
  assert.deepEqual(urls, [`${pool}/real-token?resources=a,b`]);
});

test('password challenge parser accepts optional whitespace around parameter equals signs', async (t) => {
  const challenges = [
    { header: 'MsRtcOAuth href = "/token", grant_type = "password"', endpoint: '/token' },
    { header: 'MsRtcOAuth\thref\t=\t"/tab-token",\tgrant_type\t=\t"windows,password"', endpoint: '/tab-token' },
    {
      header: 'Digest realm = "MsRtcOAuth href=/decoy,grant_type=password, ignored=value", nonce = "n", '
        + 'MsRtcOAuth href = "/real-token?resources=a,b", grant_type = "password", '
        + 'Bearer href = "/other-scheme", grant_type = "windows"',
      endpoint: '/real-token?resources=a,b',
    },
  ];
  for (const { header, endpoint } of challenges) {
    await t.test(header, async () => {
      const urls: string[] = [];
      const fetch: Fetch = async (input) => { urls.push(String(input)); return token('real'); };
      const provider = passwordAuth({ username: 'alice', password: 'synthetic' });
      assert.equal(await provider.getAuthorization(context(fetch, header)), 'Bearer real');
      assert.deepEqual(urls, [`${pool}${endpoint}`]);
    });
  }
});

test('password challenge parser does not borrow endpoint or grant parameters from a neighboring scheme', async (t) => {
  for (const challenge of [
    'MsRtcOAuth realm="missing endpoint and grant", Bearer href="/decoy",grant_type="password"',
    'MsRtcOAuth href="/real",grant_type="urn:microsoft.rtc:windows", Bearer grant_type="password"',
    'MsRtcOAuth href="/real", Bearer realm="other",grant_type="password"',
    'MsRtcOAuth href = "/real", Bearer realm = "other", grant_type = "password"',
  ]) {
    await t.test(challenge, async () => {
      let requests = 0;
      const fetch: Fetch = async () => { requests++; return token('unexpected'); };
      const provider = passwordAuth({ username: 'alice', password: 'synthetic' });
      await assert.rejects(provider.getAuthorization(context(fetch, challenge)), AuthenticationError);
      assert.equal(requests, 0);
    });
  }
});

test('password challenge parser rejects ambiguous duplicate endpoint or grant parameters', async (t) => {
  for (const challenge of [
    'MsRtcOAuth href="/first",href="/second",grant_type="password"',
    'MsRtcOAuth href="/token",grant_type="windows",GRANT_TYPE="password"',
  ]) {
    await t.test(challenge, async () => {
      let requests = 0;
      const fetch: Fetch = async () => { requests++; return token('unexpected'); };
      const provider = passwordAuth({ username: 'alice', password: 'synthetic' });
      await assert.rejects(provider.getAuthorization(context(fetch, challenge)), AuthenticationError);
      assert.equal(requests, 0);
    });
  }
});

test('a cancelled acquisition returning late without a replacement cannot populate the token cache', async () => {
  const result = deferred<Response>();
  const started = deferred<void>();
  const aborted = new AbortController();
  let requests = 0;
  const fetch: Fetch = async () => { requests++; started.resolve(); return result.promise; };
  const provider = passwordAuth({ username: 'alice', password: 'synthetic' });
  const pending = provider.getAuthorization(context(fetch, 'MsRtcOAuth href="/token",grant_type="password"', aborted.signal));
  const rejection = assert.rejects(pending, { name: 'AbortError' });
  await started.promise;
  aborted.abort();
  await rejection;
  result.resolve(token('cancelled-late'));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(await provider.getAuthorization(context(fetch)), undefined);
  assert.equal(requests, 1);
});

test('an endpoint-superseded acquisition may finish its waiter without replacing the current cached token', async () => {
  const old = deferred<Response>();
  const current = deferred<Response>();
  const urls: string[] = [];
  const fetch: Fetch = async (input) => {
    urls.push(String(input));
    return String(input).endsWith('/old-token') ? old.promise : current.promise;
  };
  const provider = passwordAuth({ username: 'alice', password: 'synthetic' });
  const first = provider.getAuthorization(context(fetch, 'MsRtcOAuth href="/old-token",grant_type="password"'));
  const second = provider.getAuthorization(context(fetch, 'MsRtcOAuth href="/current-token",grant_type="password"'));
  current.resolve(token('current'));
  assert.equal(await second, 'Bearer current');
  old.resolve(token('superseded'));
  assert.equal(await first, 'Bearer superseded');
  assert.equal(await provider.getAuthorization(context(fetch)), 'Bearer current');
  assert.deepEqual(urls, [`${pool}/old-token`, `${pool}/current-token`]);
});
