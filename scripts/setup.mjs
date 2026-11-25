import { writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import webpush from 'web-push';

const secret = () => randomBytes(32).toString('base64url');
const agent = secret();
const hash = createHash('sha256').update(agent).digest('hex');
const vapid = webpush.generateVAPIDKeys();
try {
  await writeFile('.env', `# Local Glamp workspace. Never commit or upload this file.\nGLAMP_OWNER_TOKEN=${secret()}\nGLAMP_TOKEN=${agent}\nGLAMP_AGENT_TOKEN_HASHES=${hash}\nVAPID_PUBLIC_KEY=${vapid.publicKey}\nVAPID_PRIVATE_KEY=${vapid.privateKey}\n# For push delivery, replace with a real contact address or HTTPS URL.\nVAPID_SUBJECT=\n`, { flag: 'wx', mode: 0o600 });
  console.log('Created private .env. Use its GLAMP_OWNER_TOKEN in the browser. npm run glamp uses its separate agent token.');
} catch (err) {
  if (err.code !== 'EEXIST') throw err;
  console.error('Left existing .env untouched.');
  process.exitCode = 1;
}
