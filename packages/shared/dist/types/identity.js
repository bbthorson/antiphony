"use strict";
/**
 * Identity Resolver Interface
 *
 * Abstracts identity operations so the service layer doesn't depend
 * on a specific identity provider (Firebase Auth, AT Protocol PDS, etc.).
 *
 * Current implementation: FirebaseIdentityResolver (see below)
 * Future: ATProtocolIdentityResolver (resolves via PDS/PLC directory)
 */
Object.defineProperty(exports, "__esModule", { value: true });
