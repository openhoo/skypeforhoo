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
| `makeAvailable(options)` | `me.makeMeAvailable` | POST JSON |
| `startMessaging(options)` | `communication.startMessaging` | POST JSON |
| `sendMessage(conversationOrMessaging, text)` | `messaging.sendMessage` | POST text/plain or text/html with operationId query |
| `setTyping(conversationOrMessaging)` | `messaging.setIsTyping` | POST without body |
| `events()` | Application `events`, then batch `next` | Sequential long-poll GET |
| `close()` | Application `self` | DELETE |

The SDK defaults `makeAvailable()` to the Messaging modality and Plain message
format. Call it explicitly after starting an event consumer. A server may require
an active event channel before accepting invitation operations. Audio/video,
screen sharing, conference control, file transfer and Exchange integration are
not implemented as media or product features; low-level links alone do not
provide those features.

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

`eventCursor` exposes the last unacknowledged poll URL. Request errors, including
HTTP 410, surface directly. The application can create a new `events()` consumer
to retry the same cursor after a transient failure. A 410 generally requires
recreating the application rather than repeatedly polling it. No write operation
is silently retried.

An external `AbortSignal` cancels that generator; `close()` aborts the session's
in-flight poll and then deletes the application. Concurrent `close()` calls
share one DELETE request. A 404 or 410 during DELETE means the registration is
already gone. Other DELETE failures surface and a subsequent `close()` retries.

## Verification limits

Synthetic tests cover advertised URL following, creation metadata, UTF-8 message
encoding, request methods and bodies, opaque event cursors, cancellation and
shutdown. They do not prove successful authenticated interoperability with a
particular Skype for Business deployment.

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
