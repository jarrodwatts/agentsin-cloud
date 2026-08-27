import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { bearer, oneTimeToken } from "better-auth/plugins";
import type { Pool } from "pg";

import type { ControlPlaneConfigShape } from "./config.ts";

export interface AuthUserCreatedEvent {
  readonly userId: string;
  readonly userName: string;
}

export interface MakeAuthOptions {
  readonly config: ControlPlaneConfigShape;
  readonly pool: Pool;
  readonly onUserCreated: (event: AuthUserCreatedEvent) => Promise<void>;
}

/**
 * Better Auth is kept behind this factory so the Electron client and Railway
 * service share one protocol while the database pool and workspace side effect
 * remain server-owned.
 *
 * The callback path is `/api/auth/callback/github` and GitHub receives the
 * `user:email` scope required to map OAuth identities to Better Auth users.
 */
export const makeAuth = ({ config, pool, onUserCreated }: MakeAuthOptions) =>
  betterAuth({
    database: pool,
    baseURL: config.betterAuthUrl.toString().replace(/\/$/, ""),
    secret: config.betterAuthSecret,
    trustedOrigins: [config.betterAuthUrl.origin],
    socialProviders: {
      github: {
        clientId: config.githubClientId,
        clientSecret: config.githubClientSecret,
        scope: ["read:user", "user:email"],
      },
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
    },
    plugins: [
      bearer({ requireSignature: true }),
      oneTimeToken({
        disableClientRequest: true,
        expiresIn: Math.ceil(config.desktopAuthHandoffTtlSeconds / 60),
        storeToken: "hashed",
      }),
      passkey({
        rpID: config.passkeyRpId,
        rpName: config.passkeyRpName,
        origin: config.betterAuthUrl.origin,
      }),
    ],
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            await onUserCreated({ userId: user.id, userName: user.name });
          },
        },
      },
    },
  });
