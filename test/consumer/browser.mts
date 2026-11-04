// This file must typecheck with browser types and no Node ambient types.
import { SkypeForHoo, bearerAuth, type AuthProvider, type Fetch } from '../../dist/index.js';

const nativeFetch: Fetch = globalThis.fetch;
const auth: AuthProvider = bearerAuth(async ({ signal }) => {
  signal?.throwIfAborted();
  return 'example';
});
const client = new SkypeForHoo({ sipAddress: 'user@example.com', auth, fetch: nativeFetch });
void client;
