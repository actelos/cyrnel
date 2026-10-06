import { useEffect, useState } from "react";
import { useSWRConfig } from "swr";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useNotification } from "@/hooks/use-notification";
import { apiFetch, apiFetchJson, buildUrl, errorMessageFrom } from "@/lib/api";

const oauthClientCreatedSchema = z.object({
  id: z.string(),
});

export interface OAuthClient {
  id: string;
  provider: string;
  clientId: string;
  tokenUrl: string;
  authorizationUrl: string | null;
  clientAuthMethod: string;
  redirectUris: string[];
  createdAt: string;
  updatedAt: string;
}

interface ClientFormState {
  provider: string;
  clientId: string;
  clientSecret: string;
  tokenUrl: string;
  authorizationUrl: string;
  clientAuthMethod: "client_secret_basic" | "client_secret_post";
  redirectUris: string;
}

type ClientAuthMethod = ClientFormState["clientAuthMethod"];

const emptyClientForm: ClientFormState = {
  provider: "",
  clientId: "",
  clientSecret: "",
  tokenUrl: "",
  authorizationUrl: "",
  clientAuthMethod: "client_secret_basic",
  redirectUris: "",
};

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

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.startsWith("127.") ||
    host.endsWith(".localhost")
  );
}

function isHttpsOrLoopbackHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "https:") return true;
    if (parsed.protocol === "http:") {
      return isLoopbackHostname(parsed.hostname);
    }
    return false;
  } catch {
    return false;
  }
}

function editFormValid(form: ClientFormState): string | null {
  if (form.provider.trim().length === 0) return "Provider must not be empty.";
  if (!isHttpsOrLoopbackHttpUrl(form.tokenUrl.trim())) {
    return "Token URL must be a valid absolute https URL (http is allowed only for loopback).";
  }
  if (
    form.authorizationUrl.trim().length > 0 &&
    !isHttpsOrLoopbackHttpUrl(form.authorizationUrl.trim())
  ) {
    return "Authorization URL must be a valid absolute https URL (http is allowed only for loopback).";
  }
  for (const uri of splitList(form.redirectUris)) {
    if (!isHttpsOrLoopbackHttpUrl(uri)) {
      return `Redirect URI '${uri}' must be a valid absolute https URL (http is allowed only for loopback).`;
    }
  }
  return null;
}

function patchBody(form: ClientFormState): Record<string, unknown> {
  const body: Record<string, unknown> = {
    provider: form.provider.trim(),
    tokenUrl: form.tokenUrl.trim(),
    clientAuthMethod: form.clientAuthMethod,
    redirectUris: splitList(form.redirectUris),
  };
  if (form.authorizationUrl.trim().length > 0) {
    body.authorizationUrl = form.authorizationUrl.trim();
  } else {
    body.authorizationUrl = null;
  }
  return body;
}

interface CreateOAuthClientDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultTokenUrl?: string;
  defaultAuthorizationUrl?: string;
  onCreated?: () => void;
}

