import { Plus, RotateCcw, Trash2 } from "lucide-react";
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
});

const registryListSchema = z.object({
  items: z.array(registrySchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});

type Registry = z.infer<typeof registrySchema>;

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

export default function RegistriesPage() {
  const { mutate } = useSWRConfig();
  const { addNotification } = useNotification();

  const [isAddOpen, setIsAddOpen] = useState(false);
  const [addId, setAddId] = useState("");
  const [addBaseUrl, setAddBaseUrl] = useState("");
  const [isAdding, setIsAdding] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<Registry | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

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
  const canAdd =
    addBaseUrlValid && (addId.trim().length === 0 || addIdValid) && !isAdding;

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
      const body: Record<string, string> = { baseUrl: addBaseUrl.trim() };
      if (trimmedId) body.id = trimmedId;
      await apiFetch(buildUrl("/registries"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setAddId("");
      setAddBaseUrl("");
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
                      <span className="font-mono text-sm font-medium">
                        {registry.id}
                      </span>
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
