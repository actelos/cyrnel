import { ChevronDown, ExternalLink, Unlink } from "lucide-react";
import { useMemo, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { z } from "zod";
import { CopyButton } from "@/components/copy-button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useNotification } from "@/hooks/use-notification";
import { apiFetch, apiFetchJson, buildUrl, errorMessageFrom } from "@/lib/api";

const credentialSummarySchema = z.object({
  id: z.string(),
  schemeName: z.string(),
  schemeType: z.enum(["apiKey", "basic", "bearer", "oauth2"]),
  status: z.enum(["active", "expired", "revoked", "error"]),
  oauthClientId: z.string().nullable(),
  requestedScopes: z.array(z.string()),
  grantedScopes: z.array(z.string()).nullable(),
  grantedSource: z.enum(["provider", "inferred"]).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  oauthClient: z
    .object({
      id: z.string(),
      provider: z.string(),
      clientId: z.string(),
      tokenUrl: z.string(),
      authorizationUrl: z.string().nullable(),
    })
    .nullable(),
});

const credentialListSchema = z.array(credentialSummarySchema);

const oauthClientSchema = z.object({
  id: z.string(),
  provider: z.string(),
  clientId: z.string(),
  tokenUrl: z.string(),
  authorizationUrl: z.string().nullable(),
  clientAuthMethod: z.string(),
  redirectUris: z.array(z.string()),
  availableScopes: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const oauthClientListSchema = z.array(oauthClientSchema);

const resolvedClientSchema = oauthClientSchema.extend({
  scopeCompatible: z.boolean(),
  tokenHost: z.string().nullable(),
  warning: z.string().nullable(),
});

const resolveResponseSchema = z.object({
  clients: z.array(resolvedClientSchema),
});

const oauthAuthorizeSchema = z.object({
  authorizationUrl: z.string(),
  state: z.string(),
});

const oauthCodeResponseSchema = z.object({
  credentialId: z.string(),
});

const staticUpsertResponseSchema = z.object({
  credential: credentialSummarySchema,
  replaced: z.boolean(),
});

const oauth2UpsertResponseSchema = z.object({
  credential: credentialSummarySchema,
  replaced: z.boolean(),
  warning: z
    .object({
      unknownScopes: z.array(z.string()),
      message: z.string(),
    })
    .optional(),
});

const registryMachineAuthResponseSchema = z.object({
  auth: z.object({
    credential: credentialSummarySchema,
    status: z.string(),
    message: z.string().nullable().optional(),
    tokenExpiresAt: z.number().nullable().optional(),
  }),
});

const oauthClientCreatedSchema = z.object({
  clientId: z.string(),
});

type CredentialSummary = z.infer<typeof credentialSummarySchema>;
type OAuthClient = z.infer<typeof oauthClientSchema>;
type ResolvedClient = z.infer<typeof resolvedClientSchema>;

export interface AuthSchemeInfo {
  type: string;
  in?: string;
  paramName?: string;
  prefix?: string;
  scheme?: string;
  grantTypes?: string[];
  tokenUrl?: string;
  authorizationUrl?: string;
  scopes?: Record<string, string>;
}

export interface AuthTarget {
  kind: "service" | "module" | "registry";
  id: string;
}

interface AuthSectionProps {
  target: AuthTarget;
  authSchemes: Record<string, AuthSchemeInfo>;
}

type StaticCredentialType = "apiKey" | "basic" | "bearer";

function credentialsBase(target: AuthTarget): string {
  if (target.kind === "service") return `/services/${target.id}/credentials`;
  if (target.kind === "module") return `/modules/${target.id}/credentials`;
  return `/registries/${target.id}/credentials`;
}

function credentialTypeForScheme(
  scheme: AuthSchemeInfo,
): StaticCredentialType | "oauth2" | null {
  if (scheme.type === "apiKey") return "apiKey";
  if (scheme.type === "basic") return "basic";
  if (scheme.type === "http" && scheme.scheme === "basic") return "basic";
  if (scheme.type === "http" && scheme.scheme === "bearer") return "bearer";
  if (scheme.type === "oauth2") return "oauth2";
  return null;
}

function schemeTypeLabel(scheme: AuthSchemeInfo): string {
  const mapped = credentialTypeForScheme(scheme);
  switch (mapped) {
    case "apiKey":
      return "API Key";
    case "basic":
      return "Basic Auth";
    case "bearer":
      return "Bearer";
    case "oauth2":
      return "OAuth 2.0";
    default:
      return scheme.type;
  }
}

function hostnameOf(raw: string | null | undefined): string {
  if (!raw) return "provider";
  try {
    return new URL(raw).hostname;
  } catch {
    return "provider";
  }
}

function splitList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function declaredScopesHelp(scheme: AuthSchemeInfo): string | null {
  if (!scheme.scopes || Object.keys(scheme.scopes).length === 0) return null;
  return Object.entries(scheme.scopes)
    .map(([id, description]) => (description ? `${id} (${description})` : id))
    .join(", ");
}

function placementHelp(scheme: AuthSchemeInfo): string {
  const mapped = credentialTypeForScheme(scheme);
  if (mapped === "apiKey") {
    return `Sent in ${scheme.in ?? "header"} as '${scheme.paramName ?? "key"}'`;
  }
  if (mapped === "basic") return "Username and password";
  if (mapped === "bearer") return "Bearer token in the Authorization header";
  return "";
}

export default function AuthSection({ target, authSchemes }: AuthSectionProps) {
  const { mutate } = useSWRConfig();

  const base = credentialsBase(target);
  const credentialsUrl = buildUrl(base);
  const { data: credentials } = useSWR(
    credentialsUrl,
    (url) => apiFetchJson(url, credentialListSchema),
    { refreshInterval: 8000 },
  );

  const oauthClientsUrl = buildUrl("/oauth-clients");
  const { data: oauthClients } = useSWR(
    oauthClientsUrl,
    (url) => apiFetchJson(url, oauthClientListSchema),
    { refreshInterval: 15000 },
  );

  const schemeNames = Object.keys(authSchemes);

  const refreshAll = () => {
    void mutate(credentialsUrl);
    void mutate(oauthClientsUrl);
    if (target.kind === "service" || target.kind === "module") {
      void mutate(
        target.kind === "service"
          ? buildUrl(`/services/${target.id}`)
          : buildUrl(`/modules/${target.id}`),
      );
    } else {
      void mutate(buildUrl(`/registries/${target.id}/auth`));
    }
  };

  if (schemeNames.length === 0) {
    return null;
  }

  const credentialByScheme = new Map(
    (credentials ?? []).map((c) => [c.schemeName, c]),
  );

  return (
    <div className="space-y-3">
      {schemeNames.map((name) => {
        const scheme = authSchemes[name];
        const credential = credentialByScheme.get(name) ?? null;
        return (
          <SchemeRow
            key={name}
            target={target}
            schemeName={name}
            scheme={scheme}
            credential={credential}
            oauthClients={oauthClients ?? []}
            onChanged={refreshAll}
          />
        );
      })}
    </div>
  );
}

function SchemeRow({
  target,
  schemeName,
  scheme,
  credential,
  oauthClients,
  onChanged,
}: {
  target: AuthTarget;
  schemeName: string;
  scheme: AuthSchemeInfo;
  credential: CredentialSummary | null;
  oauthClients: OAuthClient[];
  onChanged: () => void;
}) {
  const mapped = credentialTypeForScheme(scheme);

  return (
    <Card>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{schemeName}</span>
              <Badge variant="secondary">{schemeTypeLabel(scheme)}</Badge>
              {credential?.grantedSource ? (
                <Badge variant="outline" className="text-[10px]">
                  {credential.grantedSource === "inferred"
                    ? "scopes assumed"
                    : `granted via ${credential.grantedSource}`}
                </Badge>
              ) : null}
            </div>
            {placementHelp(scheme) ? (
              <p className="text-muted-foreground text-xs">
                {placementHelp(scheme)}
              </p>
            ) : null}
            {credential ? (
              <CredentialScopesLine credential={credential} />
            ) : null}
          </div>
        </div>

        {mapped === "apiKey" || mapped === "basic" || mapped === "bearer" ? (
          <StaticSchemeForm
            target={target}
            schemeName={schemeName}
            kind={mapped}
            credential={credential}
            onChanged={onChanged}
          />
        ) : mapped === "oauth2" ? (
          target.kind === "registry" &&
          scheme.grantTypes &&
          !scheme.grantTypes.includes("authorization_code") ? (
            <p className="text-muted-foreground text-xs">
              This scheme does not support the authorization-code flow. Use the
              machine credential below.
            </p>
          ) : (
            <OAuth2SchemeForm
              target={target}
              schemeName={schemeName}
              scheme={scheme}
              credential={credential}
              oauthClients={oauthClients}
              onChanged={onChanged}
            />
          )
        ) : (
          <p className="text-muted-foreground text-xs">
            Unsupported scheme type &apos;{scheme.type}&apos;.
          </p>
        )}

        {target.kind === "registry" &&
        scheme.type === "oauth2" &&
        scheme.grantTypes?.includes("client_credentials") ? (
          <RegistryMachineForm
            registryId={target.id}
            schemeName={schemeName}
            scheme={scheme}
            credential={credential}
            onChanged={onChanged}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

function CredentialScopesLine({
  credential,
}: {
  credential: CredentialSummary;
}) {
  if (credential.schemeType !== "oauth2") return null;
  return (
    <div className="space-y-1">
      {credential.requestedScopes.length > 0 ? (
        <p className="text-muted-foreground text-xs">
          Requested: {credential.requestedScopes.join(", ")}
        </p>
      ) : null}
      {credential.grantedScopes ? (
        <p className="text-muted-foreground text-xs">
          Granted: {credential.grantedScopes.join(", ")}
        </p>
      ) : (
        <p className="text-muted-foreground text-xs">Not yet authorized.</p>
      )}
      {credential.oauthClient ? (
        <p className="text-muted-foreground text-xs">
          Client: {credential.oauthClient.provider} (
          {credential.oauthClient.clientId})
        </p>
      ) : null}
    </div>
  );
}

function StaticSchemeForm({
  target,
  schemeName,
  kind,
  credential,
  onChanged,
}: {
  target: AuthTarget;
  schemeName: string;
  kind: StaticCredentialType;
  credential: CredentialSummary | null;
  onChanged: () => void;
}) {
  const { addNotification } = useNotification();
  const [apiKey, setApiKey] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const base = credentialsBase(target);

  const canSave =
    !isSaving &&
    (kind === "apiKey"
      ? apiKey.length > 0
      : kind === "basic"
        ? username.trim().length > 0 && password.length > 0
        : token.length > 0);

  async function handleSave() {
    setIsSaving(true);
    try {
      const path =
        kind === "apiKey"
          ? `${base}/${encodeURIComponent(schemeName)}/api-key`
          : kind === "basic"
            ? `${base}/${encodeURIComponent(schemeName)}/basic`
            : `${base}/${encodeURIComponent(schemeName)}/bearer`;
      const body =
        kind === "apiKey"
          ? { apiKey }
          : kind === "basic"
            ? { username: username.trim(), password }
            : { token };
      const result = await apiFetchJson(
        buildUrl(path),
        staticUpsertResponseSchema,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      setApiKey("");
      setUsername("");
      setPassword("");
      setToken("");
      addNotification({
        type: "success",
        title: "Success",
        message: result.replaced
          ? `Credential for '${schemeName}' replaced.`
          : `Credential for '${schemeName}' saved.`,
      });
      onChanged();
    } catch (error) {
      addNotification({
        type: "error",
        title: "Error",
        message: errorMessageFrom(error, "Failed to save credential."),
      });
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDisconnect() {
    setIsDisconnecting(true);
    try {
      await apiFetch(buildUrl(`${base}/${encodeURIComponent(schemeName)}`), {
        method: "DELETE",
      });
      addNotification({
        type: "success",
        title: "Success",
        message: `Credential for '${schemeName}' disconnected.`,
      });
      setConfirmOpen(false);
      onChanged();
    } catch (error) {
      addNotification({
        type: "error",
        title: "Error",
        message: errorMessageFrom(error, "Failed to disconnect credential."),
      });
    } finally {
      setIsDisconnecting(false);
    }
  }

  const actionButtons = (
    <>
      <Button
        type="button"
        disabled={!canSave}
        onClick={() => void handleSave()}
      >
        {isSaving ? "Saving..." : credential ? "Replace" : "Save"}
      </Button>
      <Button
        type="button"
        variant="destructive"
        disabled={!credential || isDisconnecting}
        onClick={() => setConfirmOpen(true)}
        className="gap-2"
      >
        <Unlink className="size-3.5" />
        Disconnect
      </Button>
    </>
  );

  return (
    <div className="space-y-3">
      {kind === "apiKey" ? (
        <div className="space-y-2">
          <Label htmlFor={`apikey-${target.id}-${schemeName}`}>API key</Label>
          <div className="flex gap-2">
            <Input
              id={`apikey-${target.id}-${schemeName}`}
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={credential ? "Replace stored key" : "secret"}
              className="flex-1"
            />
            {actionButtons}
          </div>
        </div>
      ) : kind === "basic" ? (
        <div className="space-y-2">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex-1 space-y-2">
              <Label htmlFor={`basic-user-${target.id}-${schemeName}`}>
                Username
              </Label>
              <Input
                id={`basic-user-${target.id}-${schemeName}`}
                autoComplete="off"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={credential ? "Replace username" : "username"}
              />
            </div>
            <div className="flex-1 space-y-2">
              <Label htmlFor={`basic-pass-${target.id}-${schemeName}`}>
                Password
              </Label>
              <Input
                id={`basic-pass-${target.id}-${schemeName}`}
                type="password"
                autoComplete="off"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="secret"
              />
            </div>
            <div className="flex items-center gap-2">{actionButtons}</div>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <Label htmlFor={`bearer-${target.id}-${schemeName}`}>Token</Label>
          <div className="flex gap-2">
            <Input
              id={`bearer-${target.id}-${schemeName}`}
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={credential ? "Replace stored token" : "secret"}
              className="flex-1"
            />
            {actionButtons}
          </div>
        </div>
      )}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect credential?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the {kind} credential for scheme &apos;{schemeName}
              &apos; on {target.kind} &apos;{target.id}&apos;. This action
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isDisconnecting}
              onClick={() => void handleDisconnect()}
            >
              {isDisconnecting ? "Disconnecting..." : "Disconnect"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ScopeMultiSelect({
  idPrefix,
  options,
  selected,
  onChange,
  description,
}: {
  idPrefix: string;
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
  description?: string;
}) {
  return (
    <div className="space-y-2">
      <Label>Scopes</Label>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            id={`${idPrefix}-scopes`}
            variant="outline"
            className="w-full justify-start font-normal"
          >
            {selected.length > 0 ? (
              <span className="truncate">{selected.join(", ")}</span>
            ) : options.length > 0 ? (
              <span className="text-muted-foreground">Select scopes</span>
            ) : (
              <span className="text-muted-foreground">No scopes available</span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72">
          <div className="max-h-56 space-y-0 overflow-auto">
            {options.length > 0 ? (
              options.map((scope) => {
                const checked = selected.includes(scope);
                return (
                  <div
                    key={scope}
                    className="hover:bg-accent flex items-start gap-2 rounded-sm px-2 py-1.5"
                  >
                    <Checkbox
                      aria-label={`Scope ${scope}`}
                      checked={checked}
                      onCheckedChange={() => {
                        const next = checked
                          ? selected.filter((s) => s !== scope)
                          : [...selected, scope];
                        onChange(next);
                      }}
                    />
                    <span className="block font-mono text-sm">{scope}</span>
                  </div>
                );
              })
            ) : (
              <p className="text-muted-foreground px-2 py-1 text-xs">
                The selected client allows unscoped flows only.
              </p>
            )}
          </div>
        </PopoverContent>
      </Popover>
      {description ? (
        <p className="text-muted-foreground text-xs">{description}</p>
      ) : null}
    </div>
  );
}

function CreateClientMiniForm({
  idPrefix,
  defaultTokenUrl,
  defaultAuthorizationUrl,
  onCreated,
  onCancel,
}: {
  idPrefix: string;
  defaultTokenUrl?: string;
  defaultAuthorizationUrl?: string;
  onCreated: (clientId: string) => void;
  onCancel: () => void;
}) {
  const { mutate } = useSWRConfig();
  const { addNotification } = useNotification();
  const [form, setForm] = useState({
    provider: "",
    clientId: "",
    clientSecret: "",
    tokenUrl: defaultTokenUrl ?? "",
    authorizationUrl: defaultAuthorizationUrl ?? "",
    clientAuthMethod: "client_secret_basic" as
      | "client_secret_basic"
      | "client_secret_post",
    redirectUris: "",
    availableScopes: "",
  });
  const [isCreating, setIsCreating] = useState(false);

  async function handleCreate() {
    if (form.provider.trim().length === 0) {
      addNotification({
        type: "error",
        title: "Error",
        message: "Provider must not be empty.",
      });
      return;
    }
    if (form.clientId.trim().length === 0) {
      addNotification({
        type: "error",
        title: "Error",
        message: "Client ID must not be empty.",
      });
      return;
    }
    if (form.clientSecret.length === 0) {
      addNotification({
        type: "error",
        title: "Error",
        message: "Client secret must not be empty.",
      });
      return;
    }
    if (!isValidHttpUrl(form.tokenUrl.trim())) {
      addNotification({
        type: "error",
        title: "Error",
        message: "Token URL must be a valid absolute http(s) URL.",
      });
      return;
    }
    if (
      form.authorizationUrl.trim().length > 0 &&
      !isValidHttpUrl(form.authorizationUrl.trim())
    ) {
      addNotification({
        type: "error",
        title: "Error",
        message: "Authorization URL must be a valid absolute http(s) URL.",
      });
      return;
    }
    for (const uri of splitList(form.redirectUris)) {
      if (!isValidHttpUrl(uri)) {
        addNotification({
          type: "error",
          title: "Error",
          message: `Redirect URI '${uri}' must be a valid absolute http(s) URL.`,
        });
        return;
      }
    }
    setIsCreating(true);
    try {
      const body: Record<string, unknown> = {
        provider: form.provider.trim(),
        clientId: form.clientId.trim(),
        clientSecret: form.clientSecret,
        tokenUrl: form.tokenUrl.trim(),
        clientAuthMethod: form.clientAuthMethod,
        availableScopes: splitList(form.availableScopes),
      };
      if (form.authorizationUrl.trim().length > 0) {
        body.authorizationUrl = form.authorizationUrl.trim();
      }
      const redirectUris = splitList(form.redirectUris);
      if (redirectUris.length > 0) body.redirectUris = redirectUris;
      const created = await apiFetchJson(
        buildUrl("/oauth-clients"),
        oauthClientCreatedSchema,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      await mutate(buildUrl("/oauth-clients"));
      addNotification({
        type: "success",
        title: "Success",
        message: "OAuth client created.",
      });
      onCreated(created.clientId);
    } catch (error) {
      addNotification({
        type: "error",
        title: "Error",
        message: errorMessageFrom(error, "Unable to create OAuth client."),
      });
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-provider`}>Provider</Label>
          <Input
            id={`${idPrefix}-provider`}
            autoComplete="off"
            value={form.provider}
            onChange={(e) =>
              setForm((f) => ({ ...f, provider: e.target.value }))
            }
            placeholder="example"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-client-id`}>Client ID</Label>
          <Input
            id={`${idPrefix}-client-id`}
            autoComplete="off"
            value={form.clientId}
            onChange={(e) =>
              setForm((f) => ({ ...f, clientId: e.target.value }))
            }
            placeholder="my-app"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-client-secret`}>Client secret</Label>
          <Input
            id={`${idPrefix}-client-secret`}
            type="password"
            autoComplete="off"
            value={form.clientSecret}
            onChange={(e) =>
              setForm((f) => ({ ...f, clientSecret: e.target.value }))
            }
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-token-url`}>Token URL</Label>
          <Input
            id={`${idPrefix}-token-url`}
            autoComplete="off"
            inputMode="url"
            value={form.tokenUrl}
            onChange={(e) =>
              setForm((f) => ({ ...f, tokenUrl: e.target.value }))
            }
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-auth-url`}>Authorization URL</Label>
          <Input
            id={`${idPrefix}-auth-url`}
            autoComplete="off"
            inputMode="url"
            value={form.authorizationUrl}
            onChange={(e) =>
              setForm((f) => ({ ...f, authorizationUrl: e.target.value }))
            }
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-redirect`}>Redirect URIs</Label>
          <Input
            id={`${idPrefix}-redirect`}
            autoComplete="off"
            value={form.redirectUris}
            onChange={(e) =>
              setForm((f) => ({ ...f, redirectUris: e.target.value }))
            }
            placeholder="http://localhost:9371/auth/callback"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-auth-method`}>Client auth method</Label>
          <Select
            value={form.clientAuthMethod}
            onValueChange={(
              value: "client_secret_basic" | "client_secret_post",
            ) => setForm((f) => ({ ...f, clientAuthMethod: value }))}
          >
            <SelectTrigger id={`${idPrefix}-auth-method`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="client_secret_basic">
                client_secret_basic
              </SelectItem>
              <SelectItem value="client_secret_post">
                client_secret_post
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-scopes`}>Available scopes</Label>
        <Input
          id={`${idPrefix}-scopes`}
          autoComplete="off"
          value={form.availableScopes}
          onChange={(e) =>
            setForm((f) => ({ ...f, availableScopes: e.target.value }))
          }
          placeholder="read, write"
        />
        <p className="text-muted-foreground text-xs">
          Comma-separated allow-list. Empty means unscoped flows only.
        </p>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          disabled={isCreating}
          onClick={() => void handleCreate()}
        >
          {isCreating ? "Creating..." : "Create"}
        </Button>
      </div>
    </div>
  );
}

function OAuth2SchemeForm({
  target,
  schemeName,
  scheme,
  credential,
  oauthClients,
  onChanged,
}: {
  target: AuthTarget;
  schemeName: string;
  scheme: AuthSchemeInfo;
  credential: CredentialSummary | null;
  oauthClients: OAuthClient[];
  onChanged: () => void;
}) {
  const { addNotification } = useNotification();
  const base = credentialsBase(target);

  const [selectedClientId, setSelectedClientId] = useState<string>(
    credential?.oauthClientId ?? "",
  );
  const [selectedScopes, setSelectedScopes] = useState<string[]>(
    credential?.requestedScopes ?? [],
  );
  const [showCreate, setShowCreate] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [isWorking, setIsWorking] = useState(false);
  const [confirmSwitchOpen, setConfirmSwitchOpen] = useState(false);
  const [pendingClientId, setPendingClientId] = useState<string | null>(null);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [pendingAuth, setPendingAuth] = useState<{
    authorizationUrl: string;
    state: string;
  } | null>(null);
  const [showManual, setShowManual] = useState(false);
  const [manualCode, setManualCode] = useState("");
  const [manualState, setManualState] = useState("");
  const [isSubmittingCode, setIsSubmittingCode] = useState(false);

  const selectedClient = useMemo(
    () => oauthClients.find((c) => c.id === selectedClientId) ?? null,
    [oauthClients, selectedClientId],
  );

  const resolveUrl = scheme.authorizationUrl
    ? buildUrl("/oauth-clients/resolve", {
        authorizationUrl: scheme.authorizationUrl,
        ...(selectedScopes.length > 0
          ? { scopes: selectedScopes.join(",") }
          : {}),
      })
    : null;

  const { data: resolveData } = useSWR(
    resolveUrl,
    (url) => apiFetchJson(url, resolveResponseSchema),
    { refreshInterval: 15000 },
  );

  const resolvedClients = resolveData?.clients ?? [];
  const recommendedClient: ResolvedClient | null =
    scheme.authorizationUrl && resolvedClients.length > 0
      ? (resolvedClients.find((c) => c.warning === null && c.scopeCompatible) ??
        resolvedClients.find((c) => c.warning === null) ??
        null)
      : null;

  const scopeOptions = useMemo(
    () =>
      selectedClient?.availableScopes ??
      recommendedClient?.availableScopes ??
      [],
    [selectedClient, recommendedClient],
  );

  const otherClients = useMemo(() => {
    const seen = new Set(resolvedClients.map((c) => c.id));
    return oauthClients.filter((c) => !seen.has(c.id));
  }, [oauthClients, resolvedClients]);

  const menuClients = useMemo(() => {
    const recommendedId = recommendedClient?.id;
    return [
      ...resolvedClients.filter((c) => c.id !== recommendedId),
      ...otherClients,
    ];
  }, [resolvedClients, otherClients, recommendedClient]);

  const effectiveClientId = selectedClientId || recommendedClient?.id || "";
  const effectiveClient: OAuthClient | ResolvedClient | null =
    selectedClient ??
    (recommendedClient
      ? (oauthClients.find((c) => c.id === recommendedClient.id) ??
        recommendedClient)
      : null);

  function signInLabel(): string {
    if (recommendedClient) {
      return `Sign in with ${recommendedClient.provider || hostnameOf(recommendedClient.tokenUrl)}`;
    }
    if (effectiveClient) {
      const provider =
        "provider" in effectiveClient ? effectiveClient.provider : "";
      const tokenUrl =
        "tokenUrl" in effectiveClient ? effectiveClient.tokenUrl : null;
      return `Sign in with ${provider || hostnameOf(tokenUrl)}`;
    }
    return "Sign in";
  }

  async function runSignIn(clientId: string) {
    const id = clientId || effectiveClientId;
    if (!id) {
      addNotification({
        type: "error",
        title: "Error",
        message: "Select an OAuth client first.",
      });
      return;
    }
    const client = oauthClients.find((c) => c.id === id);
    if (client) {
      const outside = selectedScopes.filter(
        (s) => !client.availableScopes.includes(s),
      );
      if (outside.length > 0 && client.availableScopes.length > 0) {
        addNotification({
          type: "error",
          title: "Error",
          message: `Scope(s) not permitted by this client: ${outside.join(", ")}.`,
        });
        return;
      }
      if (!client.authorizationUrl) {
        addNotification({
          type: "error",
          title: "Error",
          message:
            "The selected OAuth client has no authorization URL configured. Edit the client to add one, or pick another client.",
        });
        return;
      }
    }
    setIsWorking(true);
    try {
      const upsert = await apiFetchJson(
        buildUrl(`${base}/${encodeURIComponent(schemeName)}/oauth2`),
        oauth2UpsertResponseSchema,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ oauthClientId: id, scopes: selectedScopes }),
        },
      );
      if (upsert.warning) {
        addNotification({
          type: "error",
          title: "Unknown scopes",
          message: upsert.warning.message,
        });
      }
      const auth = await apiFetchJson(
        buildUrl(`${base}/${encodeURIComponent(schemeName)}/oauth/authorize`),
        oauthAuthorizeSchema,
        { method: "POST" },
      );
      setPendingAuth({
        authorizationUrl: auth.authorizationUrl,
        state: auth.state,
      });
      setManualState(auth.state);
      const popup = window.open(
        auth.authorizationUrl,
        "_blank",
        "width=600,height=700",
      );
      if (!popup) {
        addNotification({
          type: "error",
          title: "Popup blocked",
          message:
            "Popup blocked. Use manual code entry from the sign-in menu to continue, then paste the code.",
        });
        setShowManual(true);
        setIsWorking(false);
        return;
      }
      const listUrl = buildUrl(base);
      const start = Date.now();
      let attempts = 0;
      const timer = window.setInterval(() => {
        attempts += 1;
        void apiFetchJson(listUrl, credentialListSchema)
          .then((list) => {
            const current = list.find((c) => c.schemeName === schemeName);
            if (
              current?.grantedScopes !== null &&
              current?.grantedScopes !== undefined
            ) {
              window.clearInterval(timer);
              try {
                popup.close();
              } catch {
                // Popup may already be closed by the provider redirect.
              }
              setIsWorking(false);
              setPendingAuth(null);
              setShowManual(false);
              setManualCode("");
              addNotification({
                type: "success",
                title: "Success",
                message: "OAuth authorization completed.",
              });
              onChanged();
            } else if (Date.now() - start > 120_000 || attempts >= 60) {
              window.clearInterval(timer);
              try {
                popup.close();
              } catch {
                // Ignore close errors after timeout.
              }
              setIsWorking(false);
              addNotification({
                type: "error",
                title: "Error",
                message:
                  "Timed out waiting for OAuth authorization. If you already have a code, paste it via manual code entry from the sign-in menu.",
              });
            }
          })
          .catch(() => {
            window.clearInterval(timer);
            try {
              popup.close();
            } catch {
              // Ignore close errors on poll failure.
            }
            setIsWorking(false);
          });
      }, 2000);
    } catch (error) {
      addNotification({
        type: "error",
        title: "Error",
        message: errorMessageFrom(error, "Failed to start OAuth flow."),
      });
      setIsWorking(false);
    }
  }

  async function handleSubmitManualCode() {
    const code = manualCode.trim();
    if (code.length === 0) {
      addNotification({
        type: "error",
        title: "Error",
        message: "Authorization code must not be empty.",
      });
      return;
    }
    setIsSubmittingCode(true);
    try {
      const body: Record<string, unknown> = { code };
      const explicitState = manualState.trim();
      if (explicitState.length > 0) body.state = explicitState;
      await apiFetchJson(
        buildUrl(`${base}/${encodeURIComponent(schemeName)}/oauth/code`),
        oauthCodeResponseSchema,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      setManualCode("");
      setPendingAuth(null);
      setShowManual(false);
      addNotification({
        type: "success",
        title: "Success",
        message: "Authorization code accepted. Credential is now active.",
      });
      onChanged();
    } catch (error) {
      addNotification({
        type: "error",
        title: "Error",
        message: errorMessageFrom(
          error,
          "Failed to submit authorization code.",
        ),
      });
    } finally {
      setIsSubmittingCode(false);
    }
  }

  function requestSignIn(clientId: string) {
    if (credential && credential.schemeType === "oauth2") {
      setPendingClientId(clientId || effectiveClientId);
      setConfirmSwitchOpen(true);
      return;
    }
    void runSignIn(clientId);
  }

  function selectAndSignIn(clientId: string) {
    const full =
      oauthClients.find((c) => c.id === clientId) ??
      resolvedClients.find((c) => c.id === clientId) ??
      null;
    setSelectedClientId(clientId);
    if (full) {
      setSelectedScopes((prev) =>
        prev.filter((s) => full.availableScopes.includes(s)),
      );
    }
    requestSignIn(clientId);
  }

  async function handleDisconnect() {
    setIsDisconnecting(true);
    try {
      await apiFetch(buildUrl(`${base}/${encodeURIComponent(schemeName)}`), {
        method: "DELETE",
      });
      addNotification({
        type: "success",
        title: "Success",
        message: `Credential for '${schemeName}' disconnected.`,
      });
      setDisconnectOpen(false);
      setSelectedClientId("");
      setSelectedScopes([]);
      setPendingAuth(null);
      setManualCode("");
      setManualState("");
      setShowManual(false);
      onChanged();
    } catch (error) {
      addNotification({
        type: "error",
        title: "Error",
        message: errorMessageFrom(error, "Failed to disconnect credential."),
      });
    } finally {
      setIsDisconnecting(false);
    }
  }

  const idPrefix = `${target.kind}-${target.id}-${schemeName}`;
  const declaredScopes = declaredScopesHelp(scheme);

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <ScopeMultiSelect
            idPrefix={idPrefix}
            options={scopeOptions}
            selected={selectedScopes}
            onChange={setSelectedScopes}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ButtonGroup>
            <Button
              type="button"
              disabled={isWorking}
              onClick={() => {
                if (recommendedClient) requestSignIn(recommendedClient.id);
                else setMenuOpen(true);
              }}
              className="rounded-r-none"
            >
              {isWorking ? "Waiting..." : signInLabel()}
            </Button>
            <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="default"
                  className="rounded-l-none border-l px-2"
                  aria-label="More sign-in options"
                >
                  <ChevronDown className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-60">
                {menuClients.map((c) => (
                  <DropdownMenuItem
                    key={c.id}
                    onClick={() => selectAndSignIn(c.id)}
                  >
                    {c.provider} ({c.clientId})
                  </DropdownMenuItem>
                ))}
                {menuClients.length > 0 ? <DropdownMenuSeparator /> : null}
                <DropdownMenuItem onClick={() => setShowCreate(true)}>
                  Create new client...
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setShowManual(true)}>
                  Enter code manually...
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </ButtonGroup>
          <Button
            type="button"
            variant="destructive"
            disabled={!credential || isDisconnecting}
            onClick={() => setDisconnectOpen(true)}
            className="gap-2"
          >
            <Unlink className="size-3.5" />
            Disconnect
          </Button>
        </div>
      </div>

      <Dialog open={showManual} onOpenChange={setShowManual}>
        <DialogContent className="max-h-[90vh] overflow-y-auto gap-2">
          <DialogHeader>
            <DialogTitle>Enter authorization code</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-muted-foreground text-xs">
              If the popup is blocked or the provider shows a code instead of
              redirecting, open the authorization URL yourself, authorize, then
              paste the code below. State disambiguates concurrent attempts and
              is filled automatically.
            </p>
            {pendingAuth ? (
              <div className="space-y-2">
                <Label htmlFor={`${idPrefix}-auth-url`}>
                  Authorization URL
                </Label>
                <div className="flex gap-2">
                  <Input
                    id={`${idPrefix}-auth-url`}
                    readOnly
                    value={pendingAuth.authorizationUrl}
                    className="flex-1 font-mono text-xs"
                    onFocus={(e) => e.target.select()}
                  />
                  <CopyButton
                    value={pendingAuth.authorizationUrl}
                    variant="outline"
                    errorMessage="Unable to copy. Select the URL manually."
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="gap-1"
                    onClick={() =>
                      window.open(
                        pendingAuth.authorizationUrl,
                        "_blank",
                        "width=600,height=700",
                      )
                    }
                  >
                    <ExternalLink className="size-3.5" />
                    Open
                  </Button>
                </div>
              </div>
            ) : (
              <p className="text-muted-foreground text-xs">
                Start sign-in above to generate an authorization URL, or paste a
                code from an in-flight attempt below.
              </p>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor={`${idPrefix}-manual-code`}>
                  Authorization code
                </Label>
                <Input
                  id={`${idPrefix}-manual-code`}
                  autoComplete="off"
                  value={manualCode}
                  onChange={(e) => setManualCode(e.target.value)}
                  placeholder="paste code from provider"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={`${idPrefix}-manual-state`}>
                  State (optional)
                </Label>
                <div className="flex gap-2">
                  <Input
                    id={`${idPrefix}-manual-state`}
                    autoComplete="off"
                    value={manualState}
                    onChange={(e) => setManualState(e.target.value)}
                    placeholder={
                      pendingAuth?.state ?? "leave empty for latest pending"
                    }
                    className="flex-1 font-mono text-xs"
                  />
                  {(manualState.trim() || pendingAuth?.state) && (
                    <CopyButton
                      value={manualState.trim() || pendingAuth?.state || ""}
                      variant="outline"
                      iconOnly
                      errorMessage="Unable to copy. Select the state manually."
                    />
                  )}
                </div>
              </div>
            </div>
            <div>
              <Button
                type="button"
                disabled={isSubmittingCode || manualCode.trim().length === 0}
                onClick={() => void handleSubmitManualCode()}
              >
                {isSubmittingCode ? "Submitting..." : "Submit code"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-h-[90vh] overflow-y-auto gap-2">
          <DialogHeader>
            <DialogTitle>Create new client</DialogTitle>
          </DialogHeader>
          <CreateClientMiniForm
            idPrefix={`${idPrefix}-new`}
            defaultTokenUrl={scheme.tokenUrl}
            defaultAuthorizationUrl={scheme.authorizationUrl}
            onCreated={(id) => {
              setSelectedClientId(id);
              setSelectedScopes([]);
              setShowCreate(false);
            }}
            onCancel={() => setShowCreate(false)}
          />
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmSwitchOpen} onOpenChange={setConfirmSwitchOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace credential?</AlertDialogTitle>
            <AlertDialogDescription>
              This will disconnect the current OAuth login for scheme &apos;
              {schemeName}&apos; on {target.kind} &apos;{target.id}&apos; and
              start a new authorization. The credential id is retained and
              tokens are wiped.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmSwitchOpen(false);
                void runSignIn(pendingClientId ?? effectiveClientId);
                setPendingClientId(null);
              }}
            >
              Continue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={disconnectOpen} onOpenChange={setDisconnectOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect credential?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the OAuth2 credential for scheme &apos;{schemeName}
              &apos; on {target.kind} &apos;{target.id}&apos;. This action
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isDisconnecting}
              onClick={() => void handleDisconnect()}
            >
              {isDisconnecting ? "Disconnecting..." : "Disconnect"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function RegistryMachineForm({
  registryId,
  schemeName,
  scheme,
  credential,
  onChanged,
}: {
  registryId: string;
  schemeName: string;
  scheme: AuthSchemeInfo;
  credential: CredentialSummary | null;
  onChanged: () => void;
}) {
  const { addNotification } = useNotification();
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [isSaving, setIsSaving] = useState(false);

  const declaredScopeIds = useMemo(
    () => Object.keys(scheme.scopes ?? {}),
    [scheme.scopes],
  );

  async function handleSave() {
    if (clientId.trim().length === 0 || clientSecret.length === 0) {
      addNotification({
        type: "error",
        title: "Error",
        message: "Client ID and secret must not be empty.",
      });
      return;
    }
    setIsSaving(true);
    try {
      const body: Record<string, unknown> = {
        schemeName,
        type: "oauth2",
        grant: "client_credentials",
        clientId: clientId.trim(),
        clientSecret,
      };
      if (scopes.length > 0) body.scopes = scopes;
      const result = await apiFetchJson(
        buildUrl(`/registries/${registryId}/auth`),
        registryMachineAuthResponseSchema,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      setClientId("");
      setClientSecret("");
      setScopes([]);
      if (result.auth.status === "configured") {
        addNotification({
          type: "success",
          title: "Success",
          message: `Machine credential for '${schemeName}' saved.`,
        });
      } else {
        addNotification({
          type: "error",
          title: "Saved with errors",
          message:
            result.auth.message ??
            `Credential stored for '${schemeName}' but validation failed.`,
        });
      }
      onChanged();
    } catch (error) {
      addNotification({
        type: "error",
        title: "Error",
        message: errorMessageFrom(error, "Failed to save machine credential."),
      });
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="space-y-3 border-t pt-3">
      <p className="text-xs font-medium">
        Machine credential (client credentials)
        {credential ? (
          <span className="text-muted-foreground font-normal">
            {" "}
            — current status: {credential.status}
          </span>
        ) : null}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`cc-id-${registryId}-${schemeName}`}>Client ID</Label>
          <Input
            id={`cc-id-${registryId}-${schemeName}`}
            autoComplete="off"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="machine-client"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`cc-secret-${registryId}-${schemeName}`}>
            Client secret
          </Label>
          <Input
            id={`cc-secret-${registryId}-${schemeName}`}
            type="password"
            autoComplete="off"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
          />
        </div>
      </div>
      {declaredScopeIds.length > 0 ? (
        <ScopeMultiSelect
          idPrefix={`cc-${registryId}-${schemeName}`}
          options={declaredScopeIds}
          selected={scopes}
          onChange={setScopes}
        />
      ) : (
        <p className="text-muted-foreground text-xs">
          The registry declares no selectable scopes for this scheme.
        </p>
      )}
      <div>
        <Button
          type="button"
          disabled={isSaving}
          onClick={() => void handleSave()}
        >
          {isSaving ? "Saving..." : "Save machine credential"}
        </Button>
      </div>
    </div>
  );
}
