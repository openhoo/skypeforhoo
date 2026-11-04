import { HttpError, MissingLinkError, ProtocolError } from './errors.js';
import { SkypeForBusinessMedia } from './media.js';
import { ScreenSharingController, type MediaEngineFactory } from './media-engine.js';
import {
  embeddedResource,
  getLink,
  hasLink,
  requireResource,
  ResourceClient,
  type ResourceReference,
} from './resources.js';
import type {
  ApplicationOptions,
  HttpResult,
  Transport,
  UcwaEventBatch,
  UcwaResource,
} from './types.js';

export type PreferredAvailability = 'Online' | 'Busy' | 'DoNotDisturb' | 'BeRightBack' | 'Away' | 'Offwork';
export type MessageFormat = 'Plain' | 'Html';

export interface MakeAvailableOptions {
  signInAs?: PreferredAvailability;
  supportedMessageFormats?: MessageFormat[];
  /** Messaging is the default. Advertise other modalities only with a compatible media backend. */
  supportedModalities?: string[];
  audioPreference?: 'PhoneAudio' | 'VoipAudio';
  phoneNumber?: string;
  inactiveTimeout?: string;
  [key: string]: unknown;
}

export interface StartMessagingOptions {
  to: string;
  operationId?: string;
  importance?: 'Normal' | 'Urgent' | 'Emergency';
  subject?: string;
  threadId?: string;
  message?: string;
  messageFormat?: MessageFormat;
  signal?: AbortSignal;
}

export interface SendMessageOptions {
  operationId?: string;
  format?: MessageFormat;
  signal?: AbortSignal;
}

export interface SearchContactsOptions {
  limit?: number;
  signal?: AbortSignal;
}

export interface EventOptions {
  signal?: AbortSignal;
}

/** Host-owned media integration; these options are never sent to the UCWA server. */
export interface UcwaSessionOptions {
  mediaEngine?: MediaEngineFactory;
  sipAddress?: string;
  /** Bound native cleanup attempts. Default: 10 seconds; unresolved cleanup remains observable. */
  mediaCleanupTimeoutMs?: number;
}

function operationId(value?: string): string {
  const id = value ?? globalThis.crypto.randomUUID();
  if (id.length === 0 || id.length > 50) throw new TypeError('operationId must contain 1 to 50 characters.');
  return id;
}

