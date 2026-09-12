import { Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { z } from "zod";
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
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useNotification } from "@/hooks/use-notification";
import { apiFetch, apiFetchJson, buildUrl, errorMessageFrom } from "@/lib/api";

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

const oauthClientCreatedSchema = z.object({
  clientId: z.string(),
});

type OAuthClient = z.infer<typeof oauthClientSchema>;

interface ClientFormState {
  provider: string;
  clientId: string;
  clientSecret: string;
  tokenUrl: string;
  authorizationUrl: string;
  clientAuthMethod: "client_secret_basic" | "client_secret_post";
  redirectUris: string;
  availableScopes: string;
}

const emptyClientForm: ClientFormState = {
  provider: "",
  clientId: "",
  clientSecret: "",
  tokenUrl: "",
  authorizationUrl: "",
  clientAuthMethod: "client_secret_basic",
  redirectUris: "",
  availableScopes: "",
};

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

function splitList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function createFormValid(form: ClientFormState): string | null {
  if (form.provider.trim().length === 0) return "Provider must not be empty.";
  if (form.clientId.trim().length === 0) return "Client ID must not be empty.";
  if (form.clientSecret.length === 0) return "Client secret must not be empty.";
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

function createBody(form: ClientFormState): Record<string, unknown> {
  const body: Record<string, unknown> = {
    provider: form.provider.trim(),
    clientId: form.clientId.trim(),
    clientSecret: form.clientSecret,
    tokenUrl: form.tokenUrl.trim(),
    availableScopes: splitList(form.availableScopes),
  };
  if (form.authorizationUrl.trim().length > 0) {
    body.authorizationUrl = form.authorizationUrl.trim();
  }
  if (form.clientAuthMethod) {
    body.clientAuthMethod = form.clientAuthMethod;
  }
  const redirectUris = splitList(form.redirectUris);
  if (redirectUris.length > 0) body.redirectUris = redirectUris;
  return body;
}

function patchBody(form: ClientFormState): Record<string, unknown> {
  const body: Record<string, unknown> = {
    provider: form.provider.trim(),
    tokenUrl: form.tokenUrl.trim(),
    clientAuthMethod: form.clientAuthMethod,
    redirectUris: splitList(form.redirectUris),
    availableScopes: splitList(form.availableScopes),
  };
  if (form.authorizationUrl.trim().length > 0) {
    body.authorizationUrl = form.authorizationUrl.trim();
  } else {
    body.authorizationUrl = null;
  }
  return body;
}

const formatDateTime = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

function formFromClient(client: OAuthClient): ClientFormState {
  return {
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
    availableScopes: client.availableScopes.join(", "),
  };
}

export default function AuthenticationPage() {
  const { mutate } = useSWRConfig();
  const { addNotification } = useNotification();

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [createForm, setCreateForm] =
    useState<ClientFormState>(emptyClientForm);
  const [isCreating, setIsCreating] = useState(false);

  const [editTarget, setEditTarget] = useState<OAuthClient | null>(null);
  const [editForm, setEditForm] = useState<ClientFormState>(emptyClientForm);
  const [isSavingEdit, setIsSavingEdit] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<OAuthClient | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const oauthClientsUrl = buildUrl("/oauth-clients");
  const {
    data: oauthClientsData,
    error: oauthClientsError,
    isLoading,
  } = useSWR(
    oauthClientsUrl,
    (url) => apiFetchJson(url, oauthClientListSchema),
    { refreshInterval: 8000 },
  );

  const oauthClients = oauthClientsData ?? [];

  const refresh = async () => {
    await mutate(oauthClientsUrl);
  };

  const notifyError = (message: string) => {
    addNotification({ type: "error", title: "Error", message });
  };

  const handleCreate = async () => {
    const validationError = createFormValid(createForm);
    if (validationError !== null) {
      notifyError(validationError);
      return;
    }
    setIsCreating(true);
    try {
      const response = await apiFetchJson(
        buildUrl("/oauth-clients"),
        oauthClientCreatedSchema,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(createBody(createForm)),
        },
      );
      setCreateForm(emptyClientForm);
      setIsCreateOpen(false);
      await refresh();
      addNotification({
        type: "success",
        title: "Success",
        message: `OAuth client '${response.clientId}' created.`,
      });
    } catch (error) {
      notifyError(errorMessageFrom(error, "Unable to create OAuth client."));
    } finally {
      setIsCreating(false);
    }
  };

  const openEdit = (client: OAuthClient) => {
    setEditTarget(client);
    setEditForm(formFromClient(client));
  };

  const handleEdit = async () => {
    if (editTarget === null) return;
    const validationError = editFormValid(editForm);
    if (validationError !== null) {
      notifyError(validationError);
      return;
    }
    setIsSavingEdit(true);
    try {
      await apiFetch(buildUrl(`/oauth-clients/${editTarget.id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patchBody(editForm)),
      });
      setEditTarget(null);
      await refresh();
      addNotification({
        type: "success",
        title: "Success",
        message: "OAuth client updated.",
      });
    } catch (error) {
      notifyError(errorMessageFrom(error, "Unable to update OAuth client."));
    } finally {
      setIsSavingEdit(false);
    }
  };

  const handleDelete = async () => {
    if (deleteTarget === null) return;
    setIsDeleting(true);
    setDeleteError(null);
    try {
      await apiFetch(buildUrl(`/oauth-clients/${deleteTarget.id}`), {
        method: "DELETE",
      });
      setDeleteTarget(null);
      setDeleteError(null);
      await refresh();
      addNotification({
        type: "success",
        title: "Success",
        message: "OAuth client deleted.",
      });
    } catch (error) {
      const message = errorMessageFrom(error, "Unable to delete OAuth client.");
      setDeleteError(message);
      notifyError(message);
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">Authentication</h1>
          <p className="text-muted-foreground text-sm">
            Manage shared OAuth client registrations. Credentials live on their
            owning service, module, or registry.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
            <DialogTrigger asChild>
              <Button className="gap-2" type="button">
                <Plus />
                Add client
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add OAuth client</DialogTitle>
                <DialogDescription>
                  Register an OAuth application. The client secret is encrypted
                  at rest and never shown again after creation.
                </DialogDescription>
              </DialogHeader>
              <div className="my-2 space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="oauth-provider">Provider</Label>
                  <Input
                    id="oauth-provider"
                    autoComplete="off"
                    onChange={(event) =>
                      setCreateForm({
                        ...createForm,
                        provider: event.target.value,
                      })
                    }
                    placeholder="google"
                    value={createForm.provider}
                  />
                  <p className="text-muted-foreground text-xs">
                    Display label only; never used for client resolution.
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="oauth-client-id">Client ID</Label>
                  <Input
                    id="oauth-client-id"
                    autoComplete="off"
                    onChange={(event) =>
                      setCreateForm({
                        ...createForm,
                        clientId: event.target.value,
                      })
                    }
                    placeholder="my-app"
                    value={createForm.clientId}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="oauth-client-secret">Client secret</Label>
                  <Input
                    id="oauth-client-secret"
                    type="password"
                    autoComplete="off"
                    onChange={(event) =>
                      setCreateForm({
                        ...createForm,
                        clientSecret: event.target.value,
                      })
                    }
                    placeholder="secret"
                    value={createForm.clientSecret}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="oauth-token-url">Token URL</Label>
                  <Input
                    id="oauth-token-url"
                    autoComplete="off"
                    inputMode="url"
                    onChange={(event) =>
                      setCreateForm({
                        ...createForm,
                        tokenUrl: event.target.value,
                      })
                    }
                    placeholder="https://provider.example.com/token"
                    value={createForm.tokenUrl}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="oauth-authorization-url">
                    Authorization URL
                  </Label>
                  <Input
                    id="oauth-authorization-url"
                    autoComplete="off"
                    inputMode="url"
                    onChange={(event) =>
                      setCreateForm({
                        ...createForm,
                        authorizationUrl: event.target.value,
                      })
                    }
                    placeholder="https://provider.example.com/authorize"
                    value={createForm.authorizationUrl}
                  />
                  <p className="text-muted-foreground text-xs">
                    Optional. Required for authorization-code sign-in flows.
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="oauth-client-auth-method">
                    Client auth method
                  </Label>
                  <Select
                    value={createForm.clientAuthMethod}
                    onValueChange={(
                      value: ClientFormState["clientAuthMethod"],
                    ) =>
                      setCreateForm({
                        ...createForm,
                        clientAuthMethod: value,
                      })
                    }
                  >
                    <SelectTrigger
                      id="oauth-client-auth-method"
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
                <div className="space-y-2">
                  <Label htmlFor="oauth-redirect-uris">Redirect URIs</Label>
                  <Input
                    id="oauth-redirect-uris"
                    autoComplete="off"
                    inputMode="url"
                    onChange={(event) =>
                      setCreateForm({
                        ...createForm,
                        redirectUris: event.target.value,
                      })
                    }
                    placeholder="http://localhost:9371/auth/callback"
                    value={createForm.redirectUris}
                  />
                  <p className="text-muted-foreground text-xs">
                    Comma-separated. The first is used for the authorization
                    flow.
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="oauth-available-scopes">
                    Available scopes
                  </Label>
                  <Input
                    id="oauth-available-scopes"
                    autoComplete="off"
                    onChange={(event) =>
                      setCreateForm({
                        ...createForm,
                        availableScopes: event.target.value,
                      })
                    }
                    placeholder="read, write"
                    value={createForm.availableScopes}
                  />
                  <p className="text-muted-foreground text-xs">
                    Comma-separated allow-list. Empty means unscoped flows only.
                  </p>
                </div>
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  disabled={isCreating}
                  onClick={() => void handleCreate()}
                >
                  {isCreating ? "Adding" : "Add"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <Button
            type="button"
            variant="outline"
            className="gap-2"
            onClick={() => {
              refresh()
                .then(() => {
                  addNotification({
                    type: "success",
                    title: "Success",
                    message: "OAuth clients refreshed.",
                  });
                })
                .catch((error) => {
                  notifyError(
                    errorMessageFrom(error, "Failed to refresh OAuth clients."),
                  );
                });
            }}
            aria-label="Refresh OAuth clients"
          >
            <RotateCcw />
          </Button>
        </div>
      </header>

      <Card className="flex min-h-0 flex-1 flex-col">
        <CardContent className="min-h-0 flex-1 overflow-auto">
          {oauthClientsError ? (
            <p className="text-destructive p-4 text-sm">
              Failed to load OAuth clients.
            </p>
          ) : isLoading ? (
            <div className="text-muted-foreground p-4 text-center">
              Loading OAuth clients...
            </div>
          ) : oauthClients.length === 0 ? (
            <div className="flex flex-col items-start gap-2 p-4">
              <p className="text-muted-foreground text-sm">
                No OAuth clients yet.
              </p>
              <p className="text-muted-foreground text-xs">
                Create an OAuth client, then sign in from the owning service,
                module, or registry.
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Provider</TableHead>
                  <TableHead>Client ID</TableHead>
                  <TableHead>Token URL</TableHead>
                  <TableHead>Authorization URL</TableHead>
                  <TableHead>Available scopes</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="w-[100px] text-right">
                    Actions
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {oauthClients.map((client) => (
                  <TableRow key={client.id} className="group">
                    <TableCell>
                      <div className="min-w-0 space-y-1">
                        <span className="text-sm font-medium">
                          {client.provider}
                        </span>
                        <p
                          className="text-muted-foreground truncate font-mono text-xs"
                          title={client.id}
                        >
                          {client.id}
                        </p>
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {client.clientId}
                    </TableCell>
                    <TableCell className="text-muted-foreground max-w-48 truncate font-mono text-xs">
                      {client.tokenUrl}
                    </TableCell>
                    <TableCell className="text-muted-foreground max-w-48 truncate font-mono text-xs">
                      {client.authorizationUrl ?? "—"}
                    </TableCell>
                    <TableCell>
                      {client.availableScopes.length > 0 ? (
                        <div className="flex max-w-48 flex-wrap gap-1">
                          {client.availableScopes.map((scope) => (
                            <Badge
                              key={scope}
                              variant="secondary"
                              className="font-mono text-[10px]"
                            >
                              {scope}
                            </Badge>
                          ))}
                        </div>
                      ) : (
                        <span className="text-muted-foreground text-xs">
                          unscoped only
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                      {formatDateTime(client.createdAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-8"
                          aria-label={`Edit OAuth client ${client.clientId}`}
                          onClick={() => openEdit(client)}
                        >
                          <Pencil />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-8 text-destructive"
                          aria-label={`Delete OAuth client ${client.clientId}`}
                          onClick={() => {
                            setDeleteTarget(client);
                            setDeleteError(null);
                          }}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={editTarget !== null}
        onOpenChange={(open) => {
          if (!open) setEditTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit OAuth client</DialogTitle>
            <DialogDescription>
              Update the shared registration. Client ID and secret cannot be
              changed here.
            </DialogDescription>
          </DialogHeader>
          <div className="my-2 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="edit-provider">Provider</Label>
              <Input
                id="edit-provider"
                autoComplete="off"
                onChange={(event) =>
                  setEditForm({ ...editForm, provider: event.target.value })
                }
                value={editForm.provider}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-token-url">Token URL</Label>
              <Input
                id="edit-token-url"
                autoComplete="off"
                inputMode="url"
                onChange={(event) =>
                  setEditForm({ ...editForm, tokenUrl: event.target.value })
                }
                value={editForm.tokenUrl}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-authorization-url">Authorization URL</Label>
              <Input
                id="edit-authorization-url"
                autoComplete="off"
                inputMode="url"
                onChange={(event) =>
                  setEditForm({
                    ...editForm,
                    authorizationUrl: event.target.value,
                  })
                }
                placeholder="Empty to clear"
                value={editForm.authorizationUrl}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-client-auth-method">
                Client auth method
              </Label>
              <Select
                value={editForm.clientAuthMethod}
                onValueChange={(value: ClientFormState["clientAuthMethod"]) =>
                  setEditForm({ ...editForm, clientAuthMethod: value })
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
            <div className="space-y-2">
              <Label htmlFor="edit-redirect-uris">Redirect URIs</Label>
              <Input
                id="edit-redirect-uris"
                autoComplete="off"
                inputMode="url"
                onChange={(event) =>
                  setEditForm({ ...editForm, redirectUris: event.target.value })
                }
                placeholder="http://localhost:9371/auth/callback"
                value={editForm.redirectUris}
              />
              <p className="text-muted-foreground text-xs">
                Comma-separated. The first is used for the authorization flow.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-available-scopes">Available scopes</Label>
              <Input
                id="edit-available-scopes"
                autoComplete="off"
                onChange={(event) =>
                  setEditForm({
                    ...editForm,
                    availableScopes: event.target.value,
                  })
                }
                placeholder="read, write"
                value={editForm.availableScopes}
              />
              <p className="text-muted-foreground text-xs">
                Comma-separated allow-list. Empty means unscoped flows only.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setEditTarget(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={isSavingEdit}
              onClick={() => void handleEdit()}
            >
              {isSavingEdit ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null);
            setDeleteError(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete OAuth client?</AlertDialogTitle>
            <AlertDialogDescription>
              Delete OAuth client &quot;{deleteTarget?.clientId ?? ""}&quot;?
              This fails with a 409 while any service, module, or registry
              credential still references it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError ? (
            <p className="text-destructive text-sm">{deleteError}</p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isDeleting}
              onClick={(event) => {
                event.preventDefault();
                void handleDelete();
              }}
            >
              {isDeleting ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
