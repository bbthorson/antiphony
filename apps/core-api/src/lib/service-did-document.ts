import { publicBaseUrl, publicDidWeb, serviceDid, servicePublicKey, serviceSigningKey } from './app-config.js';
import { logger } from './logger.js';
import { derivePublicKeyMultibase, looksLikePublicKeyMultibase } from './service-key.js';

/**
 * Antiphony's own DID document, served at `/.well-known/did.json`.
 *
 * The shape follows AT Protocol conventions and the way this codebase reads
 * tenants' documents (`app-did.ts`, `signed-service-auth.ts`): a `Multikey`
 * verification method with the fragment `#atproto`, which is where atproto
 * resolvers look for a DID's signing key, and a service entry whose fragment
 * and type follow `#atproto_labeler` / `AtprotoLabeler`, namespaced to us. The
 * `@context` list is the pair atproto's own documents carry.
 */
export interface ServiceDidDocument {
    '@context': string[];
    id: string;
    verificationMethod: {
        id: string;
        type: 'Multikey';
        controller: string;
        publicKeyMultibase: string;
    }[];
    service: { id: string; type: string; serviceEndpoint: string }[];
}

/**
 * The verdict for one pair of key values. It is cached because deriving the
 * public key is async crypto, and the answer only changes when a value does.
 * The cache is one entry keyed by both values, so a rotated secret or var is
 * picked up by the next request in a live isolate instead of waiting for a
 * restart. The DID and base URL are not part of the key: they are cheap string
 * reads, checked on every request.
 */
let cached: { key: string; verdict: Promise<boolean> } | undefined;

/** Forget the cached verdict. Tests need a fresh derivation per case. */
export function resetServiceDidDocumentCache(): void {
    cached = undefined;
}

/**
 * Whether the private key derives the configured public key. Logs once per
 * isolate and pair when it does not, and never logs a key: the line names the
 * two settings and nothing else, because the private one is a secret and a
 * log is a place it must not end up.
 */
async function keysAgree(privateKey: string, publicKey: string): Promise<boolean> {
    const key = `${privateKey}\n${publicKey}`;
    if (cached?.key !== key) {
        cached = {
            key,
            verdict: (async () => {
                if (!looksLikePublicKeyMultibase(publicKey)) {
                    logger.error(
                        '[service-did] ANTIPHONY_SERVICE_PUBLIC_KEY is not a multibase Multikey (z…); not publishing the DID document',
                    );
                    return false;
                }
                const derived = await derivePublicKeyMultibase(privateKey);
                if (derived === null) {
                    logger.error(
                        '[service-did] ANTIPHONY_SERVICE_SIGNING_KEY is not a 64-character hex P-256 private key; not publishing the DID document',
                    );
                    return false;
                }
                if (derived !== publicKey) {
                    logger.error(
                        '[service-did] ANTIPHONY_SERVICE_PUBLIC_KEY does not match the public key derived from ANTIPHONY_SERVICE_SIGNING_KEY; not publishing the DID document',
                    );
                    return false;
                }
                return true;
            })(),
        };
    }
    return cached.verdict;
}

/**
 * The document to serve, or `null` for "answer 404 as before".
 *
 * Every condition has to hold, and each is there so the document is never
 * wrong rather than merely absent:
 *
 *   - the DID is exactly `did:web` of this deployment's host. A document at
 *     `/.well-known/did.json` can only be the document of that DID, so an
 *     `ANTIPHONY_SERVICE_DID` naming another host or a path would otherwise be
 *     served under an `id` the URL does not resolve;
 *   - both settings are present, so a deployment with no key behaves exactly as
 *     it did before this route existed;
 *   - the private key derives the public one, so the document never advertises
 *     a key the service cannot sign with. Setting the secret first and the var
 *     second keeps that true during a rollout.
 */
export async function serviceDidDocument(): Promise<ServiceDidDocument | null> {
    const did = serviceDid();
    const endpoint = publicBaseUrl();
    if (!did || !endpoint || did !== publicDidWeb()) return null;

    const privateKey = serviceSigningKey();
    const publicKey = servicePublicKey();
    if (!privateKey || !publicKey) return null;
    if (!(await keysAgree(privateKey, publicKey))) return null;

    return {
        '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'],
        id: did,
        verificationMethod: [
            {
                id: `${did}#atproto`,
                type: 'Multikey',
                controller: did,
                publicKeyMultibase: publicKey,
            },
        ],
        service: [{ id: '#antiphony_audio', type: 'AntiphonyAudioService', serviceEndpoint: endpoint }],
    };
}
