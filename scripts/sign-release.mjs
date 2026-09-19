import fs from 'node:fs/promises';
import { createPrivateKey, createPublicKey, createHash, sign, constants } from 'node:crypto';
const [manifest, filename] = process.argv.slice(2);
if (!manifest || !filename) throw Error('Usage: node scripts/sign-release.mjs manifest.json private-key-file');
const key = createPrivateKey(await fs.readFile(filename));
if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 3072) throw Error('RSA >=3072 required');
const publicKey = createPublicKey(key).export({ type: 'spki', format: 'der' });
const envelope = { schema: 'exocortex.release-signature.v1', algorithm: 'RSA-PSS-SHA256', key_id: createHash('sha256').update(publicKey).digest('hex'),
  signature: sign('sha256', await fs.readFile(manifest), { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }).toString('base64') };
await fs.writeFile(manifest+'.sig.json', JSON.stringify(envelope, null, 2)+'\n', { flag: 'wx' });