export function CreateOAuthClientDialog({
  open,
  onOpenChange,
  defaultTokenUrl,
  defaultAuthorizationUrl,
  onCreated,
}: CreateOAuthClientDialogProps) {
  const { mutate } = useSWRConfig();
  const { addNotification } = useNotification();
  const [form, setForm] = useState({
    provider: "",
    clientId: "",
    clientSecret: "",
    tokenUrl: defaultTokenUrl ?? "",
    authorizationUrl: defaultAuthorizationUrl ?? "",
    clientAuthMethod: "client_secret_basic" as ClientAuthMethod,
    redirectUris: "",
  });
  const [isCreating, setIsCreating] = useState(false);

  async function handleCreate() {
    if (form.provider.trim().length === 0) {
      addNotification({
        type: "error",
        title: "Provider required",
        message: "Provider must not be empty.",
      });
      return;
    }
    if (form.clientId.trim().length === 0) {
      addNotification({
        type: "error",
        title: "Client ID required",
        message: "Client ID must not be empty.",
      });
      return;
    }
    if (form.clientSecret.length === 0) {
      addNotification({
        type: "error",
        title: "Client secret required",
        message: "Client secret must not be empty.",
      });
      return;
    }
    if (!isValidHttpUrl(form.tokenUrl.trim())) {
      addNotification({
        type: "error",
        title: "Invalid token URL",
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
        title: "Invalid authorization URL",
        message: "Authorization URL must be a valid absolute http(s) URL.",
      });
      return;
    }
    for (const uri of splitList(form.redirectUris)) {
      if (!isValidHttpUrl(uri)) {
        addNotification({
          type: "error",
          title: "Invalid redirect URI",
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
      };
      if (form.authorizationUrl.trim().length > 0) {
        body.authorizationUrl = form.authorizationUrl.trim();
      }
      const redirectUris = splitList(form.redirectUris);
      if (redirectUris.length > 0) body.redirectUris = redirectUris;
      const _created = await apiFetchJson(
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
        title: "OAuth client created",
        message: "OAuth client created.",
      });
      onCreated?.();
      setForm({
        provider: "",
        clientId: "",
        clientSecret: "",
        tokenUrl: defaultTokenUrl ?? "",
        authorizationUrl: defaultAuthorizationUrl ?? "",
        clientAuthMethod: "client_secret_basic",
        redirectUris: "",
      });
      onOpenChange(false);
    } catch (error) {
      addNotification({
        type: "error",
        title: "OAuth client creation failed",
        message: errorMessageFrom(error, "Unable to create OAuth client."),
      });
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto gap-2">
        <DialogHeader>
          <DialogTitle>Create new client</DialogTitle>
          <DialogDescription>
            Register an OAuth application. The client secret is encrypted at
            rest and never shown again after creation.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="create-client-provider">Provider</Label>
              <Input
                id="create-client-provider"
                autoComplete="off"
                value={form.provider}
                onChange={(e) =>
                  setForm((f) => ({ ...f, provider: e.target.value }))
                }
                placeholder="example"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-client-client-id">Client ID</Label>
              <Input
                id="create-client-client-id"
                autoComplete="off"
                value={form.clientId}
                onChange={(e) =>
                  setForm((f) => ({ ...f, clientId: e.target.value }))
                }
                placeholder="my-app"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-client-client-secret">Client secret</Label>
              <Input
                id="create-client-client-secret"
                type="password"
                autoComplete="off"
                value={form.clientSecret}
                onChange={(e) =>
                  setForm((f) => ({ ...f, clientSecret: e.target.value }))
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-client-token-url">Token URL</Label>
              <Input
                id="create-client-token-url"
                autoComplete="off"
                inputMode="url"
                value={form.tokenUrl}
                onChange={(e) =>
                  setForm((f) => ({ ...f, tokenUrl: e.target.value }))
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-client-auth-url">Authorization URL</Label>
              <Input
                id="create-client-auth-url"
                autoComplete="off"
                inputMode="url"
                value={form.authorizationUrl}
                onChange={(e) =>
                  setForm((f) => ({ ...f, authorizationUrl: e.target.value }))
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-client-redirect">Redirect URIs</Label>
              <Input
                id="create-client-redirect"
                autoComplete="off"
                value={form.redirectUris}
                onChange={(e) =>
                  setForm((f) => ({ ...f, redirectUris: e.target.value }))
                }
                placeholder="http://localhost:9371/auth/callback"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-client-auth-method">
                Client auth method
              </Label>
              <Select
                value={form.clientAuthMethod}
                onValueChange={(value: ClientAuthMethod) =>
                  setForm((f) => ({ ...f, clientAuthMethod: value }))
                }
              >
                <SelectTrigger
                  id="create-client-auth-method"
                  className="w-full"
                >
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
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              disabled={isCreating}
              onClick={() => void handleCreate()}
            >
              {isCreating ? "Creating..." : "Create"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface EditOAuthClientDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  client: OAuthClient | null;
  onUpdated?: () => void;
}

export function EditOAuthClientDialog({
  open,
  onOpenChange,
  client,
  onUpdated,
}: EditOAuthClientDialogProps) {
  const { mutate } = useSWRConfig();
  const { addNotification } = useNotification();
  const [form, setForm] = useState<ClientFormState>(emptyClientForm);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (client === null) return;
    setForm({
      provider: client.provider,
      clientId: client.clientId,
      clientSecret: "",
      tokenUrl: client.tokenUrl,
      authorizationUrl: client.authorizationUrl ?? "",
      clientAuthMethod:
        client.clientAuthMethod === "client_secret_post"
          ? "client_secret_post"
          : "client_secret_basic",
      redirectUris: client.redirectUris.join(", "),
    });
  }, [client]);

  async function handleSave() {
    if (client === null) return;
    const validationError = editFormValid(form);
    if (validationError !== null) {
      addNotification({
        type: "error",
        title: "Invalid OAuth client",
        message: validationError,
      });
      return;
    }
    setIsSaving(true);
    try {
      await apiFetch(buildUrl(`/oauth-clients/${client.id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patchBody(form)),
      });
      await mutate(buildUrl("/oauth-clients"));
      addNotification({
        type: "success",
        title: "OAuth client updated",
        message: "OAuth client updated.",
      });
      onUpdated?.();
      onOpenChange(false);
    } catch (error) {
      addNotification({
        type: "error",
        title: "OAuth client update failed",
        message: errorMessageFrom(error, "Unable to update OAuth client."),
      });
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto gap-2">
        <DialogHeader>
          <DialogTitle>Edit OAuth client</DialogTitle>
          <DialogDescription>
            Update the shared registration. Client ID and secret cannot be
            changed here.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="edit-client-provider">Provider</Label>
              <Input
                id="edit-client-provider"
                autoComplete="off"
                value={form.provider}
                onChange={(e) =>
                  setForm((f) => ({ ...f, provider: e.target.value }))
                }
                placeholder="example"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-client-client-id">Client ID</Label>
              <Input
                id="edit-client-client-id"
                autoComplete="off"
                value={form.clientId}
                disabled
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-client-token-url">Token URL</Label>
              <Input
                id="edit-client-token-url"
                autoComplete="off"
                inputMode="url"
                value={form.tokenUrl}
                onChange={(e) =>
                  setForm((f) => ({ ...f, tokenUrl: e.target.value }))
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-client-auth-url">Authorization URL</Label>
              <Input
                id="edit-client-auth-url"
                autoComplete="off"
                inputMode="url"
                value={form.authorizationUrl}
                onChange={(e) =>
                  setForm((f) => ({ ...f, authorizationUrl: e.target.value }))
                }
                placeholder="Empty to clear"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-client-redirect">Redirect URIs</Label>
              <Input
                id="edit-client-redirect"
                autoComplete="off"
                value={form.redirectUris}
                onChange={(e) =>
                  setForm((f) => ({ ...f, redirectUris: e.target.value }))
                }
                placeholder="http://localhost:9371/auth/callback"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-client-auth-method">
                Client auth method
              </Label>
              <Select
                value={form.clientAuthMethod}
                onValueChange={(value: ClientAuthMethod) =>
                  setForm((f) => ({ ...f, clientAuthMethod: value }))
                }
              >
                <SelectTrigger id="edit-client-auth-method" className="w-full">
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
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={isSaving}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={isSaving}
              onClick={() => void handleSave()}
            >
              {isSaving ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
