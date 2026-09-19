// No subprocess or temporary private-key file. This process ends before upload.
import fs from "node:fs/promises";
import { createPrivateKey, createPublicKey, createHash, sign, constants } from "node:crypto";

async function main() {
  const [manifest, publicFile] = process.argv.slice(2);
  const secret = process.env.WYVERN_SIGNING_KEY;
  delete process.env.WYVERN_SIGNING_KEY;
  if (!manifest || !publicFile || !secret) throw Error();
  const bytes = Buffer.from(secret);
  let key;
  try { key = createPrivateKey(bytes); } finally { bytes.fill(0); }
  if (key.asymmetricKeyType !== "rsa" || key.asymmetricKeyDetails.modulusLength < 3072) throw Error();
  const publicKey = createPublicKey(key).export({ type: "spki", format: "der" });
  const pinned = createPublicKey(await fs.readFile(publicFile)).export({ type: "spki", format: "der" });
  if (!publicKey.equals(pinned)) throw Error();
  const envelope = { schema: "exocortex.release-signature.v1", algorithm: "RSA-PSS-SHA256",
    key_id: createHash("sha256").update(publicKey).digest("hex"),
    signature: sign("sha256", await fs.readFile(manifest), { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }).toString("base64") };
  await fs.writeFile(manifest + ".sig.json", JSON.stringify(envelope, null, 2) + "\n", { flag: "wx", mode: 0o644 });
}
try { await main(); } catch { process.stderr.write("Signing failed; no release was authorized.\n"); process.exitCode = 1; }
