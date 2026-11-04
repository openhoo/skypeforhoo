# Authentication and discovery

## Two identities

Keep the SIP sign-in address and the advanced login username separate:

```ts
const client = new SkypeForHoo({
  sipAddress: 'alice@example.com',
  auth: passwordAuth({
    username: 'EXAMPLE\\alice',
    password: obtainPasswordFromYourCredentialStore(),
  }),
  trustedOrigins: ['https://pool.example.net'],
});
```

The SIP address selects the discovery domain and identifies the Skype user. The login username authenticates to the organisation's identity service. It can be a different UPN or a `DOMAIN\\username` value. The SDK does not copy one field into the other.

`discover()` first tries the internal HTTPS discovery host and then the external one. The server's `redirect`, `user` and `applications` links locate the user's home pool. Relative links are resolved against the response URL; query strings are preserved. Discovery does not construct application paths from assumptions about the server layout. A failed internal DNS lookup or unavailable discovery service can trigger external fallback. Authentication failures, rejected origins, malformed links and loops stay visible to the caller.

Microsoft's UCWA JSON walkthrough starts at the discovery host and follows the returned `user` URL without adding a `sipuri` query. Some native Autodiscover flows include that query on the initial root request. If your deployment requires it, supply the complete initial URL in the client's `discoveryUrls` option (or `urls` when calling the standalone `discover()` function); it is preserved as provided. The SDK does not append undocumented parameters to the server's user link.

## Supported authentication providers

### Existing bearer token

Use `bearerAuth(accessToken)` when the application already has a suitable token. An async callback can acquire or renew tokens using the host application's identity integration:

```ts
const auth = bearerAuth(async (context) => {
  return identityService.getSkypeToken({
    resourceUrl: context.url,
    challenge: context.challenge,
    signal: context.signal,
  });
});
```

The SDK receives an access token without requiring an embedded browser or identity-library dependency. The callback owns token acquisition, audience selection and renewal. It should return the raw token; the SDK adds the `Bearer` prefix.

### UCWA password grant

`passwordAuth({ username, password })` supports the documented on-premises `MsRtcOAuth` challenge **when it advertises `password` in its grant types**. It reads the advertised token endpoint, sends a form-encoded password grant, and then returns a bearer token. It never guesses a token URL from a Bearer-only challenge.

An administrator-confirmed `tokenUrl` can be supplied explicitly. That URL still passes through the transport's HTTPS and trusted-origin policy before credentials are sent. Token responses are cached for each resource origin using the advertised expiration time, with a small renewal margin. Responses with no lifetime are used for the current operation and are not cached indefinitely. Concurrent acquisition is shared; cancelling one waiter does not cancel the others.

A Bearer-only challenge can belong to federated, WebTicket, WS-Trust or other identity infrastructure. A working username/password login in Microsoft's client does **not** prove that the same deployment accepts the UCWA password grant. Those identity exchanges require a custom provider; this first version does not implement Windows integrated authentication, NTLM, Kerberos, WS-Trust, AD FS, MFA or a native token broker. These flows are not claimed to work from static client analysis alone.

### Custom provider

An `AuthProvider` receives the request URL, an optional HTTP 401 challenge, cancellation and a guarded `fetch`. It returns a complete Authorization header or `undefined` when the first request should obtain a challenge. Use its guarded `fetch` for token requests: it enforces the same HTTPS and origin policy as API requests. Implement `invalidate(url)` if your provider caches credentials or tokens.

## Origin trust

The discovery domain and the home pool can be different. The home-pool origin and any identity-service origin must be explicitly configured in `trustedOrigins`, or approved by the `trustOrigin` callback. A server-provided link alone does not grant permission to send credentials to a new origin. Configure the origins confirmed by your deployment administrator; do not approve every origin automatically.

No account credentials, private tokens or extracted Microsoft application code are included in this repository. Tests use synthetic responses. Successful unit tests verify protocol handling; they are not proof of live authentication against a particular deployment.

## Protocol references

- [Microsoft: Root URL and autodiscovery](https://learn.microsoft.com/en-us/skype-sdk/ucwa/rooturl)
- [Microsoft: Authentication in UCWA](https://learn.microsoft.com/en-us/skype-sdk/ucwa/authenticationinucwa)
- [Microsoft: Create an application](https://learn.microsoft.com/en-us/skype-sdk/ucwa/createanapplication)
- [Microsoft: user resource](https://learn.microsoft.com/en-us/skype-sdk/ucwa/user_ref)
