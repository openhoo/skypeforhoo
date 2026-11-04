import { ProtocolError, SkypeForHooError } from './errors.js';
import type { SkypeForBusinessMedia } from './media.js';
import type { ResourceReference } from './resources.js';
import type { UcwaEventBatch } from './types.js';

export type MediaFeature = 'audio' | 'video' | 'screenSharing' | 'remoteControl';
export type MediaEngineDirection = 'send' | 'receive';
export type ScreenCaptureSourceKind = 'desktop' | 'window';

export interface ScreenCaptureSource {
  kind: ScreenCaptureSourceKind;
  /** Opaque identifier understood by the installed backend. Omit to use its picker. */
  id?: string;
}

export interface MediaCapabilityQuery {
  feature: MediaFeature;
  /** For remoteControl, send means controlling a remote screen; receive means accepting input. */
  direction: MediaEngineDirection;
  /** Only meaningful for screenSharing/send. */
  captureSource?: ScreenCaptureSourceKind;
}

/** A supported capability. Missing capabilities are unavailable. */
export interface MediaCapability {
  feature: MediaFeature;
  direction: MediaEngineDirection;
  /** Required and nonempty for screenSharing/send; never inferred from browser capture support. */
  captureSources?: readonly ScreenCaptureSourceKind[];
}

export interface MediaEngineCapabilities {
  available: boolean;
  /** Added by the controller from the actual installed engine. */
  engineId?: string;
  capabilities: readonly MediaCapability[];
  reason?: string;
}

export interface MediaEngineContext {
  application: ResourceReference;
  signaling: SkypeForBusinessMedia;
  sipAddress?: string;
  /** Factory calls receive the account lifetime; operation calls receive their own cancellation signal. */
  signal: AbortSignal;
}

export interface MediaCapabilityContext extends MediaEngineContext {
  conversation?: ResourceReference;
}

export interface ScreenSharingRequest {
  conversation: ResourceReference;
  direction: MediaEngineDirection;
  /** Present for publishing and absent for viewing. */
  source?: ScreenCaptureSource;
}

export interface MediaEngineScreenSharing {
  readonly id: string;
  /** Settles when capture or the remote sharing session ends. Rejection reports a media failure. */
  readonly ended?: Promise<void>;
  /** Release resources after cancellation or UCWA closure. Must be idempotent and safe to retry. */
  stop(): void | Promise<void>;
}

/**
 * A real, host-provided Skype for Business media implementation.
 *
 * The backend owns protocol compatibility, account/conversation binding, permission prompts,
 * capture/rendering, negotiation, relay credentials, codecs and encrypted media transport.
 * A UCWA conversation URL or a captured browser MediaStream is not a compatible media stack.
 * Backend methods must not block the JavaScript event loop; native work should use async IPC.
 */
export interface MediaEngine {
  readonly id: string;
  /** Check installed protocol support and current account, conversation and server policy. */
  capabilities(context: MediaCapabilityContext): MediaEngineCapabilities | Promise<MediaEngineCapabilities>;
  /**
   * Observe the session's existing UCWA event batches when negotiation uses UCWA.
   * Batches may replay: handlers must be idempotent and must not wait for a future batch.
   * Independently signaled native backends may omit this hook.
   */
  handleEvents?(batch: UcwaEventBatch, context: MediaEngineContext): void | Promise<void>;
  /**
   * Resolve when the backend has established the requested media, not just accepted an HTTP request.
   * Honor context.signal and release partial acquisitions before rejecting. If startup completes
   * after cancellation, the controller immediately stops the returned session.
   */
  startScreenSharing(request: ScreenSharingRequest, context: MediaEngineContext): Promise<MediaEngineScreenSharing>;
  /** Release all native resources, safely retrying failures even after context.signal is aborted. */
  close(): void | Promise<void>;
}

/** Called lazily per account. Failed initialization can be retried; do not wait for UCWA event batches here. */
export type MediaEngineFactory = (context: MediaEngineContext) => MediaEngine | Promise<MediaEngine>;

