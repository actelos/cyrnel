import type { Request, Response } from "express";
import { z } from "zod";

import { HttpError } from "@/models/error.model";
import type {
  CredentialService,
  OwnerKind,
} from "@/services/credential.service";
import { parseOrHttpError } from "@/utils/validation.util";

const trimmedString = (fieldName: string) =>
  z
    .string({ error: `Field '${fieldName}' must be a string.` })
    .transform((value) => value.trim());

const nonEmptyTrimmedString = (fieldName: string) =>
  trimmedString(fieldName).refine((value) => value.length > 0, {
    error: `Field '${fieldName}' must not be empty.`,
    path: [fieldName],
  });

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

const httpUrl = (fieldName: string) =>
  trimmedString(fieldName).refine(isHttpUrl, {
    error: `Field '${fieldName}' must be a valid absolute http(s) URL.`,
    path: [fieldName],
  });

const schemeNameParamSchema = nonEmptyTrimmedString("schemeName");

const apiKeyBodySchema = z.object({
  apiKey: nonEmptyTrimmedString("apiKey"),
});

const basicBodySchema = z.object({
  username: nonEmptyTrimmedString("username"),
  password: z.string({ error: "Field 'password' must be a string." }).min(1),
});

const bearerBodySchema = z.object({
  token: nonEmptyTrimmedString("token"),
});

const oauth2BodySchema = z.object({
  oauthClientId: nonEmptyTrimmedString("oauthClientId"),
  scopes: z.array(nonEmptyTrimmedString("scopes")).optional().default([]),
});

const oauthCodeBodySchema = z.object({
  code: z.string({ error: "Field 'code' must be a string." }).min(1),
  state: trimmedString("state").optional(),
});

const createOAuthClientBodySchema = z.object({
  provider: nonEmptyTrimmedString("provider"),
  clientId: nonEmptyTrimmedString("clientId"),
  clientSecret: z
    .string({ error: "Field 'clientSecret' must be a string." })
    .min(1),
  tokenUrl: httpUrl("tokenUrl"),
  authorizationUrl: httpUrl("authorizationUrl").optional(),
  clientAuthMethod: z
    .enum(["client_secret_basic", "client_secret_post"])
    .optional(),
  redirectUris: z.array(httpUrl("redirectUris")).optional(),
  availableScopes: z.array(nonEmptyTrimmedString("availableScopes")),
});

const patchOAuthClientBodySchema = z
  .object({
    provider: nonEmptyTrimmedString("provider").optional(),
    tokenUrl: httpUrl("tokenUrl").optional(),
    authorizationUrl: httpUrl("authorizationUrl").nullable().optional(),
    clientAuthMethod: z
      .enum(["client_secret_basic", "client_secret_post"])
      .optional(),
    redirectUris: z.array(httpUrl("redirectUris")).optional(),
    availableScopes: z
      .array(nonEmptyTrimmedString("availableScopes"))
      .optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "Request body must include at least one field to update.",
  });

const oauthClientIdParamSchema = z
  .string({ error: "Invalid client ID." })
  .min(1);

const oauthCallbackQuerySchema = z.object({
  code: z.string({ error: "Query 'code' must be a string." }).min(1),
  state: z.string({ error: "Query 'state' must be a string." }).min(1),
});

const resolveQuerySchema = z.object({
  authorizationUrl: nonEmptyTrimmedString("authorizationUrl"),
  scopes: trimmedString("scopes").optional(),
});

function getCredentialService(req: Request): CredentialService {
  const service = req.app.locals.credentialService as
    | CredentialService
    | undefined;
  if (!service) {
    throw new Error("CredentialService not configured in app.locals");
  }
  return service;
}

function ownerIdFromReq(kind: OwnerKind, req: Request): string {
  const param =
    kind === "service"
      ? req.params.serviceId
      : kind === "module"
        ? req.params.moduleId
        : req.params.id;
  const parsed = parseOrHttpError(nonEmptyTrimmedString("ownerId"), param);
  return parsed;
}

