import {
  ChevronDown,
  ExternalLink,
  Fingerprint,
  KeyRound,
  LockKeyhole,
  Plug,
  ShieldCheck,
  Unlink,
} from "lucide-react";
import { useMemo, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { z } from "zod";
import { CopyButton } from "@/components/copy-button";
import { CreateOAuthClientDialog } from "@/components/OAuthClientDialogs";
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
import { useNotification } from "@/hooks/use-notification";
import { apiFetch, apiFetchJson, buildUrl, errorMessageFrom } from "@/lib/api";
import { cn } from "@/lib/utils";

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
  createdAt: z.string(),
  updatedAt: z.string(),
});

const oauthClientListSchema = z.array(oauthClientSchema);

const resolvedClientSchema = oauthClientSchema.extend({
  scopeCompatible: z.boolean(),
  missingScopes: z.array(z.string()).optional().default([]),
  tokenHost: z.string().nullable(),
  warning: z.string().nullable(),
  reason: z.string().optional().default(""),
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

function _splitList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function _isValidHttpUrl(value: string): boolean {
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

function SchemeTile({
  mapped,
}: {
  mapped: StaticCredentialType | "oauth2" | null;
}) {
  const Icon =
    mapped === "apiKey"
      ? KeyRound
      : mapped === "basic"
        ? LockKeyhole
        : mapped === "bearer"
          ? Fingerprint
          : mapped === "oauth2"
            ? ShieldCheck
            : Plug;
  const tint =
    mapped === "apiKey"
      ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
      : mapped === "basic"
        ? "bg-sky-500/10 text-sky-600 dark:text-sky-400"
        : mapped === "bearer"
          ? "bg-violet-500/10 text-violet-600 dark:text-violet-400"
          : mapped === "oauth2"
            ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
            : "bg-muted text-muted-foreground";
  return (
    <div
      className={cn("flex size-9 shrink-0 items-center justify-center", tint)}
    >
      <Icon className="size-4" />
    </div>
  );
}

function StatusPill({ credential }: { credential: CredentialSummary | null }) {
  if (!credential) {
    return (
      <Badge variant="outline" className="gap-1.5 text-muted-foreground">
        <span className="size-1.5 rounded-full bg-muted-foreground/50" />
        Not connected
      </Badge>
    );
  }
  const tone =
    credential.status === "active"
      ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
      : credential.status === "expired"
        ? "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-400"
        : "border-destructive/25 bg-destructive/10 text-destructive";
  const label =
    credential.status === "active"
      ? "Connected"
      : credential.status.charAt(0).toUpperCase() + credential.status.slice(1);
  return (
    <Badge variant="outline" className={cn("gap-1.5", tone)}>
      <span className="size-1.5 rounded-full bg-current" />
      {label}
    </Badge>
  );
}

function schemeSubline(
  scheme: AuthSchemeInfo,
  credential: CredentialSummary | null,
): string {
  const parts = [schemeTypeLabel(scheme)];
  if (credential?.schemeType === "oauth2" && credential.oauthClient) {
    const provider =
      credential.oauthClient.provider ||
      hostnameOf(credential.oauthClient.tokenUrl);
    parts.push(`via ${provider}`);
    const count = (credential.grantedScopes ?? credential.requestedScopes)
      .length;
    parts.push(`${count} scope${count === 1 ? "" : "s"}`);
  } else {
    const placement = placementHelp(scheme);
    if (placement) parts.push(placement);
  }
  return parts.join(" · ");
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
  const subline = schemeSubline(scheme, credential);

  return (
    <section className="border border-border bg-card">
      <div className="flex items-center gap-3 p-4">
        <SchemeTile mapped={mapped} />
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-medium">{schemeName}</span>
            <StatusPill credential={credential} />
          </div>
          <p className="truncate text-xs text-muted-foreground" title={subline}>
            {subline}
          </p>
        </div>
      </div>

      <div className="space-y-3 border-t border-border px-4 py-3">
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
      </div>
    </section>
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
        title: result.replaced
          ? `Credential for '${schemeName}' replaced`
          : `Credential for '${schemeName}' saved`,
        message: result.replaced
          ? `Credential for '${schemeName}' replaced.`
          : `Credential for '${schemeName}' saved.`,
      });
      onChanged();
    } catch (error) {
      addNotification({
        type: "error",
        title: "Credential save failed",
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
        title: `Credential for '${schemeName}' disconnected`,
        message: `Credential for '${schemeName}' disconnected.`,
      });
      setConfirmOpen(false);
      onChanged();
    } catch (error) {
      addNotification({
        type: "error",
        title: "Credential disconnect failed",
        message: errorMessageFrom(error, "Failed to disconnect credential."),
      });
    } finally {
      setIsDisconnecting(false);
    }
  }

  const actionButtons = (
    <ButtonGroup>
      <Button
        type="button"
        disabled={!canSave}
        onClick={() => void handleSave()}
      >
        {isSaving ? "Saving..." : credential ? "Replace" : "Save"}
      </Button>
      {credential ? (
        <Button
          type="button"
          variant="destructive"
          size="icon"
          disabled={isDisconnecting}
          onClick={() => setConfirmOpen(true)}
          title={`Disconnect credential for '${schemeName}'`}
          aria-label={`Disconnect credential for '${schemeName}'`}
        >
          <Unlink className="size-3.5" />
        </Button>
      ) : null}
    </ButtonGroup>
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
              className="min-w-0 flex-1"
            />
            {actionButtons}
          </div>
        </div>
      ) : kind === "basic" ? (
        <div className="space-y-2">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="min-w-0 flex-1 space-y-2">
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
            <div className="min-w-0 flex-1 space-y-2">
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
              className="min-w-0 flex-1"
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
  // Floating popover. `modal` keeps the list scrollable when this is
  // rendered inside a modal Dialog/Sheet, whose scroll lock otherwise
  // swallows wheel events in the portalled content.
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const normalizedFilter = filter.trim().toLowerCase();
  const visibleOptions =
    normalizedFilter.length === 0
      ? options
      : options.filter((scope) =>
          scope.toLowerCase().includes(normalizedFilter),
        );

  return (
    <div className="space-y-2">
      <Label>Scopes</Label>
      <div>
        <Popover
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (!next) setFilter("");
          }}
          modal
        >
          <PopoverTrigger asChild>
            <Button
              type="button"
              id={`${idPrefix}-scopes`}
              variant="outline"
              aria-expanded={open}
            >
              {selected.length > 0
                ? `Edit scopes (${selected.length})`
                : options.length > 0
                  ? "Select scopes"
                  : "No scopes available"}
              <ChevronDown
                className={cn(
                  "size-3.5 transition-transform",
                  open && "rotate-180",
                )}
              />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            sideOffset={4}
            collisionPadding={8}
            className="w-72 max-w-[calc(100vw-2rem)] p-2"
          >
            {options.length > 6 ? (
              <div className="pb-1.5">
                <Input
                  autoComplete="off"
                  placeholder="Filter scopes..."
                  aria-label="Filter scopes"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
              </div>
            ) : null}
            <div className="max-h-56 space-y-0 overflow-y-auto overscroll-contain">
              {options.length > 0 ? (
                visibleOptions.length > 0 ? (
                  visibleOptions.map((scope) => {
                    const checked = selected.includes(scope);
                    const checkboxId = `${idPrefix}-scope-${scope}`;
                    return (
                      <div
                        key={scope}
                        className="hover:bg-accent flex items-start gap-2 rounded-sm px-2 py-1.5"
                      >
                        <Checkbox
                          id={checkboxId}
                          aria-label={`Scope ${scope}`}
                          checked={checked}
                          onCheckedChange={() => {
                            const next = checked
                              ? selected.filter((s) => s !== scope)
                              : [...selected, scope];
                            onChange(next);
                          }}
                        />
                        <Label
                          htmlFor={checkboxId}
                          className="block min-w-0 flex-1 break-all font-mono text-xs"
                        >
                          {scope}
                        </Label>
                      </div>
                    );
                  })
                ) : (
                  <p className="text-muted-foreground px-2 py-1 text-xs">
                    No scopes match &quot;{filter.trim()}&quot;.
                  </p>
                )
              ) : (
                <p className="text-muted-foreground px-2 py-1 text-xs">
                  No scopes are declared by this scheme. Sign-in requires at
                  least one scope — ask the service provider which scope to
                  request.
                </p>
              )}
            </div>
            {options.length > 0 ? (
              <div className="flex items-center justify-between gap-2 pt-1.5 border-t">
                <span className="text-muted-foreground text-xs">
                  {selected.length} selected
                </span>
                <div className="flex gap-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => onChange([...options])}
                  >
                    Select All
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={() => onChange([])}
                  >
                    Clear
                  </Button>
                </div>
              </div>
            ) : null}
          </PopoverContent>
        </Popover>
      </div>
      {description ? (
        <p className="text-muted-foreground text-xs">{description}</p>
      ) : null}
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

  const schemeScopeIds = useMemo(
    () => Object.keys(scheme.scopes ?? {}),
    [scheme.scopes],
  );
  // Normalize any stored scopes to what this scheme declares: scopes
  // from a previous credential that the scheme does not know about can
  // neither be offered nor unchecked, so drop them up front (signing in
  // again stores the normalized set).
  const storedScopes = credential?.requestedScopes ?? [];
  const initialScopes =
    schemeScopeIds.length > 0
      ? storedScopes.filter((s) => schemeScopeIds.includes(s))
      : storedScopes;
  const [selectedScopes, setSelectedScopes] = useState<string[]>(initialScopes);
  // Whether the user explicitly edited the scope selection. Defaults only
  // apply until the first manual edit — after that an empty selection is
  // the user's choice (blocked with a clear message at sign-in) rather
  // than silently replaced.
  const [scopesTouched, setScopesTouched] = useState<boolean>(
    initialScopes.length > 0,
  );

  function handleScopesChange(next: string[]): void {
    setScopesTouched(true);
    setSelectedScopes(next);
  }
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

  const otherClients = useMemo(() => {
    const seen = new Set(resolvedClients.map((c) => c.id));
    return oauthClients.filter((c) => !seen.has(c.id));
  }, [oauthClients, resolvedClients]);

  // Offer exactly the scheme-declared scopes when the scheme declares
  // any: extras outside this set serve no purpose for this credential (no
  // tool can require them) and only trigger the server's unknown-scopes
  // warning. Schemes without declared scopes fall back to previously
  // requested scopes from the existing credential, if any.
  const scopeOptions = useMemo(
    () =>
      schemeScopeIds.length > 0
        ? [...schemeScopeIds]
        : [...new Set(storedScopes)],
    [schemeScopeIds, storedScopes],
  );

  // The API requires at least one scope. Until the user edits the
  // selection, fall back to the scheme-declared scopes (or all options)
  // so a plain "Sign in" click requests something meaningful instead of
  // failing validation with an empty array. An explicitly cleared
  // selection is honored as-is and blocked with a clear message.
  const defaultScopes =
    schemeScopeIds.length > 0 ? schemeScopeIds : scopeOptions;
  const effectiveScopes =
    selectedScopes.length === 0 && !scopesTouched
      ? defaultScopes
      : selectedScopes;

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
        title: "OAuth client required",
        message: "Select an OAuth client first.",
      });
      return;
    }
    const client = oauthClients.find((c) => c.id === id);
    // The API requires at least one scope. This fires only when the
    // scheme declares no scopes and none were previously requested, or
    // when the user explicitly cleared the selection.
    if (effectiveScopes.length === 0) {
      addNotification({
        type: "error",
        title: "Scope required",
        message:
          "Select at least one scope before signing in. If no scopes are listed, this scheme declares none — ask the service provider which scope to request.",
      });
      return;
    }
    // Note: requested scopes are intentionally not restricted to the
    // OAuth client's declared scopes — the API accepts any scopes and only warns
    // about ones the scheme does not declare (surfaced below).
    if (client && !client.authorizationUrl) {
      addNotification({
        type: "error",
        title: "Authorization URL missing",
        message:
          "The selected OAuth client has no authorization URL configured. Edit the client to add one, or pick another client.",
      });
      return;
    }
    setIsWorking(true);
    try {
      const upsert = await apiFetchJson(
        buildUrl(`${base}/${encodeURIComponent(schemeName)}/oauth2`),
        oauth2UpsertResponseSchema,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            oauthClientId: id,
            scopes: effectiveScopes,
          }),
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
                title: "OAuth authorization completed",
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
                title: "OAuth authorization timed out",
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
        title: "OAuth flow start failed",
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
        title: "Authorization code required",
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
        title: "Authorization code accepted",
        message: "Authorization code accepted. Credential is now active.",
      });
      onChanged();
    } catch (error) {
      addNotification({
        type: "error",
        title: "Authorization code submit failed",
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
    // Keep the user's scope picks verbatim: the API accepts any scopes
    // (warning only about scheme-undeclared ones), so narrowing to the new
    // client's list would silently drop explicitly chosen scopes.
    setSelectedClientId(clientId);
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
        title: `Credential for '${schemeName}' disconnected`,
        message: `Credential for '${schemeName}' disconnected.`,
      });
      setDisconnectOpen(false);
      setSelectedClientId("");
      setSelectedScopes([]);
      setScopesTouched(false);
      setPendingAuth(null);
      setManualCode("");
      setManualState("");
      setShowManual(false);
      onChanged();
    } catch (error) {
      addNotification({
        type: "error",
        title: "Credential disconnect failed",
        message: errorMessageFrom(error, "Failed to disconnect credential."),
      });
    } finally {
      setIsDisconnecting(false);
    }
  }

  const idPrefix = `${target.kind}-${target.id}-${schemeName}`;
  const _declaredScopes = declaredScopesHelp(scheme);

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <ScopeMultiSelect
            idPrefix={idPrefix}
            options={scopeOptions}
            selected={effectiveScopes}
            onChange={handleScopesChange}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ButtonGroup>
            <Button
              type="button"
              disabled={isWorking}
              title={recommendedClient?.reason || undefined}
              onClick={() => {
                if (recommendedClient) requestSignIn(recommendedClient.id);
                else setMenuOpen(true);
              }}
            >
              {signInLabel()}
            </Button>
            <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="default"
                  className="px-2 shadow-[inset_1px_0_0_rgb(255_255_255/25%)]"
                  aria-label="More sign-in options"
                >
                  <ChevronDown className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="w-72 max-w-[calc(100vw-2rem)]"
              >
                {menuClients.map((c) => {
                  const reason =
                    "reason" in c && typeof c.reason === "string"
                      ? c.reason
                      : "";
                  return (
                    <DropdownMenuItem
                      key={c.id}
                      onClick={() => selectAndSignIn(c.id)}
                      title={reason || undefined}
                    >
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate">
                          {c.provider} ({c.id})
                        </span>
                        {reason ? (
                          <span className="text-muted-foreground truncate text-xs">
                            {reason}
                          </span>
                        ) : null}
                      </span>
                    </DropdownMenuItem>
                  );
                })}
                {menuClients.length > 0 ? <DropdownMenuSeparator /> : null}
                <DropdownMenuItem onClick={() => setShowCreate(true)}>
                  Create new client...
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setShowManual(true)}>
                  Enter code manually...
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {credential ? (
              <Button
                type="button"
                variant="destructive"
                size="icon"
                disabled={isDisconnecting}
                onClick={() => setDisconnectOpen(true)}
                title={`Disconnect credential for '${schemeName}'`}
                aria-label={`Disconnect credential for '${schemeName}'`}
              >
                <Unlink className="size-3.5" />
              </Button>
            ) : null}
          </ButtonGroup>
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

      <CreateOAuthClientDialog
        open={showCreate}
        onOpenChange={setShowCreate}
        defaultTokenUrl={scheme.tokenUrl}
        defaultAuthorizationUrl={scheme.authorizationUrl}
        onCreated={() => {
          setShowCreate(false);
        }}
      />

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
        title: "Client credentials required",
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
          title: `Machine credential for '${schemeName}' saved`,
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
        title: "Machine credential save failed",
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
