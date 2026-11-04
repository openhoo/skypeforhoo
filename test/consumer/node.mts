// This file must typecheck with Node types and no DOM library.
import { SkypeForHoo, UcwaTransport, bearerAuth, resourceDocumentation, type RequestOptions, type MediaEngineFactory, type UcwaSession } from '../../dist/index.js';

const options: RequestOptions = { headers: { Accept: 'application/json' }, body: 'example' };
const transport = new UcwaTransport({ trustedOrigins: ['https://pool.example.com'], auth: bearerAuth('example') });
const client = new SkypeForHoo({ sipAddress: 'user@example.com', auth: bearerAuth('example') });
void [options, transport, client, resourceDocumentation('applications')];

// Native backends and media control must remain usable without browser-only ambient types.
const withBackend = (mediaEngine: MediaEngineFactory) => new SkypeForHoo({
  sipAddress: 'user@example.com', auth: bearerAuth('example'), mediaEngine, mediaCleanupTimeoutMs: 5000,
});
const media = (session: UcwaSession) => session.screenSharing.supports({
  feature: 'screenSharing', direction: 'send', captureSource: 'window',
});
void [withBackend, media];
