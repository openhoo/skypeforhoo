import { HttpError, ProtocolError } from './errors.js';
import type { DiscoveryOptions, DiscoveryResult, Transport, UcwaLink, UcwaResource } from './types.js';

/** Remove an optional sip: prefix and normalize the sign-in domain. */
export function normalizeSipAddress(address: string): string {
  const value = address.trim().replace(/^sip:/i, '');
  const split = value.lastIndexOf('@');
  if (split < 1 || value.indexOf('@') !== split || /[\s\u0000-\u001f\u007f<>/?#\\:\[\]]/.test(value)) {
    throw new ProtocolError('A SIP sign-in address must have the form user@example.com.');
  }
  const local = value.slice(0, split);
  let domain: string;
  try {
    domain = new URL(`https://${value.slice(split + 1)}`).hostname.toLowerCase();
  } catch {
    throw new ProtocolError('The SIP sign-in domain is invalid.');
  }
  if (!domain || !domain.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new ProtocolError('The SIP sign-in domain is invalid.');
  }
  return `${local}@${domain}`;
}

export function getSipDomain(address: string): string {
  return normalizeSipAddress(address).split('@')[1]!;
}

export function defaultDiscoveryUrls(address: string): string[] {
  const domain = getSipDomain(address);
  return [`https://lyncdiscoverinternal.${domain}/`, `https://lyncdiscover.${domain}/`];
}

/**
 * Locate the user's home pool. HAL redirects and user/application links are
 * resolved from each response URL; the transport controls which origins to trust.
 */
export async function discover(transport: Transport, options: DiscoveryOptions): Promise<DiscoveryResult> {
  normalizeSipAddress(options.sipAddress);
  const candidates = options.urls ?? defaultDiscoveryUrls(options.sipAddress);
  const maxHops = options.maxHops ?? 10;
  if (!candidates.length || !Number.isInteger(maxHops) || maxHops < 1) {
    throw new ProtocolError('Discovery requires at least one URL and a positive integer maxHops.');
  }
  // Validate all caller-supplied candidates before performing network requests.
  const urls = candidates.map((url) => discoveryUrl(url));
  const failures: unknown[] = [];
  for (const candidate of urls) {
    options.signal?.throwIfAborted();
    let authenticated = false;
    let current = candidate;
    let rootUrl = candidate;
    let userUrl = candidate;
    const visited = new Set<string>();
    try {
      for (let hop = 0; hop < maxHops; hop += 1) {
        options.signal?.throwIfAborted();
        const visit = `${authenticated ? 'user' : 'root'} ${current}`;
        if (visited.has(visit)) throw new ProtocolError('The discovery service returned a redirect or resource loop.');
        visited.add(visit);
        const result = await transport.request<UcwaResource>(current, {
          authenticated,
          ...(options.signal ? { signal: options.signal } : {}),
        });
        const base = discoveryUrl(result.url);
        let resource = result.data;
        if (!isResource(resource)) throw new ProtocolError('The discovery service did not return a UCWA JSON resource.');
        if (!authenticated) rootUrl = link(resource, 'self', base) ?? base;
        else userUrl = base;

        const embedded = resource._embedded?.user;
        if (isResource(embedded)) {
          userUrl = link(embedded, 'self', base) ?? link(resource, 'user', base) ?? base;
          resource = embedded;
        }
        const redirect = link(resource, 'redirect', base);
        if (redirect) { current = redirect; continue; }
        const applicationsUrl = link(resource, 'applications', base);
        if (applicationsUrl) return { rootUrl, userUrl, applicationsUrl, user: resource };
        const nextUser = link(resource, 'user', base);
        if (nextUser) {
          authenticated = true;
          userUrl = nextUser;
          current = nextUser;
          continue;
        }
        throw new ProtocolError('The discovery resource has no redirect, user or applications link.');
      }
      throw new ProtocolError(`Discovery exceeded its ${maxHops}-hop limit.`);
    } catch (error) {
      options.signal?.throwIfAborted();
      // A discovered account's authentication/security error must stay visible.
      if (authenticated || !canTryExternal(error)) throw error;
      failures.push(error);
    }
  }
  throw new AggregateError(failures, 'No Skype for Business discovery endpoint was reachable.');
}

function isResource(value: unknown): value is UcwaResource {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function discoveryUrl(value: string, base?: string): string {
  let url: URL;
  try { url = new URL(value, base); }
  catch { throw new ProtocolError('Discovery links must be valid HTTPS URLs.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new ProtocolError('Discovery links must use HTTPS and contain no user information or fragment.');
  }
  return url.href;
}

function link(resource: UcwaResource, relation: string, base: string): string | undefined {
  const value = resource._links?.[relation];
  const entry: UcwaLink | undefined = Array.isArray(value) ? value[0] : value;
  if (!entry) return undefined;
  if (typeof entry.href !== 'string' || !entry.href) throw new ProtocolError(`The discovery '${relation}' link has no href.`);
  return discoveryUrl(entry.href, base);
}

function canTryExternal(error: unknown): boolean {
  return error instanceof TypeError
    || (error instanceof HttpError && (error.status === 404 || error.status === 408 || error.status >= 500))
    || (error instanceof Error && error.name === 'TimeoutError');
}
