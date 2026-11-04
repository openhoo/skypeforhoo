# skypeforhoo

A TypeScript SDK for **Skype for Business Server / UCWA**. It provides automatic service discovery, pluggable authentication, UCWA application sessions, contacts, presence, instant messaging, and a resumable event stream.

The SDK follows links returned by the server. It also exposes resource operations for UCWA capabilities that do not have a convenience method.

## Status

Version **0.1.0** is an initial interoperability release. Synthetic protocol tests exercise the supported flows. Public service discovery has been checked against a real deployment. **Authenticated enterprise login, message delivery, and calls have not yet been qualified against a real server.**

Supported authentication includes supplied Bearer tokens and the documented on-premises `MsRtcOAuth` password grant. Deployments that use WebTicket/WS-Trust, Windows integrated authentication, AD FS, MFA, or another identity flow need a matching `AuthProvider`. Entering a username and password in an official client does not establish which token flow its server uses.

## Install

Download the built package from the [GitHub release](https://github.com/openhoo/skypeforhoo/releases/tag/v0.1.0), or install its release asset directly:

```sh
npm install https://github.com/openhoo/skypeforhoo/releases/download/v0.1.0/skypeforhoo-0.1.0.tgz
```

The package is ESM, includes TypeScript declarations, and has **no runtime dependencies**. Node.js 22 or later is supported. Browser and desktop hosts can inject a Fetch-compatible transport; their CORS, authentication-header access, and native transport behavior need to be validated for the selected deployment.

## Connect

The **SIP address** locates the service. The **advanced login username** authenticates the account. They are independent settings.

```ts
import { SkypeForHoo, passwordAuth } from 'skypeforhoo';

const password = process.env.SFB_PASSWORD;
if (!password) throw new Error('Set SFB_PASSWORD');

const skype = new SkypeForHoo({
  sipAddress: 'person@example.com',
  auth: passwordAuth({
    username: 'EXAMPLE\\person',
    password,
  }),
  // Exact service/token origins confirmed for your deployment.
  trustedOrigins: ['https://pool.example.com', 'https://identity.example.com'],
});

const session = await skype.connect({
  userAgent: 'MyChatApp/0.1.0',
  culture: 'en-US',
});

try {
  const contacts = await session.contacts();
  console.log('Contact collection:', contacts.url);
} finally {
  await session.close();
}
```

This example reads contacts and closes. A messaging application owns the session for its entire connected lifetime: start the event consumer, call `makeAvailable()`, and then start/send messages. Keep the session open while awaiting the correlated invitation/message events. An HTTP success confirms acceptance of an operation, not delivery to the recipient.

### Use your existing identity provider

```ts
import { SkypeForHoo, bearerAuth } from 'skypeforhoo';

const skype = new SkypeForHoo({
  sipAddress: 'person@example.com',
  trustedOrigins: ['https://pool.example.com'],
  auth: bearerAuth(async ({ url, challenge, signal }) => {
    // The host application's identity broker owns token acquisition/renewal.
    return identityBroker.getToken({ resourceUrl: url, challenge, signal });
  }),
});
```

`identityBroker` represents your application's implementation. See [authentication](docs/authentication.md) for the complete provider contract and supported flows.

## API overview

| Area | Entry points |
| --- | --- |
| Discovery | `discover()`, `SkypeForHoo.discover()`, configurable discovery URLs |
| Authentication | `bearerAuth()`, `passwordAuth()`, custom `AuthProvider` |
| Sessions | `connect()`, `UcwaSession.create()`, `close()` |
| Contacts | `contacts()`, `searchContacts()`, `contactPresence()` |
| Presence | `me()`, `presence()`, `setPresence()`, `makeAvailable()` |
| Chat | `startMessaging()`, `sendMessage()`, `setTyping()` |
| Events | `events()`, `eventCursor`, cancellation and replay of unacknowledged batches |
| More capabilities | `read()`, `follow()`, `invoke()`, `hasLink()`, `getLink()`, `getLinks()` |

UCWA resource URLs and availability are account/server specific. A missing relation raises `MissingLinkError`; the SDK does not construct a guessed operation path. The [protocol guide](docs/protocol.md) describes verbs, payloads, event acknowledgement, and known limits.

### Messaging and events

Run an event consumer as a supervised application task. Await your processing inside the loop: advancing the iterator acknowledges the batch on the next poll. Breaking or throwing leaves the batch available for replay; use stable event/message identifiers to deduplicate application state.

```ts
for await (const batch of session.events({ signal: accountLifetime.signal })) {
  await accountStore.persistAndHandle(batch);
}
```

`accountLifetime` and `accountStore` belong to the host application. While that consumer is running, make the account available and initiate a conversation:

```ts
await session.makeAvailable({ signInAs: 'Online' });
const operationId = crypto.randomUUID();
await session.startMessaging({
  to: 'sip:colleague@example.com',
  message: 'Hello from skypeforhoo',
  operationId,
});
// Keep the session alive and match protocol events to operationId.
```

Register pending operations before sending so a fast event cannot outrun your correlation state. Surface failed event polling and reconnect explicitly. `session.close()` aborts the current poll and deletes its UCWA application registration.

### Access additional advertised operations

```ts
import { hasLink } from 'skypeforhoo';

const communication = await session.communication();
if (hasLink(communication.data, 'conversations')) {
  const conversations = await session.follow(communication, 'conversations');
  console.log(conversations.data);
}
```

The low-level transport preserves response status and headers, and accepts JSON, text, or binary payloads. Writes are not automatically retried after server/network failures. A single authentication challenge may replay a buffered request after credentials are obtained. Streaming request bodies are rejected.

### Public API reference catalog

`UCWA_RESOURCE_CATALOG` indexes **234 public resource reference pages and 256 declared HTTP operations**, generated from a pinned revision of Microsoft's [UCWA documentation](https://github.com/OfficeDev/skype-docs/tree/d6b0925033cc5d8e29e15fbb425fe22b9ac6a038/Skype/UCWA). `resourceDocumentation('sendMessage')` returns the matching reference and verbs. [Catalog metadata](docs/resource-catalog.json) records its source revision.

The catalog helps navigate the public protocol. It does not claim that every operation is available on a particular server, typed by a convenience method, or supported by a media engine. Numbered reference names can describe context-specific variants. The server's actual `_links` remain authoritative, including any deployment-specific extensions.

## Transport and account handling

- HTTPS and an exact trusted-origin policy apply to discovery, resources, redirects, and token issuers. A new home pool can be approved through `trustOrigin(origin)`.
- Cross-origin redirects obtain authorization for the new origin. Browser cookies and explicit `Cookie`/`Proxy-Authorization` headers are excluded.
- Tokens and credentials remain in memory within the provider. The SDK has no credential files, global logs, or persistent token store.
- The default timeout is 200 seconds to accommodate UCWA's documented 180-second event polls. Requests, authentication waits, and event consumption accept cancellation.
- Call signaling can be explored through advertised UCWA links. Audio/video codecs, media transport, conferencing interoperability, screen sharing, and telephony are separate integrations.

## Future desktop application

The planned application uses **Tauri + React + shadcn**, with separate `skypeforhoo` and Teamwire connectors. The [desktop design brief](docs/desktop-app.md) records modern chat UI references, official shadcn chat components, the connector boundary, and the distinction between Teamwire's bot SDK and a human-account connector.

## Develop

```sh
npm ci
npm run check
npm pack
```

CI runs the compiler, tests, and package check on Node.js 22 and 24. Tests use synthetic servers and credentials. They do not sign in to an enterprise account or send messages to real people.

The implementation is authored for this project using public protocol documentation and local interoperability research. Proprietary application binaries, decompiled application code, account data, and credentials are not part of this repository. Skype and Skype for Business are Microsoft trademarks; this project is independent of Microsoft.

MIT licensed.
