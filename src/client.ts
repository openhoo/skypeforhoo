import { defaultDiscoveryUrls, discover, normalizeSipAddress } from './discovery.js';
import { UcwaSession } from './session.js';
import type { MediaEngineFactory } from './media-engine.js';
import { httpsUrl, UcwaTransport } from './transport.js';
import type { ApplicationOptions, AuthProvider, DiscoveryResult, Fetch, TransportOptions } from './types.js';

export interface SkypeForHooOptions {
  sipAddress: string;
  auth: AuthProvider;
  fetch?: Fetch;
  /** Override discovery for deployments with manually configured servers. */
  discoveryUrls?: readonly string[];
  /** Additional home pool or token issuer origins discovered in your deployment. */
  trustedOrigins?: readonly string[];
  trustOrigin?: TransportOptions['trustOrigin'];
  timeoutMs?: number;
  /** Construct one compatible native/host media backend per connected session. */
  mediaEngine?: MediaEngineFactory;
  /** Bound each native cleanup attempt. Default: 10 seconds. */
  mediaCleanupTimeoutMs?: number;
}

/** One account configuration. Connect returns an independently owned UCWA session. */
export class SkypeForHoo {
  readonly transport: UcwaTransport;
  readonly #options: SkypeForHooOptions;

  constructor(options: SkypeForHooOptions) {
    this.#options = { ...options, sipAddress: normalizeSipAddress(options.sipAddress) };
    const discoveryUrls = options.discoveryUrls ?? defaultDiscoveryUrls(options.sipAddress);
    this.transport = new UcwaTransport({
      auth: options.auth,
      trustedOrigins: [...discoveryUrls.map((url) => httpsUrl(url).origin), ...(options.trustedOrigins ?? [])],
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.trustOrigin ? { trustOrigin: options.trustOrigin } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
  }

  discover(signal?: AbortSignal): Promise<DiscoveryResult> {
    return discover(this.transport, {
      sipAddress: this.#options.sipAddress,
      ...(this.#options.discoveryUrls ? { urls: this.#options.discoveryUrls } : {}),
      ...(signal ? { signal } : {}),
    });
  }

  async connect(application: ApplicationOptions = { userAgent: 'skypeforhoo/0.2.0' }, signal?: AbortSignal): Promise<UcwaSession> {
    const discovery = await this.discover(signal);
    return UcwaSession.create(this.transport, discovery.applicationsUrl, application, signal, {
      sipAddress: this.#options.sipAddress,
      ...(this.#options.mediaEngine ? { mediaEngine: this.#options.mediaEngine } : {}),
      ...(this.#options.mediaCleanupTimeoutMs === undefined ? {} : { mediaCleanupTimeoutMs: this.#options.mediaCleanupTimeoutMs }),
    });
  }
}
