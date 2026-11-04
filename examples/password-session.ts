import { SkypeForHoo, passwordAuth } from '../src/index.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}`);
  return value;
}

const client = new SkypeForHoo({
  sipAddress: required('SFB_SIP_ADDRESS'),
  auth: passwordAuth({
    username: required('SFB_LOGIN_USERNAME'),
    password: required('SFB_PASSWORD'),
  }),
  trustedOrigins: required('SFB_TRUSTED_ORIGINS').split(',').map((value) => value.trim()),
});

const session = await client.connect({ userAgent: 'skypeforhoo-example/0.1.0' });
try {
  const contacts = await session.contacts();
  console.log('Connected. Contact collection:', contacts.url);
} finally {
  await session.close();
}
