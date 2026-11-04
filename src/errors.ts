export class SkypeForHooError extends Error {
  override name = 'SkypeForHooError';
}

export class ProtocolError extends SkypeForHooError {
  override name = 'ProtocolError';
}

export class UntrustedOriginError extends SkypeForHooError {
  override name = 'UntrustedOriginError';
  constructor(public readonly origin: string) {
    super(`Origin is not trusted: ${origin}. Add its exact HTTPS origin to trustedOrigins or approve it with trustOrigin.`);
  }
}

export class HttpError extends SkypeForHooError {
  override name = 'HttpError';
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly response: Response,
    /** Parsed response body. May contain server-specific diagnostics. */
    public readonly data?: unknown,
  ) {
    super(`HTTP ${status} from ${new URL(url).origin}${new URL(url).pathname}`);
  }
}

export class AuthenticationError extends SkypeForHooError {
  override name = 'AuthenticationError';
  constructor(message: string, public readonly challenge?: string) {
    super(message);
  }
}

export class MissingLinkError extends ProtocolError {
  override name = 'MissingLinkError';
  constructor(public readonly relation: string) {
    super(`The server did not advertise the '${relation}' link. The feature may be unavailable for this account or server.`);
  }
}
