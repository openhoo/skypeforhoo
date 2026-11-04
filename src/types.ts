/** Browser-compatible fetch implementation; inject it for native or test transports. */
export type Fetch = typeof globalThis.fetch;

export interface UcwaLink {
  href: string;
  [key: string]: unknown;
}

/** UCWA uses links supplied by the server instead of fixed resource paths. */
export interface UcwaResource {
  _links?: Record<string, UcwaLink | UcwaLink[] | undefined>;
  _embedded?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface HttpResult<T = UcwaResource> {
  data: T | undefined;
  response: Response;
  url: string;
}

export interface RequestOptions {
  method?: string;
  headers?: RequestInit['headers'];
  json?: unknown;
  body?: NonNullable<RequestInit['body']>;
  signal?: AbortSignal;
  /** Discovery requests omit credentials. The default is true. */
  authenticated?: boolean;
}

export interface AuthContext {
  url: string;
  /** Present only after an HTTP 401 response. */
  challenge?: string;
  response?: Response;
  signal?: AbortSignal;
  /** Fetch that enforces the transport's HTTPS and trusted origin policy. */
  fetch: Fetch;
}

export interface AuthProvider {
  getAuthorization(context: AuthContext): Promise<string | undefined>;
  invalidate?(url: string): void;
}

export interface TransportOptions {
  fetch?: Fetch;
  auth?: AuthProvider;
  /** Exact HTTPS origins allowed to receive requests, credentials and tokens. */
  trustedOrigins: readonly string[];
  /** Called before contacting a new origin; useful after discovery returns a home pool. */
  trustOrigin?: (origin: string) => boolean | Promise<boolean>;
  timeoutMs?: number;
  maxRedirects?: number;
}

/** Minimal contract used by discovery and UCWA services. */
export interface Transport {
  request<T = UcwaResource>(url: string, options?: RequestOptions): Promise<HttpResult<T>>;
}

export interface ApplicationOptions {
  userAgent: string;
  endpointId?: string;
  culture?: string;
  /** Newer servers can expose additional application capabilities. */
  [key: string]: unknown;
}

export interface DiscoveryOptions {
  sipAddress: string;
  /** Defaults to internal discovery, then external discovery. */
  urls?: readonly string[];
  signal?: AbortSignal;
  maxHops?: number;
}

export interface DiscoveryResult {
  rootUrl: string;
  userUrl: string;
  applicationsUrl: string;
  user: UcwaResource;
}

export interface UcwaEvent {
  link?: UcwaLink;
  type?: string;
  status?: string;
  reason?: string;
  _embedded?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface UcwaEventSender {
  rel?: string;
  href?: string;
  events?: UcwaEvent[];
  [key: string]: unknown;
}

export interface UcwaEventBatch extends UcwaResource {
  sender?: UcwaEventSender[];
}
