import { type Router as ExpressRouter, Router } from "express";

import {
  createOAuthClient,
  deleteOAuthClient,
  listOAuthClients,
  patchOAuthClient,
  resolveOAuthClients,
} from "@/controllers/credential.controller";
import { createRateLimiter } from "@/middleware/rate-limit.middleware";

export const oauthClientRouter: ExpressRouter = Router();

oauthClientRouter.get(
  "/",
  createRateLimiter(30, 60_000, "GET /oauth-clients"),
  listOAuthClients,
);
oauthClientRouter.get(
  "/resolve",
  createRateLimiter(30, 60_000, "GET /oauth-clients/resolve"),
  resolveOAuthClients,
);
oauthClientRouter.post(
  "/",
  createRateLimiter(10, 60_000, "POST /oauth-clients"),
  createOAuthClient,
);
oauthClientRouter.patch(
  "/:id",
  createRateLimiter(10, 60_000, "PATCH /oauth-clients/:id"),
  patchOAuthClient,
);
oauthClientRouter.delete(
  "/:id",
  createRateLimiter(10, 60_000, "DELETE /oauth-clients/:id"),
  deleteOAuthClient,
);
