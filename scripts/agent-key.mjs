import { randomBytes, createHash } from 'node:crypto';
// Offline helper for the owner. Never contacts the workspace or changes its settings.
const token = randomBytes(32).toString('base64url');
console.log('Private: give the first value to ONE agent via its secret manager; do not commit or share this output.');
console.log(`GLAMP_TOKEN=${token}`);
console.log(`\nAppend this SHA-256 hash to GLAMP_AGENT_TOKEN_HASHES on the server:\n${createHash('sha256').update(token).digest('hex')}`);