export function makeOwnerCredentialHandlers(kind: OwnerKind) {
  const storeFor = (req: Request) =>
    getCredentialService(req).storeFor(kind, ownerIdFromReq(kind, req));

  return {
    async listCredentials(req: Request, res: Response): Promise<void> {
      const credentials = await storeFor(req).listCredentials();
      res.status(200).json(credentials);
    },

    async upsertApiKey(req: Request, res: Response): Promise<void> {
      const schemeName = parseOrHttpError(
        schemeNameParamSchema,
        req.params.schemeName,
      );
      const payload = parseOrHttpError(
        apiKeyBodySchema,
        req.body,
        "Request body must be an object.",
      );
      const { credential, replaced } = await storeFor(req).upsertApiKey(
        schemeName,
        payload.apiKey,
      );
      res.status(200).json({
        credential: await getCredentialService(req).toSummary(credential),
        replaced,
      });
    },

    async upsertBasic(req: Request, res: Response): Promise<void> {
      const schemeName = parseOrHttpError(
        schemeNameParamSchema,
        req.params.schemeName,
      );
      const payload = parseOrHttpError(
        basicBodySchema,
        req.body,
        "Request body must be an object.",
      );
      const { credential, replaced } = await storeFor(req).upsertBasic(
        schemeName,
        payload.username,
        payload.password,
      );
      res.status(200).json({
        credential: await getCredentialService(req).toSummary(credential),
        replaced,
      });
    },

    async upsertBearer(req: Request, res: Response): Promise<void> {
      const schemeName = parseOrHttpError(
        schemeNameParamSchema,
        req.params.schemeName,
      );
      const payload = parseOrHttpError(
        bearerBodySchema,
        req.body,
        "Request body must be an object.",
      );
      const { credential, replaced } = await storeFor(req).upsertBearer(
        schemeName,
        payload.token,
      );
      res.status(200).json({
        credential: await getCredentialService(req).toSummary(credential),
        replaced,
      });
    },

    async upsertOAuth2(req: Request, res: Response): Promise<void> {
      const schemeName = parseOrHttpError(
        schemeNameParamSchema,
        req.params.schemeName,
      );
      const payload = parseOrHttpError(
        oauth2BodySchema,
        req.body,
        "Request body must be an object.",
      );
      const { credential, replaced, unknownScopes } = await storeFor(
        req,
      ).upsertOAuth2(schemeName, payload.oauthClientId, payload.scopes);
      res.status(200).json({
        credential: await getCredentialService(req).toSummary(credential),
        replaced,
        ...(unknownScopes.length > 0
          ? {
              warning: {
                unknownScopes,
                message: `Scope(s) not declared by scheme '${schemeName}': ${unknownScopes.join(", ")}. The credential was created; operations requiring undeclared scopes may fail.`,
              },
            }
          : {}),
      });
    },

    async disconnectScheme(req: Request, res: Response): Promise<void> {
      const schemeName = parseOrHttpError(
        schemeNameParamSchema,
        req.params.schemeName,
      );
      const removed = await storeFor(req).disconnectScheme(schemeName);
      if (!removed) {
        throw new HttpError(
          404,
          `No credential configured for scheme '${schemeName}'.`,
        );
      }
      res.status(204).send();
    },

    async beginOAuthAuthorization(req: Request, res: Response): Promise<void> {
      const schemeName = parseOrHttpError(
        schemeNameParamSchema,
        req.params.schemeName,
      );
      const result = await storeFor(req).beginOAuth(schemeName);
      res.status(200).json(result);
    },

    async submitOAuthCode(req: Request, res: Response): Promise<void> {
      const schemeName = parseOrHttpError(
        schemeNameParamSchema,
        req.params.schemeName,
      );
      const payload = parseOrHttpError(
        oauthCodeBodySchema,
        req.body,
        "Request body must be an object.",
      );
      const store = storeFor(req);
      const cred = await store.getForScheme(schemeName);
      if (!cred) {
        throw new HttpError(
          404,
          `No credential configured for scheme '${schemeName}'.`,
        );
      }
      await store.completeOAuthCode(
        cred.id,
        payload.code,
        payload.state && payload.state.length > 0 ? payload.state : undefined,
      );
      res.status(200).json({ credentialId: cred.id });
    },
  };
}

export async function listOAuthClients(
  req: Request,
  res: Response,
): Promise<void> {
  const clients = await getCredentialService(req).listOAuthClients();
  res.status(200).json(clients);
}

export async function createOAuthClient(
  req: Request,
  res: Response,
): Promise<void> {
  const payload = parseOrHttpError(
    createOAuthClientBodySchema,
    req.body,
    "Request body must be an object.",
  );
  const clientId = await getCredentialService(req).createOAuthClient(payload);
  res.status(201).json({ clientId });
}

export async function patchOAuthClient(
  req: Request,
  res: Response,
): Promise<void> {
  const id = parseOrHttpError(oauthClientIdParamSchema, req.params.id);
  const payload = parseOrHttpError(
    patchOAuthClientBodySchema,
    req.body,
    "Request body must be an object.",
  );
  const client = await getCredentialService(req).patchOAuthClient(id, payload);
  res.status(200).json(client);
}

export async function deleteOAuthClient(
  req: Request,
  res: Response,
): Promise<void> {
  const id = parseOrHttpError(oauthClientIdParamSchema, req.params.id);
  await getCredentialService(req).deleteOAuthClient(id);
  res.status(204).send();
}

export async function resolveOAuthClients(
  req: Request,
  res: Response,
): Promise<void> {
  const query = parseOrHttpError(
    resolveQuerySchema,
    req.query,
    "Invalid query parameters.",
  );
  const scopes = (query.scopes ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const clients = await getCredentialService(req).resolveOAuthClients({
    authorizationUrl: query.authorizationUrl,
    requestedScopes: scopes,
  });
  res.status(200).json({ clients });
}

export async function oauthCallback(
  req: Request,
  res: Response,
): Promise<void> {
  const query = parseOrHttpError(
    oauthCallbackQuerySchema,
    req.query,
    "Invalid query parameters.",
  );
  const credential = await getCredentialService(req).completeOAuthAuthorization(
    query.state,
    query.code,
  );
  res.status(200).json({ ok: true, credentialId: credential.id });
}
