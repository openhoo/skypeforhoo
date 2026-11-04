import { MissingLinkError, ProtocolError } from './errors.js';
import type { HttpResult, RequestOptions, Transport, UcwaResource } from './types.js';

/** A representation together with the URL against which its relative links resolve. */
export interface ResourceReference<T extends UcwaResource = UcwaResource> {
  data: T;
  url: string;
}

export function hasLink(resource: UcwaResource, relation: string): boolean {
  const value = resource._links?.[relation];
  return Array.isArray(value)
    ? value.some((link) => typeof link?.href === 'string' && link.href.length > 0)
    : typeof value?.href === 'string' && value.href.length > 0;
}

/** Resolve one advertised link. Ambiguous collections must use getLinks(). */
export function getLink(resource: UcwaResource, relation: string, baseUrl: string): string {
  const links = getLinks(resource, relation, baseUrl);
  if (links.length !== 1) {
    throw new ProtocolError(`The '${relation}' relation contains multiple links; select one with getLinks().`);
  }
  return links[0]!;
}

export function getLinks(resource: UcwaResource, relation: string, baseUrl: string): string[] {
  const value = resource._links?.[relation];
  if (!value) throw new MissingLinkError(relation);
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0) throw new MissingLinkError(relation);
  return values.map((link) => {
    if (typeof link?.href !== 'string' || link.href.length === 0) {
      throw new ProtocolError(`The '${relation}' relation has no usable href.`);
    }
    try {
      return new URL(link.href, baseUrl).href;
    } catch {
      throw new ProtocolError(`The '${relation}' relation has an invalid href.`);
    }
  });
}

export function resourceReference<T extends UcwaResource>(data: T, url: string): ResourceReference<T> {
  return { data, url: hasLink(data, 'self') ? getLink(data, 'self', url) : url };
}

export function embeddedResource(
  parent: ResourceReference,
  relation: string,
): ResourceReference | undefined {
  const embedded = parent.data._embedded?.[relation];
  if (embedded === undefined) return undefined;
  if (typeof embedded !== 'object' || embedded === null || Array.isArray(embedded)) {
    throw new ProtocolError(`The embedded '${relation}' resource is not a single object.`);
  }
  const base = hasLink(parent.data, relation) ? getLink(parent.data, relation, parent.url) : parent.url;
  return resourceReference(embedded as UcwaResource, base);
}

export function requireResource<T extends UcwaResource>(result: HttpResult<T>): ResourceReference<T> {
  if (typeof result.data !== 'object' || result.data === null || Array.isArray(result.data)) {
    throw new ProtocolError('The server response does not contain a UCWA resource representation.');
  }
  return resourceReference(result.data, result.url);
}

/** Low-level HAL operations for resource relations not covered by a convenience method. */
export class ResourceClient {
  constructor(protected readonly transport: Transport) {}

  protected assertUsable(): void {}

  async read<T extends UcwaResource = UcwaResource>(url: string, signal?: AbortSignal): Promise<ResourceReference<T>> {
    this.assertUsable();
    return requireResource(await this.transport.request<T>(url, signal ? { signal } : {}));
  }

  async follow<T extends UcwaResource = UcwaResource>(
    resource: ResourceReference,
    relation: string,
    signal?: AbortSignal,
  ): Promise<ResourceReference<T>> {
    this.assertUsable();
    return this.read<T>(getLink(resource.data, relation, resource.url), signal);
  }

  /** Invoke an advertised operation; binary bodies and response metadata are preserved. */
  async invoke<T = UcwaResource>(
    resource: ResourceReference,
    relation: string,
    options: RequestOptions = {},
  ): Promise<HttpResult<T>> {
    this.assertUsable();
    return this.transport.request<T>(getLink(resource.data, relation, resource.url), options);
  }
}
