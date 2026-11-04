# UCWA protocol support

skypeforhoo creates one UCWA application registration for each `UcwaSession`.
Applications are stateful server resources: creating one can affect a user's
presence and delivery of incoming communications. `close()` deletes the
registration and aborts its event poll.

## Resource model

A `ResourceReference` contains `data` and the resource `url`. The SDK resolves
relative `_links` against that URL. All convenience methods follow advertised
relations; pool names, application IDs, conversation IDs and operation paths are
never synthesized. An absent relation raises `MissingLinkError`.

`read()`, `follow()` and `invoke()` expose the remaining UCWA resource surface.
They preserve raw response metadata, so an application can read a `Location`
header or server diagnostics. `invoke()` accepts JSON or an unmodified binary
body using the underlying transport.

## Implemented operations

| Method | Advertised relation | HTTP operation |
| --- | --- | --- |
| `UcwaSession.create()` | Autodiscovery `applications` URL | POST JSON |
| `me()`, `people()`, `communication()` | Application hubs | Embedded data or GET |
| `contacts()` | `people.myContacts` | GET |
| `searchContacts(query, { limit })` | `people.search` | GET with query parameters |
| `presence()` | `me.presence` | GET |
| `contactPresence(contact)` | `contact.contactPresence` | GET |
| `setPresence(availability)` | `me.presence` | POST JSON; empty body resets |
| `reportActivity()` | `me.reportMyActivity` | POST without body |
| `makeAvailable(options)` | `me.makeMeAvailable` | POST JSON |
| `startMessaging(options)` | `communication.startMessaging` | POST JSON |
| `sendMessage(conversationOrMessaging, text)` | `messaging.sendMessage` | POST text/plain or text/html with operationId query |
| `setTyping(conversationOrMessaging)` | `messaging.setIsTyping` | POST without body |
| `events()` | Application `events`, then batch `next` | Sequential long-poll GET |
| `close()` | Application `self` | DELETE |

The SDK defaults `makeAvailable()` to the Messaging modality and Plain message
format. Call it explicitly after starting an event consumer. A server may require
an active event channel before accepting invitation operations. Advertise media
modalities only when the host has a compatible backend and the deployment permits
them. `reportActivity()` is available for actual user activity; the SDK does not
automatically keep an inactive account online.

`session.media` adds typed call signaling: start/add/stop audio or video, invitation
answers and cancellation, participant mute controls, negotiation resources,
sharing state, media policies, and relay credentials. Conditional native sharing
extensions expose start/add/stop application sharing through exact advertised
links. Their evidence and deployment limitations are documented in the
[media guide](media.md). A supplied media engine implements capture, rendering,
codecs, encryption and frame transport. This release does not bundle that engine.

`session.screenSharing` checks the configured backend's account/conversation
capabilities and manages sending a desktop/window or receiving a shared screen.
Capabilities distinguish each direction and capture source. Absent support
raises `UnsupportedMediaError`; successful signaling alone does not enable a
media capability. Conference administration, file transfer and Exchange
integration remain accessible through low-level resources where advertised;
they are not complete product features in this release.

## Asynchronous messaging

`startMessaging()` returns the invitation operation's HTTP result. Its initial
message is encoded as a UTF-8 data URI in `_links.message`. It does not return a
ready conversation. Consume event batches, correlate `operationId`, and fetch
linked resources when an event does not embed its representation.

Once a conversation advertises `messaging.sendMessage`, pass its
`ResourceReference` to `sendMessage()`. HTTP 201 means the message operation was
created; delivery and failures arrive through the event channel. The SDK does
not equate an HTTP success response with recipient delivery or a read receipt.

## Event cursor and shutdown

One async generator polls one session at a time. Each batch is yielded with its
complete `sender` array and events. The next request uses the exact `_links.next`
URL, including its opaque acknowledgment parameters. The SDK does not increment
acknowledgment IDs or reorder events. A batch without a next link ends the stream.

The cursor advances only when the consumer resumes the generator after handling
a batch. Breaking the loop or throwing in a handler keeps that batch's previous
cursor, so a new consumer can replay it. This provides an at-least-once boundary;
applications should deduplicate message IDs and operations.

If a media engine has already been initialized, its optional `handleEvents` hook
runs before the batch is yielded. A failed hook preserves the same cursor for
replay. Engine handlers must be idempotent and must not wait for a future batch.
Ordinary messaging events do not initialize an unused media engine. Hosts using
`session.events()` should not forward the same batch to the controller again.

`eventCursor` exposes the last unacknowledged poll URL. Request errors, including
HTTP 410, surface directly. The application can create a new `events()` consumer
to retry the same cursor after a transient failure. A 410 generally requires
recreating the application rather than repeatedly polling it. No write operation
is silently retried.

An external `AbortSignal` cancels that generator. `close()` aborts the session's
in-flight poll and media work, then starts native cleanup and application
deletion concurrently. Concurrent `close()` calls share the same attempt. A 404
or 410 during DELETE means the registration is already gone. Other DELETE or
native cleanup failures surface and a subsequent `close()` retries.

Native cleanup has a ten-second default deadline, configurable through
`mediaCleanupTimeoutMs`. `MediaCleanupTimeoutError` reports unresolved work; it
does not prove that capture or native resources have stopped. Late results still
receive cleanup. The host can inspect managed shares and retry shutdown. The
application's DELETE is sent independently of a stalled native backend.

## Verification limits

Synthetic tests cover advertised URL following, creation metadata, UTF-8 message
and SDP encoding, request methods and bodies, opaque event cursors, backend
event forwarding, capabilities, cancellation, late media results, cleanup
deadlines and shutdown. They do not prove successful authenticated
interoperability or media transmission with a particular Skype for Business
deployment. macOS and Windows are the first native backend targets.

## Primary references

- [Applications](https://learn.microsoft.com/en-us/skype-sdk/ucwa/applications_ref)
- [Application](https://learn.microsoft.com/en-us/skype-sdk/ucwa/application_ref)
- [Make available](https://learn.microsoft.com/en-us/skype-sdk/ucwa/makemeavailable_ref)
- [Presence](https://learn.microsoft.com/en-us/skype-sdk/ucwa/presence_ref)
- [Search](https://learn.microsoft.com/en-us/skype-sdk/ucwa/search_ref)
- [Start messaging](https://learn.microsoft.com/en-us/skype-sdk/ucwa/startmessaging_ref)
- [Send message](https://learn.microsoft.com/en-us/skype-sdk/ucwa/sendmessage_ref)
- [Typing](https://learn.microsoft.com/en-us/skype-sdk/ucwa/setistyping_ref)
- [Events](https://learn.microsoft.com/en-us/skype-sdk/ucwa/events_ref)
