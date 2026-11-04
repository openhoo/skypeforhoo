// This file must typecheck with Node types and no DOM library.
import { SkypeForHoo, UcwaTransport, bearerAuth, resourceDocumentation, type RequestOptions } from '../../dist/index.js';

const options: RequestOptions = { headers: { Accept: 'application/json' }, body: 'example' };
const transport = new UcwaTransport({ trustedOrigins: ['https://pool.example.com'], auth: bearerAuth('example') });
const client = new SkypeForHoo({ sipAddress: 'user@example.com', auth: bearerAuth('example') });
void [options, transport, client, resourceDocumentation('applications')];
