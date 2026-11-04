// This file must typecheck with browser types and no Node ambient types.
import { SkypeForHoo, bearerAuth, type AuthProvider, type Fetch, type MediaEngineFactory, type ScreenSharingSession } from '../../dist/index.js';

const nativeFetch: Fetch = globalThis.fetch;
const auth: AuthProvider = bearerAuth(async ({ signal }) => {
  signal?.throwIfAborted();
  return 'example';
});
const client = new SkypeForHoo({ sipAddress: 'user@example.com', auth, fetch: nativeFetch });
void client;

// A desktop/browser host can supply its own compatible backend without Node ambient types.
const withBackend = (mediaEngine: MediaEngineFactory) => new SkypeForHoo({ sipAddress: 'user@example.com', auth, mediaEngine });
const stop = (share: ScreenSharingSession): Promise<void> => share.stop();
void [withBackend, stop];