export interface ScreenSharingControllerOptions {
  engineFactory?: MediaEngineFactory;
  context: Omit<MediaEngineContext, 'signal'>;
  signal?: AbortSignal;
  /** Bound each close/stop-all attempt. Late backend results still receive cleanup. Default: 10 seconds. */
  cleanupTimeoutMs?: number;
}

export interface StartScreenSharingOptions {
  source: ScreenCaptureSource;
  /** Cancels both startup and the running share. */
  signal?: AbortSignal;
}

export interface ReceiveScreenSharingOptions {
  /** Cancels both startup and the running viewer. */
  signal?: AbortSignal;
}

export type ScreenSharingState = 'active' | 'stopping' | 'stopped' | 'failed';

export interface ScreenSharingTermination {
  reason: 'stopped' | 'cancelled' | 'ended' | 'error';
  error?: unknown;
}

export interface ScreenSharingSession {
  readonly id: string;
  readonly conversation: ResourceReference;
  readonly direction: MediaEngineDirection;
  readonly source?: ScreenCaptureSource;
  readonly state: ScreenSharingState;
  readonly error?: unknown;
  /** Resolves after resources are released. Cleanup failures leave state=failed and may be retried. */
  readonly finished: Promise<ScreenSharingTermination>;
  /** Idempotent after success; concurrent calls share cleanup. A failed cleanup may be retried. */
  stop(): Promise<void>;
}

export class UnsupportedMediaError extends SkypeForHooError {
  override name = 'UnsupportedMediaError';

  constructor(public readonly capability: MediaCapabilityQuery, reason?: string) {
    super(`Media capability ${capability.feature}/${capability.direction}${capability.captureSource ? `/${capability.captureSource}` : ''} is unavailable.${reason ? ` ${reason}` : ''}`);
  }
}

export class MediaCleanupTimeoutError extends SkypeForHooError {
  override name = 'MediaCleanupTimeoutError';

  constructor(public readonly operation: 'close' | 'stopScreenSharing', public readonly timeoutMs: number) {
    super(`Media ${operation} did not finish within ${timeoutMs}ms. Native cleanup is still pending; retry cleanup or inspect the backend.`);
  }
}

interface Cancellation {
  signal: AbortSignal;
  abort(reason?: unknown): void;
  release(): void;
}

function cancellation(signals: readonly (AbortSignal | undefined)[]): Cancellation {
  const controller = new AbortController();
  const listeners: { signal: AbortSignal; listener: () => void }[] = [];
  const release = () => {
    for (const { signal, listener } of listeners) signal.removeEventListener('abort', listener);
  };
  const abort = (reason?: unknown) => { controller.abort(reason); release(); };
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      abort(signal.reason);
      break;
    }
    const listener = () => abort(signal.reason);
    signal.addEventListener('abort', listener, { once: true });
    listeners.push({ signal, listener });
  }
  return {
    signal: controller.signal,
    abort,
    release,
  };
}

