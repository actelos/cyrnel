import { type Router as ExpressRouter, Router } from "express";

import {
  makeOwnerCredentialHandlers,
  oauthCallback,
} from "@/controllers/credential.controller";
import { createRateLimiter } from "@/middleware/rate-limit.middleware";
import type { OwnerKind } from "@/services/credential.service";

export function ownerCredentialRouter(kind: OwnerKind): ExpressRouter {
  const router: ExpressRouter = Router({ mergeParams: true });
  const h = makeOwnerCredentialHandlers(kind);

  router.get("/", h.listCredentials);
  router.put(
    "/:schemeName/api-key",
    createRateLimiter(10, 60_000, `PUT ${kind} credentials api-key`),
    h.upsertApiKey,
  );
  router.put(
    "/:schemeName/basic",
    createRateLimiter(10, 60_000, `PUT ${kind} credentials basic`),
    h.upsertBasic,
  );
  router.put(
    "/:schemeName/bearer",
    createRateLimiter(10, 60_000, `PUT ${kind} credentials bearer`),
    h.upsertBearer,
  );
  router.put(
    "/:schemeName/oauth2",
    createRateLimiter(10, 60_000, `PUT ${kind} credentials oauth2`),
    h.upsertOAuth2,
  );
  router.delete(
    "/:schemeName",
    createRateLimiter(10, 60_000, `DELETE ${kind} credentials`),
    h.disconnectScheme,
  );
  router.post(
    "/:schemeName/oauth/authorize",
    createRateLimiter(5, 60_000, `POST ${kind} credentials oauth authorize`),
    h.beginOAuthAuthorization,
  );
  router.post(
    "/:schemeName/oauth/code",
    createRateLimiter(5, 60_000, `POST ${kind} credentials oauth code`),
    h.submitOAuthCode,
  );

  return router;
}

export const authCallbackRouter: ExpressRouter = Router();

authCallbackRouter.get(
  "/callback",
  createRateLimiter(10, 60_000, "GET /auth/callback"),
  oauthCallback,
);
