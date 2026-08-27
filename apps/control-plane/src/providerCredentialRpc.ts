// @effect-diagnostics effectSucceedWithVoid:off -- The optional HTTP router distinguishes undefined from void.
import {
  ProviderCredentialBeginLoginCommand,
  ProviderCredentialCancelLoginCommand,
  ProviderCredentialMaterializeCommand,
  ProviderCredentialPollLoginCommand,
  ProviderCredentialProfileCommand,
  ProviderCredentialSealProfileCommand,
  WorkspaceId,
} from "@t3tools/contracts/cloud";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ControlPlaneAuth } from "./http.ts";
import type { ProviderCredentialService } from "./providerCredentialService.ts";
import {
  makeServerCredentialPrincipal,
  type ProviderLoginCoordinator,
} from "./providerCredentialProduction.ts";
import type { WorkspaceRepositoryService } from "./workspaces.ts";

const decoders = {
  begin: Schema.decodeUnknownEffect(ProviderCredentialBeginLoginCommand),
  poll: Schema.decodeUnknownEffect(ProviderCredentialPollLoginCommand),
  cancel: Schema.decodeUnknownEffect(ProviderCredentialCancelLoginCommand),
  seal: Schema.decodeUnknownEffect(ProviderCredentialSealProfileCommand),
  materialize: Schema.decodeUnknownEffect(ProviderCredentialMaterializeCommand),
  profile: Schema.decodeUnknownEffect(ProviderCredentialProfileCommand),
  workspaceId: Schema.decodeUnknownEffect(WorkspaceId),
};

class ProviderCredentialRpcError extends Schema.TaggedErrorClass<ProviderCredentialRpcError>()(
  "ProviderCredentialRpcError",
  { code: Schema.String },
) {}

const response = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" },
  });

const body = <A, E>(request: Request, decode: (value: unknown) => Effect.Effect<A, E>) =>
  Effect.tryPromise({
    try: () => request.json(),
    catch: () => new ProviderCredentialRpcError({ code: "invalid_json" }),
  }).pipe(
    Effect.flatMap((value) =>
      decode(value).pipe(
        Effect.mapError(() => new ProviderCredentialRpcError({ code: "invalid_body" })),
      ),
    ),
  );

export const makeProviderCredentialRpc = (input: {
  readonly auth: ControlPlaneAuth;
  readonly hostedOrigin: string;
  readonly workspaces: WorkspaceRepositoryService;
  readonly service: ProviderCredentialService;
  readonly logins: ProviderLoginCoordinator;
}) => ({
  handleHttp: (request: Request): Effect.Effect<Response | undefined> => {
    const pathname = new URL(request.url).pathname;
    if (!pathname.startsWith("/api/v1/provider-credentials/")) return Effect.succeed(undefined);
    if (request.method !== "POST")
      return Effect.succeed(response({ error: "method_not_allowed" }, 405));
    const origin = request.headers.get("origin");
    if (origin !== null && origin !== input.hostedOrigin)
      return Effect.succeed(response({ error: "forbidden" }, 403));
    return Effect.gen(function* () {
      const session = yield* Effect.tryPromise({
        try: () => input.auth.api.getSession({ headers: request.headers }),
        catch: () => new ProviderCredentialRpcError({ code: "authentication_failed" }),
      });
      if (session === null || session.session?.id === undefined)
        return response({ error: "unauthorized" }, 401);
      const workspace = yield* input.workspaces
        .findForUser(session.user.id)
        .pipe(Effect.mapError(() => new ProviderCredentialRpcError({ code: "workspace_failed" })));
      if (workspace === undefined) return response({ error: "not_found" }, 404);
      const workspaceId = yield* decoders
        .workspaceId(workspace.id)
        .pipe(Effect.mapError(() => new ProviderCredentialRpcError({ code: "workspace_invalid" })));
      const principal = makeServerCredentialPrincipal({
        workspaceId,
        userId: session.user.id,
        authSessionId: session.session.id,
      });

      if (pathname.endsWith("/login/begin")) {
        const command = yield* body(request, decoders.begin);
        return response(
          yield* input.logins.begin({
            principal,
            threadId: command.threadId,
            providerInstanceId: command.providerInstanceId,
          }),
          202,
        );
      }
      if (pathname.endsWith("/login/poll")) {
        const command = yield* body(request, decoders.poll);
        return response(yield* input.logins.poll(principal, command.loginId));
      }
      if (pathname.endsWith("/login/cancel")) {
        const command = yield* body(request, decoders.cancel);
        return response(yield* input.logins.cancel(principal, command.loginId));
      }
      if (pathname.endsWith("/profiles/seal")) {
        const command = yield* body(request, decoders.seal);
        return response(
          yield* input.service.sealProfile({
            authorization: principal,
            loginId: command.loginId,
            profileId: command.profileId,
            label: command.label,
            idempotencyKey: command.idempotencyKey,
          }),
        );
      }
      if (pathname.endsWith("/profiles/materialize")) {
        const command = yield* body(request, decoders.materialize);
        return response(
          yield* input.service.materialize({
            authorization: principal,
            threadId: command.threadId,
            profileId: command.profileId,
            materializationId: command.materializationId,
          }),
        );
      }
      if (pathname.endsWith("/profiles/validate")) {
        const command = yield* body(request, decoders.profile);
        return response(
          yield* input.service.validate({ authorization: principal, profileId: command.profileId }),
        );
      }
      if (pathname.endsWith("/profiles/revoke")) {
        const command = yield* body(request, decoders.profile);
        return response(
          yield* input.service.revoke({ authorization: principal, profileId: command.profileId }),
        );
      }
      return response({ error: "not_found" }, 404);
    }).pipe(Effect.orElseSucceed(() => response({ error: "invalid_request" }, 400)));
  },
});
