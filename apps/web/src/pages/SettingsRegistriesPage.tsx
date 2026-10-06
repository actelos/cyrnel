import { KeyRound, Library, Plus, RotateCcw, Star, Trash2 } from "lucide-react";
import { useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { z } from "zod";
import {
  AddRegistryPopover,
  RegistryAuthDialog,
} from "@/components/add-registry-dialog";
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
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
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
  isDefault: z.boolean(),
  lastSyncedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  configuredSchemes: z.array(z.string()).optional(),
});

const registryListSchema = z.object({
  items: z.array(registrySchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});

type Registry = z.infer<typeof registrySchema>;

const formatDateTime = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

export default function SettingsRegistriesPage() {
  const { mutate } = useSWRConfig();
  const { addNotification } = useNotification();

  const [deleteTarget, setDeleteTarget] = useState<Registry | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const [authTarget, setAuthTarget] = useState<Registry | null>(null);

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
        title: `Registry '${id}' refreshed`,
        message: `Registry '${id}' refreshed.`,
      });
    } catch (error) {
      addNotification({
        type: "error",
        title: "Registry refresh failed",
        message: errorMessageFrom(error, "Unable to refresh registry."),
      });
    }
  };

  const [settingDefaultId, setSettingDefaultId] = useState<string | null>(null);

  const handleSetDefaultRegistry = async (id: string) => {
    setSettingDefaultId(id);
    try {
      await apiFetch(buildUrl(`/registries/${id}/default`), {
        method: "POST",
      });
      await refreshRegistries();
      addNotification({
        type: "success",
        title: "Default registry updated",
        message: `Registry '${id}' is now the default.`,
      });
    } catch (error) {
      addNotification({
        type: "error",
        title: "Default registry update failed",
        message: errorMessageFrom(error, "Unable to set default registry."),
      });
    } finally {
      setSettingDefaultId(null);
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
        title: "Registry deleted",
        message: "Registry deleted.",
      });
    } catch (error) {
      addNotification({
        type: "error",
        title: "Registry deletion failed",
        message: errorMessageFrom(error, "Unable to delete registry."),
      });
    } finally {
      setIsDeleting(false);
    }
  };

  const openAuthDialog = (registry: Registry) => {
    setAuthTarget(registry);
  };

  const closeAuthDialog = () => {
    setAuthTarget(null);
  };

  const handleRemoveAllAuth = async () => {
    if (authTarget === null) return;
    // Silent: RegistryAuthDialog shows the success/error toast and refreshes.
    await apiFetch(buildUrl(`/registries/${authTarget.id}/auth`), {
      method: "DELETE",
    });
  };

  return (
    <>
      <section className="flex h-svh flex-col px-6 pb-6">
        <header className="sticky top-0 z-10 -mx-6 flex justify-between items-end gap-4 border-b bg-background px-6 py-4 mb-6">
          <div className="space-y-1">
            <h1 className="text-xl font-semibold">Registries</h1>
            <p className="text-muted-foreground text-sm">
              Manage the registries available.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <AddRegistryPopover
              onAdded={async (registry) => {
                await refreshRegistries();
                if (
                  registry.authSchemes &&
                  Object.keys(registry.authSchemes).length > 0
                ) {
                  openAuthDialog({
                    id: registry.id,
                    baseUrl: registry.baseUrl,
                  } as Registry);
                }
              }}
            >
              <Button className="gap-2" type="button">
                <Plus />
                Add registry
              </Button>
            </AddRegistryPopover>
            <Button
              type="button"
              variant="outline"
              className="gap-2"
              onClick={() => {
                refreshRegistries()
                  .then(() => {
                    addNotification({
                      type: "success",
                      title: "Registries refreshed",
                      message: "Registries refreshed.",
                    });
                  })
                  .catch((error) => {
                    addNotification({
                      type: "error",
                      title: "Refresh registries failed",
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
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto [&_[data-slot='table-container']]:overflow-visible">
          {isLoading ? (
            <div className="flex items-center justify-center h-full py-12">
              <p className="text-sm text-muted-foreground">
                Loading registries…
              </p>
            </div>
          ) : registriesError ? (
            <p className="text-destructive p-4 text-sm">
              Failed to load registries.
            </p>
          ) : registries.length === 0 ? (
            <div className="flex items-center justify-center h-full py-12">
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Library aria-hidden />
                  </EmptyMedia>
                  <EmptyTitle>No registries registered</EmptyTitle>
                  <EmptyDescription>
                    Add a registry to make its definitions and modules available
                    on this server.
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <AddRegistryPopover
                    align="center"
                    onAdded={async (registry) => {
                      await refreshRegistries();
                      if (
                        registry.authSchemes &&
                        Object.keys(registry.authSchemes).length > 0
                      ) {
                        openAuthDialog({
                          id: registry.id,
                          baseUrl: registry.baseUrl,
                        } as Registry);
                      }
                    }}
                  >
                    <Button type="button" size="sm">
                      <Plus />
                      Add registry
                    </Button>
                  </AddRegistryPopover>
                </EmptyContent>
              </Empty>
            </div>
          ) : (
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-background">
                <TableRow>
                  <TableHead>Registry</TableHead>
                  <TableHead className="max-w-40">URL</TableHead>
                  <TableHead className="w-[110px] text-right">
                    Actions
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {registries.map((registry) => {
                  const configured = registry.configuredSchemes ?? [];
                  return (
                    <TableRow key={registry.id}>
                      <TableCell>
                        <div className="min-w-0 space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-sm font-medium">
                              {registry.id}
                            </span>
                            {configured.map((scheme) => (
                              <Badge
                                key={scheme}
                                variant="outline"
                                className="font-mono text-[10px]"
                              >
                                {scheme}
                              </Badge>
                            ))}
                          </div>
                          <p className="text-muted-foreground text-xs">
                            {registry.lastSyncedAt === null
                              ? "Never synced"
                              : `Synced ${formatDateTime(registry.lastSyncedAt)}`}
                          </p>
                        </div>
                      </TableCell>
                      <TableCell
                        className="font-mono text-xs max-w-40 truncate"
                        title={registry.baseUrl}
                      >
                        {registry.baseUrl}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-8"
                            aria-label={
                              registry.isDefault
                                ? `${registry.id} is the default registry`
                                : `Set ${registry.id} as default registry`
                            }
                            title={
                              registry.isDefault
                                ? "Default registry"
                                : "Set as default"
                            }
                            disabled={
                              registry.isDefault || settingDefaultId !== null
                            }
                            onClick={() =>
                              void handleSetDefaultRegistry(registry.id)
                            }
                          >
                            <Star
                              className={
                                registry.isDefault ? "fill-current" : undefined
                              }
                            />
                          </Button>
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
                  );
                })}
              </TableBody>
            </Table>
          )}
        </div>
      </section>

      <RegistryAuthDialog
        open={authTarget !== null}
        onOpenChange={closeAuthDialog}
        registryId={authTarget?.id ?? null}
        onRemoveAll={handleRemoveAllAuth}
        onAuthUpdated={refreshRegistries}
      />

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
              {deleteTarget?.isDefault
                ? " It is the default registry, so the oldest remaining registry will become the new default."
                : ""}
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
    </>
  );
}