function dataUri(message: string, format: MessageFormat): string {
  const bytes = new TextEncoder().encode(message);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:${format === 'Html' ? 'text/html' : 'text/plain'};charset=utf-8;base64,${globalThis.btoa(binary)}`;
}

/** One UCWA application registration and its server-advertised capabilities. */
export class UcwaSession extends ResourceClient {
  readonly application: ResourceReference;
  readonly media: SkypeForBusinessMedia;
  readonly screenSharing: ScreenSharingController;
  private readonly lifetime = new AbortController();
  private closed = false;
  private polling = false;
  private cursor: string | undefined;
  private closing: Promise<void> | undefined;
  private readonly hubs = new Map<string, ResourceReference>();
  private useEmbeddedHubs = true;

  private constructor(transport: Transport, application: ResourceReference, options: UcwaSessionOptions = {}) {
    super(transport);
    this.application = application;
    this.media = new SkypeForBusinessMedia(this);
    this.screenSharing = new ScreenSharingController({
      ...(options.mediaEngine ? { engineFactory: options.mediaEngine } : {}),
      ...(options.mediaCleanupTimeoutMs === undefined ? {} : { cleanupTimeoutMs: options.mediaCleanupTimeoutMs }),
      context: {
        application,
        signaling: this.media,
        ...(options.sipAddress ? { sipAddress: options.sipAddress } : {}),
      },
      signal: this.lifetime.signal,
    });
    if (hasLink(application.data, 'events')) this.cursor = getLink(application.data, 'events', application.url);
  }

  static async create(
    transport: Transport,
    applicationsUrl: string,
    options: ApplicationOptions,
    signal?: AbortSignal,
    sessionOptions: UcwaSessionOptions = {},
  ): Promise<UcwaSession> {
    if (sessionOptions.mediaCleanupTimeoutMs !== undefined && (
      !Number.isInteger(sessionOptions.mediaCleanupTimeoutMs) ||
      sessionOptions.mediaCleanupTimeoutMs < 1 || sessionOptions.mediaCleanupTimeoutMs > 2_147_483_647
    )) throw new TypeError('mediaCleanupTimeoutMs must be an integer from 1 to 2147483647.');
    if (sessionOptions.mediaEngine !== undefined && typeof sessionOptions.mediaEngine !== 'function') {
      throw new TypeError('mediaEngine must be a compatible media engine factory.');
    }
    const body = {
      ...options,
      culture: options.culture ?? 'en-US',
      endpointId: options.endpointId ?? globalThis.crypto.randomUUID(),
    };
    for (const key of ['userAgent', 'culture', 'endpointId'] as const) {
      if (typeof body[key] !== 'string' || body[key].trim().length === 0 || body[key].length > 100) {
        throw new TypeError(`${key} must contain 1 to 100 characters.`);
      }
    }
    const result = await transport.request<UcwaResource>(applicationsUrl, {
      method: 'POST',
      json: body,
      ...(signal ? { signal } : {}),
    });
    const location = result.response.headers.get('location');
    let reference: ResourceReference;
    if (result.data !== undefined) {
      reference = requireResource(result);
      if (!hasLink(reference.data, 'self')) {
        if (!location) throw new ProtocolError('Application creation returned neither a self link nor a Location header.');
        reference.url = new URL(location, result.url).href;
      }
    } else {
      if (!location) throw new ProtocolError('Application creation returned neither a resource nor a Location header.');
      reference = requireResource(await transport.request<UcwaResource>(new URL(location, result.url).href, signal ? { signal } : {}));
    }
    return new UcwaSession(transport, reference, sessionOptions);
  }

  protected override assertUsable(): void {
    if (this.closed) throw new ProtocolError('The UCWA session is closed. Create a new application registration.');
  }

  /** Last unacknowledged poll URL. Restart events() to replay an interrupted batch. */
  get eventCursor(): string | undefined {
    return this.cursor;
  }

  private async hub(relation: string, signal?: AbortSignal): Promise<ResourceReference> {
    this.assertUsable();
    const cached = this.hubs.get(relation);
    if (cached) return cached;
    const embedded = embeddedResource(this.application, relation);
    const resource = this.useEmbeddedHubs && embedded
      ? embedded
      : hasLink(this.application.data, relation)
        ? await this.follow(this.application, relation, signal)
        : embedded
          ? await this.read(embedded.url, signal)
          : await this.follow(this.application, relation, signal);
    this.hubs.set(relation, resource);
    return resource;
  }

  me(signal?: AbortSignal): Promise<ResourceReference> { return this.hub('me', signal); }
  people(signal?: AbortSignal): Promise<ResourceReference> { return this.hub('people', signal); }
  communication(signal?: AbortSignal): Promise<ResourceReference> { return this.hub('communication', signal); }

  async contacts(signal?: AbortSignal): Promise<ResourceReference> {
    return this.follow(await this.people(signal), 'myContacts', signal);
  }

  async searchContacts(query: string, options: SearchContactsOptions = {}): Promise<ResourceReference> {
    if (query.length === 0 || query.length > 256) throw new TypeError('Contact search query must contain 1 to 256 characters.');
    if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100)) {
      throw new TypeError('Contact search limit must be an integer from 1 to 100.');
    }
    const people = await this.people(options.signal);
    const url = new URL(getLink(people.data, 'search', people.url));
    url.searchParams.set('query', query);
    if (options.limit !== undefined) url.searchParams.set('limit', String(options.limit));
    return this.read(url.href, options.signal);
  }

  async presence(signal?: AbortSignal): Promise<ResourceReference> {
    return this.follow(await this.me(signal), 'presence', signal);
  }

  async contactPresence(contact: ResourceReference, signal?: AbortSignal): Promise<ResourceReference> {
    return this.follow(contact, 'contactPresence', signal);
  }

  async setPresence(availability?: PreferredAvailability, signal?: AbortSignal): Promise<void> {
    const me = await this.me(signal);
    await this.invoke(me, 'presence', {
      method: 'POST',
      ...(availability === undefined ? {} : { json: { availability } }),
      ...(signal ? { signal } : {}),
    });
  }

  /** Report actual host activity; the host owns presence and idle behavior. */
  async reportActivity(signal?: AbortSignal): Promise<void> {
    await this.invoke(await this.me(signal), 'reportMyActivity', {
      method: 'POST',
      ...(signal ? { signal } : {}),
    });
  }

  /** Begin receiving invitations after starting an event consumer. */
  async makeAvailable(options: MakeAvailableOptions = {}, signal?: AbortSignal): Promise<void> {
    const me = await this.me(signal);
    await this.invoke(me, 'makeMeAvailable', {
      method: 'POST',
      json: { supportedModalities: ['Messaging'], supportedMessageFormats: ['Plain'], ...options },
      ...(signal ? { signal } : {}),
    });
    // makeMeAvailable changes advertised links on me/communication. Do not retain stale hubs.
    this.hubs.clear();
    this.useEmbeddedHubs = false;
  }

  /** Starts an asynchronous invitation. Success is reported through the event channel. */
  async startMessaging(options: StartMessagingOptions): Promise<HttpResult> {
    const { signal, message, messageFormat = 'Plain', ...fields } = options;
    if (!fields.to || fields.to.trim().length === 0) throw new TypeError('A target SIP URI is required.');
    if (fields.subject !== undefined && fields.subject.length > 250) throw new TypeError('subject cannot exceed 250 characters.');
    const communication = await this.communication(signal);
    return this.invoke(communication, 'startMessaging', {
      method: 'POST',
      json: {
        ...fields,
        operationId: operationId(fields.operationId),
        ...(message === undefined ? {} : { _links: { message: { href: dataUri(message, messageFormat) } } }),
      },
      ...(signal ? { signal } : {}),
    });
  }

  private async messaging(resource: ResourceReference, signal?: AbortSignal): Promise<ResourceReference> {
    if (hasLink(resource.data, 'sendMessage') || hasLink(resource.data, 'setIsTyping')) return resource;
    const embedded = embeddedResource(resource, 'messaging');
    return embedded ?? this.follow(resource, 'messaging', signal);
  }

  async sendMessage(resource: ResourceReference, message: string, options: SendMessageOptions = {}): Promise<HttpResult> {
    this.assertUsable();
    const messaging = await this.messaging(resource, options.signal);
    const url = new URL(getLink(messaging.data, 'sendMessage', messaging.url));
    url.searchParams.set('operationId', operationId(options.operationId));
    return this.transport.request(url.href, {
      method: 'POST',
      body: message,
      headers: { 'Content-Type': `${options.format === 'Html' ? 'text/html' : 'text/plain'}; charset=utf-8` },
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  async setTyping(resource: ResourceReference, signal?: AbortSignal): Promise<void> {
    this.assertUsable();
    await this.invoke(await this.messaging(resource, signal), 'setIsTyping', {
      method: 'POST',
      ...(signal ? { signal } : {}),
    });
  }

  /** Poll sequentially and acknowledge using the exact next link returned by the server. */
  async *events(options: EventOptions = {}): AsyncGenerator<UcwaEventBatch, void, unknown> {
    this.assertUsable();
    if (this.polling) throw new ProtocolError('Only one events() consumer may poll a UCWA session at a time.');
    if (!this.cursor) throw new MissingLinkError('events');
    this.polling = true;
    const cancellation = new AbortController();
    const signals = [this.lifetime.signal, options.signal].filter((signal): signal is AbortSignal => signal !== undefined);
    const listeners = signals.map((signal) => {
      const listener = () => cancellation.abort(signal.reason);
      if (signal.aborted) listener();
      else signal.addEventListener('abort', listener, { once: true });
      return { signal, listener };
    });
    try {
      while (this.cursor && !this.closed) {
        cancellation.signal.throwIfAborted();
        let result: HttpResult<UcwaEventBatch>;
        try {
          result = await this.transport.request<UcwaEventBatch>(this.cursor, { signal: cancellation.signal });
        } catch (error) {
          if (this.closed && cancellation.signal.aborted) return;
          throw error;
        }
        if (this.closed) return;
        if (result.data === undefined) return;
        const batch = requireResource(result).data;
        const next = hasLink(batch, 'next') ? getLink(batch, 'next', result.url) : undefined;
        try {
          await this.screenSharing.handleEvents(batch, cancellation.signal);
        } catch (error) {
          if (this.closed && cancellation.signal.aborted) return;
          throw error;
        }
        if (this.closed) return;
        yield batch;
        // Resuming the consumer commits the preceding batch. return()/break or
        // an exception in its handler leaves the old cursor available for replay.
        this.cursor = next;
      }
    } finally {
      for (const { signal, listener } of listeners) signal.removeEventListener('abort', listener);
      cancellation.abort();
      this.polling = false;
    }
  }

  /** Abort polling and delete this application. A failed DELETE may be retried by calling close again. */
  close(signal?: AbortSignal): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.lifetime.abort();
    this.closing = (async () => {
      const errors: unknown[] = [];
      // Remove the server registration even when a host media backend cannot clean up.
      const [media, registration] = await Promise.allSettled([
        Promise.resolve().then(() => this.screenSharing.close()),
        Promise.resolve().then(() => this.transport.request(this.application.url, { method: 'DELETE', ...(signal ? { signal } : {}) })),
      ]);
      if (media.status === 'rejected') errors.push(media.reason as unknown);
      if (registration.status === 'rejected') {
        const error: unknown = registration.reason;
        if (!(error instanceof HttpError && (error.status === 404 || error.status === 410))) errors.push(error);
      }
      if (errors.length > 0) {
        if (errors.length === 1) throw errors[0];
        throw new AggregateError(errors, 'Media cleanup and UCWA application deletion failed.');
      }
    })().catch((error: unknown) => {
      this.closing = undefined;
      throw error;
    });
    return this.closing;
  }
}