/** Stop waiting promptly while retaining handlers for a backend that settles after cancellation. */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** The deadline bounds the caller's wait, not the lifetime of cleanup for a late native result. */
function cleanupDeadline(work: Promise<void>, timeoutMs: number, operation: 'close' | 'stopScreenSharing'): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new MediaCleanupTimeoutError(operation, timeoutMs)), timeoutMs);
    work.then(
      () => { clearTimeout(timer); resolve(); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

const features: readonly MediaFeature[] = ['audio', 'video', 'screenSharing', 'remoteControl'];

function validateQuery(query: MediaCapabilityQuery): void {
  if (!features.includes(query.feature) || !['send', 'receive'].includes(query.direction)) {
    throw new TypeError('A known media feature and send/receive direction are required.');
  }
  if (query.captureSource !== undefined && (
    query.feature !== 'screenSharing' || query.direction !== 'send' ||
    !['desktop', 'window'].includes(query.captureSource)
  )) throw new TypeError('A desktop/window capture source is only valid for screenSharing/send.');
}

function snapshotCapabilities(value: MediaEngineCapabilities, engineId: string): MediaEngineCapabilities {
  if (!value || typeof value.available !== 'boolean' || !Array.isArray(value.capabilities)) {
    throw new ProtocolError('The media backend returned invalid capabilities.');
  }
  const capabilities = value.capabilities.map((capability: MediaCapability) => {
    try { validateQuery(capability); }
    catch { throw new ProtocolError('The media backend returned an invalid feature or direction.'); }
    const sources = capability.captureSources;
    if (capability.feature === 'screenSharing' && capability.direction === 'send') {
      if (!Array.isArray(sources) || sources.length === 0 || sources.some((source) => source !== 'desktop' && source !== 'window')) {
        throw new ProtocolError('Screen publishing capabilities must list desktop/window capture sources.');
      }
    } else if (sources !== undefined) {
      throw new ProtocolError('Capture sources are only valid for screen publishing capabilities.');
    }
    return Object.freeze({
      feature: capability.feature,
      direction: capability.direction,
      ...(sources ? { captureSources: Object.freeze([...sources]) } : {}),
    });
  });
  return Object.freeze({
    available: value.available,
    engineId,
    capabilities: Object.freeze(capabilities),
    ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
  });
}

function supports(capabilities: MediaEngineCapabilities, query: MediaCapabilityQuery): boolean {
  return capabilities.available && capabilities.capabilities.some((capability) =>
    capability.feature === query.feature && capability.direction === query.direction &&
    (query.captureSource === undefined || capability.captureSources?.includes(query.captureSource)),
  );
}

class ManagedScreenSharing implements ScreenSharingSession {
  readonly id: string;
  readonly conversation: ResourceReference;
  readonly direction: MediaEngineDirection;
  readonly source?: ScreenCaptureSource;
  readonly finished: Promise<ScreenSharingTermination>;
  state: ScreenSharingState = 'active';
  error: unknown;
  private settle!: (termination: ScreenSharingTermination) => void;
  private stopping: Promise<void> | undefined;
  private termination: ScreenSharingTermination | undefined;
  private released = false;
  private readonly abort = () => { void this.stopBecause('cancelled', this.cancellation.signal.reason).catch(() => {}); };

  constructor(
    private readonly backend: MediaEngineScreenSharing,
    request: ScreenSharingRequest,
    private readonly cancellation: Cancellation,
    private readonly onRelease: () => void,
  ) {
    this.id = backend.id;
    this.conversation = request.conversation;
    this.direction = request.direction;
    if (request.source) this.source = request.source;
    this.finished = new Promise((resolve) => { this.settle = resolve; });
  }

  watch(): void {
    if (this.cancellation.signal.aborted) this.abort();
    else this.cancellation.signal.addEventListener('abort', this.abort, { once: true });
    this.backend.ended?.then(
      () => this.stopBecause('ended').catch(() => {}),
      (error: unknown) => this.stopBecause('error', error).catch(() => {}),
    );
  }

  stop(): Promise<void> { return this.stopBecause('stopped'); }

  private stopBecause(reason: ScreenSharingTermination['reason'], error?: unknown): Promise<void> {
    if (this.released) return Promise.resolve();
    if (this.stopping) return this.stopping;
    this.termination ??= { reason, ...(error === undefined ? {} : { error }) };
    if (reason === 'error') this.error = error;
    this.state = 'stopping';
    this.stopping = Promise.resolve().then(async () => {
      this.cancellation.abort(error ?? new DOMException('Screen sharing stopped.', 'AbortError'));
      await this.backend.stop();
      this.release();
    }).catch((failure: unknown) => {
      if (!this.released) this.state = 'failed';
      this.error = failure;
      this.stopping = undefined;
      throw failure;
    });
    return this.stopping;
  }

  /** A successfully closed backend has released every remaining native session. */
  release(): void {
    if (this.released) return;
    this.released = true;
    this.state = 'stopped';
    this.cancellation.signal.removeEventListener('abort', this.abort);
    this.cancellation.release();
    this.onRelease();
    const termination = this.termination ?? { reason: 'cancelled' as const };
    this.settle(this.error === undefined ? termination : { ...termination, error: this.error });
  }
}

interface PendingStart {
  work: Promise<ScreenSharingSession>;
  cancellation: Cancellation;
}

/** Account-scoped lifecycle for screen sharing implemented by an installed compatible backend. */
export class ScreenSharingController {
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly pendingStarts = new Set<PendingStart>();
  private readonly active = new Set<ManagedScreenSharing>();
  private readonly owned = new WeakSet<ScreenSharingSession>();
  private readonly reservations = new Set<string>();
  private initializing: Promise<MediaEngine | undefined> | undefined;
  private engine: MediaEngine | undefined;
  private engineClosed = false;
  private engineClosing: Promise<void> | undefined;
  private closed = false;
  private closing: Promise<void> | undefined;
  private stoppingAll: Promise<void> | undefined;
  private stopAllWork: Promise<void> | undefined;
  private readonly abortLifetime: () => void;
  private readonly cleanupTimeoutMs: number;

  constructor(private readonly options: ScreenSharingControllerOptions) {
    this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? 10_000;
    if (!Number.isInteger(this.cleanupTimeoutMs) || this.cleanupTimeoutMs < 1 || this.cleanupTimeoutMs > 2_147_483_647) {
      throw new TypeError('cleanupTimeoutMs must be an integer from 1 to 2147483647.');
    }
    this.abortLifetime = () => this.lifetime.abort(options.signal?.reason);
    if (options.signal?.aborted) this.abortLifetime();
    else options.signal?.addEventListener('abort', this.abortLifetime, { once: true });
  }

  get sessions(): readonly ScreenSharingSession[] { return [...this.active]; }

  private assertUsable(): void {
    if (this.closed) throw new ProtocolError('The screen sharing controller is closed.');
    this.lifetime.signal.throwIfAborted();
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work);
    void work.then(() => this.pending.delete(work), () => this.pending.delete(work));
    return work;
  }

  private getEngine(): Promise<MediaEngine | undefined> {
    if (!this.options.engineFactory) return Promise.resolve(undefined);
    if (this.initializing) return this.initializing;
    const work = Promise.resolve().then(() => this.options.engineFactory!({
      ...this.options.context,
      signal: this.lifetime.signal,
    })).then((engine) => {
      if (!engine || typeof engine.id !== 'string' || engine.id.length === 0 ||
        typeof engine.capabilities !== 'function' || typeof engine.startScreenSharing !== 'function' || typeof engine.close !== 'function') {
        throw new ProtocolError('The media engine factory returned an invalid backend.');
      }
      this.engine = engine;
      return engine;
    }).catch((error: unknown) => {
      if (this.initializing === work) this.initializing = undefined;
      throw error;
    });
    this.initializing = work;
    return work;
  }

  private async readCapabilities(
    engine: MediaEngine | undefined,
    conversation: ResourceReference | undefined,
    signal: AbortSignal,
  ): Promise<MediaEngineCapabilities> {
    signal.throwIfAborted();
    if (!engine) return Object.freeze({
      available: false,
      capabilities: Object.freeze([]),
      reason: 'Install and configure a compatible Skype for Business media backend.',
    });
    const value = await engine.capabilities({
      ...this.options.context,
      signal,
      ...(conversation ? { conversation } : {}),
    });
    signal.throwIfAborted();
    return snapshotCapabilities(value, engine.id);
  }

  async capabilities(conversation?: ResourceReference, signal?: AbortSignal): Promise<MediaEngineCapabilities> {
    this.assertUsable();
    const operation = cancellation([this.lifetime.signal, signal]);
    const work = this.track((async () => {
      operation.signal.throwIfAborted();
      const engine = await abortable(this.getEngine(), operation.signal);
      return this.readCapabilities(engine, conversation, operation.signal);
    })().finally(() => operation.release()));
    return abortable(work, operation.signal);
  }

  async supports(query: MediaCapabilityQuery, conversation?: ResourceReference, signal?: AbortSignal): Promise<boolean> {
    validateQuery(query);
    return supports(await this.capabilities(conversation, signal), query);
  }

  /** Forward the existing event stream without initializing an unused media backend. */
  async handleEvents(batch: UcwaEventBatch, signal?: AbortSignal): Promise<void> {
    this.assertUsable();
    const initializing = this.initializing;
    if (!this.engine && !initializing) return;
    const operation = cancellation([this.lifetime.signal, signal]);
    const work = this.track((async () => {
      operation.signal.throwIfAborted();
      const engine = this.engine ?? await abortable(initializing!, operation.signal);
      operation.signal.throwIfAborted();
      await engine?.handleEvents?.(batch, { ...this.options.context, signal: operation.signal });
      operation.signal.throwIfAborted();
    })().finally(() => operation.release()));
    return abortable(work, operation.signal);
  }

  async startScreenSharing(conversation: ResourceReference, options: StartScreenSharingOptions): Promise<ScreenSharingSession> {
    if (!options?.source || !['desktop', 'window'].includes(options.source.kind) ||
      (options.source.id !== undefined && (typeof options.source.id !== 'string' || options.source.id.length === 0))) {
      throw new TypeError('A desktop/window capture source and an optional nonempty backend source id are required.');
    }
    return this.start({ conversation, direction: 'send', source: Object.freeze({ ...options.source }) }, options.signal);
  }

  async receiveScreenSharing(conversation: ResourceReference, options: ReceiveScreenSharingOptions = {}): Promise<ScreenSharingSession> {
    return this.start({ conversation, direction: 'receive' }, options.signal);
  }

  private start(request: ScreenSharingRequest, signal?: AbortSignal): Promise<ScreenSharingSession> {
    this.assertUsable();
    if (this.stopAllWork) throw new ProtocolError('Screen sharing cleanup is in progress. Wait before starting another share.');
    if (!request.conversation || typeof request.conversation.url !== 'string' || request.conversation.url.length === 0) {
      throw new TypeError('A UCWA conversation reference is required.');
    }
    const key = `${request.direction}:${request.conversation.url}`;
    if (this.reservations.has(key)) throw new ProtocolError('A screen sharing operation in this direction already exists for this conversation.');
    const operation = cancellation([this.lifetime.signal, signal]);
    operation.signal.throwIfAborted();
    this.reservations.add(key);
    let transferred = false;
    let pending!: PendingStart;
    const work = Promise.resolve().then(async () => {
      operation.signal.throwIfAborted();
      const engine = await abortable(this.getEngine(), operation.signal);
      const query: MediaCapabilityQuery = {
        feature: 'screenSharing',
        direction: request.direction,
        ...(request.source ? { captureSource: request.source.kind } : {}),
      };
      const capabilities = await this.readCapabilities(engine, request.conversation, operation.signal);
      if (!engine || !supports(capabilities, query)) throw new UnsupportedMediaError(query, capabilities.reason);
      operation.signal.throwIfAborted();
      const backendSession = await engine.startScreenSharing(request, { ...this.options.context, signal: operation.signal });
      if (!backendSession || typeof backendSession.id !== 'string' || backendSession.id.length === 0 || typeof backendSession.stop !== 'function') {
        if (typeof backendSession?.stop === 'function') await backendSession.stop();
        throw new ProtocolError('The media backend returned an invalid screen sharing session.');
      }
      const session = new ManagedScreenSharing(backendSession, request, operation, () => {
        this.active.delete(session);
        this.reservations.delete(key);
      });
      this.active.add(session);
      this.owned.add(session);
      transferred = true;
      // A non-cooperative backend may return a new capture handle after its first close.
      // Retain that handle and arrange another actual backend cleanup after it is stopped.
      if (this.closed && this.engineClosed) this.engineClosed = false;
      session.watch();
      if (operation.signal.aborted) {
        await session.stop();
        operation.signal.throwIfAborted();
      }
      return session;
    }).catch((error: unknown) => {
      if (!transferred) operation.abort(error);
      throw error;
    }).finally(() => {
      this.pendingStarts.delete(pending);
      if (!transferred) {
        operation.release();
        this.reservations.delete(key);
      }
    });
    pending = { work, cancellation: operation };
    this.pendingStarts.add(pending);
    this.track(work);
    return abortable(work, operation.signal);
  }

  /** Stops one owned session, or cancels pending starts and stops every session on this account. */
  stopScreenSharing(session?: ScreenSharingSession): Promise<void> {
    if (session) {
      if (!this.owned.has(session)) return Promise.reject(new TypeError('The screen sharing session belongs to another controller.'));
      return session.stop();
    }
    if (this.stoppingAll) return this.stoppingAll;
    if (!this.stopAllWork) {
      const pending = [...this.pendingStarts];
      const work = Promise.resolve().then(async () => {
        for (const start of pending) start.cancellation.abort(new DOMException('Screen sharing stopped.', 'AbortError'));
        await Promise.allSettled(pending.map((start) => start.work));
        const results = await Promise.allSettled([...this.active].map((active) => active.stop()));
        const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason as unknown);
        if (failures.length) throw new AggregateError(failures, 'Screen sharing cleanup failed. Retry stopScreenSharing or close the controller.');
      });
      this.stopAllWork = work;
      const clear = () => { if (this.stopAllWork === work) this.stopAllWork = undefined; };
      void work.then(clear, clear);
    }
    this.stoppingAll = cleanupDeadline(this.stopAllWork, this.cleanupTimeoutMs, 'stopScreenSharing')
      .finally(() => { this.stoppingAll = undefined; });
    return this.stoppingAll;
  }

  private closeEngine(): Promise<void> {
    if (this.engineClosed || !this.engine) return Promise.resolve();
    if (this.engineClosing) return this.engineClosing;
    this.engineClosing = Promise.resolve().then(() => this.engine!.close()).then(() => {
      this.engineClosed = true;
      for (const session of this.active) session.release();
    }).finally(() => { this.engineClosing = undefined; });
    return this.engineClosing;
  }

  private async cleanupAccount(): Promise<void> {
    const earlyStops = [...this.active].map((session) => session.stop());
    // Closing the engine may be the only way to interrupt a stuck native startup or query.
    const closeEngine = (async () => {
      if (this.initializing) await this.initializing.catch(() => undefined);
      await this.closeEngine();
    })();
    const pending = [...this.pending];
    const results = await Promise.allSettled([...pending, ...earlyStops, closeEngine]);
    // Cancelled startup/query errors are expected. Individual stop/dispose failures are not.
    const failures = results.slice(pending.length)
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason as unknown);
    // Late startup handles may have appeared after the first engine close. Their stop can be retried.
    const lateStops = await Promise.allSettled([...this.active].map((session) => session.stop()));
    failures.push(...lateStops.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason as unknown));
    if (!this.engineClosed) {
      try { await this.closeEngine(); }
      catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Media backend cleanup failed. Call close again to retry.');
  }

  /** Cancels startup, stops all sessions and releases the account backend. Failed cleanup can be retried. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.lifetime.abort(new DOMException('The media account session closed.', 'AbortError'));
    this.options.signal?.removeEventListener('abort', this.abortLifetime);
    this.closing = cleanupDeadline(this.cleanupAccount(), this.cleanupTimeoutMs, 'close').catch((error: unknown) => {
      this.closing = undefined;
      throw error;
    });
    return this.closing;
  }
}
