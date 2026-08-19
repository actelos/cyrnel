import { KeyRound, Plus, RotateCcw, Trash2 } from "lucide-react";
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

const registrySchema = z.object({
  id: z.string(),
  baseUrl: z.string(),
  lastSyncedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  authType: z.enum(["apiKey", "oauth2"]).nullable(),
  tokenExpiresAt: z.number().nullable(),
});

const registryListSchema = z.object({
  items: z.array(registrySchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});

type Registry = z.infer<typeof registrySchema>;

type AuthFormType = "none" | "apiKey" | "oauth2";

interface AuthFormState {
  type: AuthFormType;
  apiKey: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
}

const emptyAuthForm: AuthFormState = {
  type: "none",
  apiKey: "",
  clientId: "",
  clientSecret: "",
  scopes: "",
};

function authBody(form: AuthFormState): Record<string, unknown> {
  if (form.type === "apiKey") {
    return { type: "apiKey", apiKey: form.apiKey.trim() };
  }
  if (form.type === "oauth2") {
    const scopes = form.scopes
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean);
    return {
      type: "oauth2",
      clientId: form.clientId.trim(),
      clientSecret: form.clientSecret.trim(),
      ...(scopes.length > 0 ? { scopes } : {}),
    };
  }
  return {};
}

function formatTokenExpiry(expiresAt: number | null): string | null {
  if (expiresAt === null) return null;
  return new Date(expiresAt).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

const authResultSchema = z.object({
  auth: z.object({
    type: z.enum(["apiKey", "oauth2"]),
    status: z.enum(["configured", "error"]),
    headerName: z.string().nullable().optional(),
    tokenExpiresAt: z.number().nullable().optional(),
    message: z.string().nullable().optional(),
  }),
});

function authFormValid(form: AuthFormState): boolean {
  if (form.type === "apiKey") return form.apiKey.trim().length > 0;
  if (form.type === "oauth2") {
    return (
      form.clientId.trim().length > 0 && form.clientSecret.trim().length > 0
    );
  }
  return true;
}

const REGISTRY_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

const formatDateTime = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

interface AuthFieldsProps {
  form: AuthFormState;
  onChange: (form: AuthFormState) => void;
  idPrefix: string;
}

function AuthFields({ form, onChange, idPrefix }: AuthFieldsProps) {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-auth-type`}>Authentication</Label>
        <Select
          value={form.type}
          onValueChange={(value: AuthFormType) =>
            onChange({ ...form, type: value })
          }
        >
          <SelectTrigger id={`${idPrefix}-auth-type`} className="w-full">
            <SelectValue placeholder="Select authentication" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">None</SelectItem>
            <SelectItem value="apiKey">API key (header)</SelectItem>
            <SelectItem value="oauth2">OAuth2 client credentials</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-xs">
          Optional. The registry's well-known document must advertise a matching
          method; it is fetched and validated before credentials are stored.
        </p>
      </div>
      {form.type === "apiKey" ? (
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-api-key`}>API key</Label>
          <Input
            id={`${idPrefix}-api-key`}
            type="password"
            autoComplete="off"
            onChange={(event) =>
              onChange({ ...form, apiKey: event.target.value })
            }
            placeholder="secret"
            value={form.apiKey}
          />
          <p className="text-muted-foreground text-xs">
            Stored encrypted (AES-256-GCM) and sent in the header named by the
            registry's advertisement.
          </p>
        </div>
      ) : null}
      {form.type === "oauth2" ? (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-client-id`}>Client id</Label>
            <Input
              id={`${idPrefix}-client-id`}
              autoComplete="off"
              onChange={(event) =>
                onChange({ ...form, clientId: event.target.value })
              }
              placeholder="client-id"
              value={form.clientId}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-client-secret`}>Client secret</Label>
            <Input
              id={`${idPrefix}-client-secret`}
              type="password"
              autoComplete="off"
              onChange={(event) =>
                onChange({ ...form, clientSecret: event.target.value })
              }
              placeholder="secret"
              value={form.clientSecret}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-scopes`}>Scopes</Label>
            <Input
              id={`${idPrefix}-scopes`}
              autoComplete="off"
              onChange={(event) =>
                onChange({ ...form, scopes: event.target.value })
              }
              placeholder="registry:read, registry:write"
              value={form.scopes}
            />
            <p className="text-muted-foreground text-xs">
              Optional, comma-separated. Defaults to the scopes advertised by
              the registry. The token endpoint is taken from the advertisement,
              never from this form.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function RegistriesPage() {
  const { mutate } = useSWRConfig();
  const { addNotification } = useNotification();

  const [isAddOpen, setIsAddOpen] = useState(false);
  const [addId, setAddId] = useState("");
  const [addBaseUrl, setAddBaseUrl] = useState("");
  const [addAuth, setAddAuth] = useState<AuthFormState>(emptyAuthForm);
  const [isAdding, setIsAdding] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<Registry | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const [authTarget, setAuthTarget] = useState<Registry | null>(null);
  const [authForm, setAuthForm] = useState<AuthFormState>(emptyAuthForm);
  const [isSavingAuth, setIsSavingAuth] = useState(false);

  const registriesUrl = buildUrl("/registries");

  const {
    data,
    error: registriesError,
    isLoading,
  } = useSWR(registriesUrl, (url) => apiFetchJson(url, registryListSchema), {
    refreshInterval: 8000,
  });

  const registries = data?.items ?? [];

  const refreshRegistries = async () => {
    await mutate(registriesUrl);
  };

  const handleSyncRegistry = async (id: string) => {
    try {
      await apiFetch(buildUrl(`/registries/${id}/refresh`), {
        method: "POST",
      });
      await refreshRegistries();
      addNotification({
        type: "success",
        title: "Success",
        message: `Registry '${id}' refreshed.`,
      });
    } catch (error) {
      addNotification({
        type: "error",
        title: "Error",
        message: errorMessageFrom(error, "Unable to refresh registry."),
      });
    }
  };

  const addIdValid = REGISTRY_ID_PATTERN.test(addId.trim());
  const addBaseUrlValid = isValidHttpUrl(addBaseUrl.trim());
  const addAuthValid =
    addAuth.type === "none" ||
    (addAuth.type === "apiKey" && addAuth.apiKey.trim().length > 0) ||
    (addAuth.type === "oauth2" &&
      addAuth.clientId.trim().length > 0 &&
      addAuth.clientSecret.trim().length > 0);
  const canAdd =
    addBaseUrlValid &&
    (addId.trim().length === 0 || addIdValid) &&
    addAuthValid &&
    !isAdding;

  const handleAddRegistry = async () => {
    if (!addBaseUrlValid) {
      addNotification({
        type: "error",
        title: "Error",
        message: "Base URL must be a valid absolute http(s) URL.",
      });
      return;
    }
    if (addId.trim().length > 0 && !addIdValid) {
      addNotification({
        type: "error",
        title: "Error",
        message: "Registry id must be a slug matching /^[A-Za-z0-9_-]+$/.",
      });
      return;
    }
    const trimmedId = addId.trim();
    setIsAdding(true);
    try {
      const body: Record<string, unknown> = { baseUrl: addBaseUrl.trim() };
      if (trimmedId) body.id = trimmedId;
      const auth = authBody(addAuth);
      if (addAuth.type !== "none") body.auth = auth;
      await apiFetch(buildUrl("/registries"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setAddId("");
      setAddBaseUrl("");
      setAddAuth(emptyAuthForm);
      setIsAddOpen(false);
      await refreshRegistries();
      addNotification({
        type: "success",
        title: "Success",
        message: "Registry added.",
      });
    } catch (error) {
      addNotification({
        type: "error",
        title: "Error",
        message: errorMessageFrom(error, "Unable to add registry."),
      });
    } finally {
      setIsAdding(false);
    }
  };

  const handleDeleteRegistry = async () => {
    if (deleteTarget === null) return;
    setIsDeleting(true);
    try {
      await apiFetch(buildUrl(`/registries/${deleteTarget.id}`), {
        method: "DELETE",
      });
      setDeleteTarget(null);
      await refreshRegistries();
      addNotification({
        type: "success",
        title: "Success",
        message: "Registry deleted.",
      });
    } catch (error) {
      addNotification({
        type: "error",
        title: "Error",
        message: errorMessageFrom(error, "Unable to delete registry."),
      });
    } finally {
      setIsDeleting(false);
    }
  };

  const handleSaveAuth = async () => {
    if (authTarget === null) return;
    if (authForm.type !== "none" && !authFormValid(authForm)) {
      addNotification({
        type: "error",
        title: "Error",
        message: "Fill in the credential fields for the selected auth type.",
      });
      return;
    }
    setIsSavingAuth(true);
    try {
      const body = authBody(authForm);
      const response = await apiFetchJson(
        buildUrl(`/registries/${authTarget.id}/auth`),
        authResultSchema,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      setAuthTarget(null);
      setAuthForm(emptyAuthForm);
      await refreshRegistries();
      if (response.auth.status === "configured") {
        addNotification({
          type: "success",
          title: "Success",
          message: `Auth saved for '${authTarget.id}'.`,
        });
      } else {
        addNotification({
          type: "error",
          title: "Saved with errors",
          message:
            response.auth.message ??
            `Auth stored for '${authTarget.id}' but validation failed.`,
        });
      }
    } catch (error) {
      addNotification({
        type: "error",
        title: "Error",
        message: errorMessageFrom(error, "Unable to save auth."),
      });
    } finally {
      setIsSavingAuth(false);
    }
  };

  const handleRemoveAuth = async () => {
    if (authTarget === null) return;
    setIsSavingAuth(true);
    try {
      await apiFetch(buildUrl(`/registries/${authTarget.id}/auth`), {
        method: "DELETE",
      });
      setAuthTarget(null);
      setAuthForm(emptyAuthForm);
      await refreshRegistries();
      addNotification({
        type: "success",
        title: "Success",
        message: `Auth removed for '${authTarget.id}'.`,
      });
    } catch (error) {
      addNotification({
        type: "error",
        title: "Error",
        message: errorMessageFrom(error, "Unable to remove auth."),
      });
    } finally {
      setIsSavingAuth(false);
    }
  };

  const openAuthDialog = (registry: Registry) => {
    setAuthTarget(registry);
    setAuthForm({
      type: registry.authType ?? "none",
      apiKey: "",
      clientId: "",
      clientSecret: "",
      scopes: "",
    });
  };

  const closeAuthDialog = () => {
    setAuthTarget(null);
    setAuthForm(emptyAuthForm);
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">Registries</h1>
          <p className="text-muted-foreground text-sm">
            Manage the registries available to this Cyrnel server.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
            <DialogTrigger asChild>
              <Button className="gap-2" type="button">
                <Plus />
                Add registry
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add registry</DialogTitle>
                <DialogDescription>
                  Register a registry by its base URL. Its well-known discovery
                  document is fetched to resolve the registry id and
                  capabilities.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 my-2">
                <div className="space-y-2">
                  <Label htmlFor="registry-id">Id</Label>
                  <Input
                    id="registry-id"
                    onChange={(event) => setAddId(event.target.value)}
                    placeholder="github"
                    value={addId}
                  />
                  <p className="text-muted-foreground text-xs">
                    Optional — when omitted, the id advertised by the registry's
                    discovery document is used. Slug: letters, numbers, - and _.
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="registry-base-url">Base URL</Label>
                  <Input
                    id="registry-base-url"
                    onChange={(event) => setAddBaseUrl(event.target.value)}
                    placeholder="https://registry.example.com"
                    value={addBaseUrl}
                  />
                  <p className="text-muted-foreground text-xs">
                    Absolute http(s) URL; normalized before storage.
                  </p>
                </div>
                <AuthFields
                  form={addAuth}
                  onChange={setAddAuth}
                  idPrefix="add-registry"
                />
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  disabled={!canAdd}
                  onClick={() => void handleAddRegistry()}
                >
                  {isAdding ? "Adding" : "Add"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <Button
            type="button"
            variant="outline"
            className="gap-2"
            onClick={() => {
              refreshRegistries()
                .then(() => {
                  addNotification({
                    type: "success",
                    title: "Success",
                    message: "Registries refreshed.",
                  });
                })
                .catch((error) => {
                  addNotification({
                    type: "error",
                    title: "Error",
                    message: errorMessageFrom(
                      error,
                      "Failed to refresh registries.",
                    ),
                  });
                });
            }}
            aria-label="Refresh registries"
          >
            <RotateCcw />
          </Button>
        </div>
      </header>

      <Card className="flex min-h-0 flex-1 flex-col">
        <CardContent className="min-h-0 flex-1 overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Registry</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead className="w-[110px] text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {registries.map((registry) => (
                <TableRow key={registry.id} className="group">
                  <TableCell>
                    <div className="min-w-0 space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-medium">
                          {registry.id}
                        </span>
                        {registry.authType !== null ? (
                          <Badge
                            variant="outline"
                            className="font-mono text-[10px]"
                          >
                            {registry.authType}
                            {registry.authType === "oauth2" &&
                            registry.tokenExpiresAt !== null ? (
                              <span className="text-muted-foreground">
                                {" "}
                                · {formatTokenExpiry(registry.tokenExpiresAt)}
                              </span>
                            ) : null}
                          </Badge>
                        ) : null}
                      </div>
                      <p
                        className="text-muted-foreground text-xs font-mono truncate max-w-md"
                        title={registry.baseUrl}
                      >
                        {registry.baseUrl}
                      </p>
                      <p className="text-muted-foreground text-xs">
                        {registry.lastSyncedAt === null
                          ? "Never synced"
                          : `Synced ${formatDateTime(registry.lastSyncedAt)}`}
                      </p>
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                    {formatDateTime(registry.createdAt)}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                    {formatDateTime(registry.updatedAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-8"
                        aria-label={`Configure auth for registry ${registry.id}`}
                        onClick={() => openAuthDialog(registry)}
                      >
                        <KeyRound />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-8"
                        aria-label={`Refresh registry ${registry.id}`}
                        onClick={() => void handleSyncRegistry(registry.id)}
                      >
                        <RotateCcw />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-8 text-destructive"
                        aria-label={`Delete registry ${registry.id}`}
                        onClick={() => setDeleteTarget(registry)}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {registriesError ? (
            <p className="p-4 text-sm text-destructive">
              Failed to load registries.
            </p>
          ) : null}
          {!isLoading && !registriesError && registries.length === 0 ? (
            <div className="flex flex-col items-start gap-2 p-4">
              <p className="text-sm text-muted-foreground">
                No registries registered yet.
              </p>
              <p className="text-muted-foreground text-xs">
                Add a registry to make its definitions and modules available on
                this server.
              </p>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Dialog
        open={authTarget !== null}
        onOpenChange={(open) => {
          if (!open) closeAuthDialog();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Auth for {authTarget?.id ?? ""}</DialogTitle>
            <DialogDescription>
              Set or update the credentials used when this Cyrnel server talks
              to the registry. Choosing None leaves the registry
              unauthenticated.
            </DialogDescription>
          </DialogHeader>
          <div className="my-2">
            <AuthFields
              form={authForm}
              onChange={setAuthForm}
              idPrefix="registry-auth"
            />
          </div>
          <DialogFooter>
            {authTarget?.authType !== null ? (
              <Button
                type="button"
                variant="outline"
                disabled={isSavingAuth}
                onClick={() => void handleRemoveAuth()}
              >
                Remove auth
              </Button>
            ) : null}
            <Button
              type="button"
              disabled={isSavingAuth}
              onClick={() => void handleSaveAuth()}
            >
              {isSavingAuth ? "Saving" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete registry?</AlertDialogTitle>
            <AlertDialogDescription>
              Registry {deleteTarget?.id ?? ""} will be permanently removed from
              this server. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isDeleting}
              onClick={(event) => {
                event.preventDefault();
                void handleDeleteRegistry();
              }}
            >
              {isDeleting ? "Deleting" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
