import { generateServiceKey } from '../src/lib/service-key.js';

/**
 * Generate the P-256 key behind Antiphony's DID document
 * (`/.well-known/did.json`, `src/lib/service-did-document.ts`).
 *
 *     npm run generate:service-key -w @antiphony/core-api
 *
 * Prints the two values to stdout and writes nothing to disk, so the private
 * key exists only in the terminal that ran this and wherever the operator puts
 * it next. Run it in a terminal you are not recording, and do not redirect the
 * output to a file.
 *
 * Set the secret first and the var second: the route refuses to publish a
 * public key it cannot derive from the secret, so that order means the
 * document never advertises a key the service lacks.
 */
const key = await generateServiceKey();

console.log('WARNING: store the private key in a password manager; never commit it or paste it anywhere else.');
console.log('');
console.log('Private key. Secret value for:');
console.log('    npx wrangler secret put ANTIPHONY_SERVICE_SIGNING_KEY -c apps/core-api/wrangler.jsonc');
console.log(key.privateKeyHex);
console.log('');
console.log('Public key. Value for the ANTIPHONY_SERVICE_PUBLIC_KEY var (vars in apps/core-api/wrangler.jsonc), set after the secret:');
console.log(key.publicKeyMultibase);
