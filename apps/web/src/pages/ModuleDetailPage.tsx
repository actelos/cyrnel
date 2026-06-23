import { ArrowLeft, ChevronDown, Circle, Loader2, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { useNavigate, useParams } from "react-router-dom";
import remarkGfm from "remark-gfm";
import useSWR, { useSWRConfig } from "swr";
import { z } from "zod";
import JsonSchemaForm from "@/components/JsonSchemaForm";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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

const moduleTypeSchema = z.enum(["adapter", "environment"]);

const moduleDetailSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: moduleTypeSchema,
  description: z.string(),
  hash: z.string(),
  source: z.string(),
  isBuiltin: z.boolean(),
  enabled: z.boolean(),
  missing: z.boolean(),
  configSchema: z.record(z.string(), z.unknown()),
  secretsSchema: z.record(z.string(), z.unknown()),
});

const moduleConfigSchema = z.object({
  config: z.record(z.string(), z.unknown()),
});

const moduleConfigSchemaSchema = z.object({
  configSchema: z.record(z.string(), z.unknown()),
});

const moduleSecretsSchemaSchema = z.object({
  secretsSchema: z.record(z.string(), z.unknown()),
});

export default function ModuleDetailPage() {
  const { moduleId } = useParams<{ moduleId: string }>();
  const navigate = useNavigate();
  const { mutate } = useSWRConfig();

  const { addNotification } = useNotification();
  const [togglingModuleId, setTogglingModuleId] = useState<string | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
  const [isUpdateDialogOpen, setIsUpdateDialogOpen] = useState(false);
  const [hasUpdate, setHasUpdate] = useState(false);
  const [isManualUpdateOpen, setIsManualUpdateOpen] = useState(false);
  const [manualUpdateUrl, setManualUpdateUrl] = useState("");
  const [isManualUpdating, setIsManualUpdating] = useState(false);

  const configUrl = moduleId ? buildUrl(`/modules/${moduleId}/config`) : null;

  const configSchemaUrl = moduleId
    ? buildUrl(`/modules/${moduleId}/config/schema`)
    : null;

  const secretsSchemaUrl = moduleId
    ? buildUrl(`/modules/${moduleId}/secrets/schema`)
    : null;

  const moduleDetailUrl = moduleId ? buildUrl(`/modules/${moduleId}`) : null;

  const { data: moduleDetail } = useSWR(
    moduleDetailUrl,
    (url) => apiFetchJson(url, moduleDetailSchema),
    { refreshInterval: 8000 },
  );

  const { data: updateCheck } = useSWR(
    moduleDetail?.source ? `module-update-${moduleId}` : null,
    async () => {
      if (!moduleDetail?.source) return { hasUpdate: false };
      try {
        const res = await fetch(moduleDetail.source);
        const data = (await res.json()) as { hash?: string };
        if (!data.hash) return { hasUpdate: false };
        return { hasUpdate: data.hash !== moduleDetail.hash };
      } catch {
        return { hasUpdate: false };
      }
    },
    { refreshInterval: 120_000 },
  );

  useEffect(() => {
    if (updateCheck) {
      setHasUpdate(updateCheck.hasUpdate);
    }
  }, [updateCheck]);

  const { data: moduleConfig } = useSWR(
    configUrl,
    (url) => apiFetchJson(url, moduleConfigSchema),
    { refreshInterval: 8000 },
  );

  const { data: moduleConfigSchemaPayload } = useSWR(
    configSchemaUrl,
    (url) => apiFetchJson(url, moduleConfigSchemaSchema),
    { refreshInterval: 8000 },
  );

  const { data: moduleSecretsSchemaPayload } = useSWR(
    secretsSchemaUrl,
    (url) => apiFetchJson(url, moduleSecretsSchemaSchema),
    { refreshInterval: 8000 },
  );

  const handleRefetchAll = async () => {
    if (configUrl) await mutate(configUrl);
    if (secretsSchemaUrl) await mutate(secretsSchemaUrl);
    if (configSchemaUrl) await mutate(configSchemaUrl);
    if (moduleDetailUrl) await mutate(moduleDetailUrl);
    await mutate(buildUrl("/modules"));
  };

  const handleSetEnabled = async (id: string, enabled: boolean) => {
    setTogglingModuleId(id);
    try {
      await apiFetch(buildUrl(`/modules/${id}/enabled`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });

      await mutate(buildUrl("/modules"));
      if (moduleDetailUrl) {
        await mutate(moduleDetailUrl);
      }
      if (configUrl) {
        await mutate(configUrl);
      }
      addNotification({
        type: "success",
        title: "Success",
        message: `Module ${enabled ? "enabled" : "disabled"}.`,
      });
    } catch (error) {
      addNotification({
        type: "error",
        title: "Error",
        message: errorMessageFrom(error, "Unable to update module state."),
      });
    } finally {
      setTogglingModuleId(null);
    }
  };

  // removed: handleSaveConfiguration and handleSaveSecrets — handled by JsonSchemaForm

  const handleCheckForUpdate = async () => {
    if (!moduleDetail?.source) {
      setIsManualUpdateOpen(true);
      return;
    }

    setIsCheckingUpdate(true);
    try {
      const res = await fetch(moduleDetail.source);
      const data = (await res.json()) as { hash?: string };

      if (data.hash && data.hash === moduleDetail.hash) {
        addNotification({
          type: "success",
          title: "Up to date",
          message: "Module is up to date.",
        });
        setHasUpdate(false);
        return;
      }

      setHasUpdate(true);
      setIsUpdateDialogOpen(true);
    } catch (error) {
      addNotification({
        type: "error",
        title: "Error",
        message: errorMessageFrom(error, "Unable to check for updates."),
      });
    } finally {
      setIsCheckingUpdate(false);
    }
  };

  const handleConfirmUpdate = async (id: string) => {
    setIsUpdating(true);
    setIsUpdateDialogOpen(false);
    try {
      await apiFetch(buildUrl(`/modules/${id}/update`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (moduleDetailUrl) {
        await mutate(moduleDetailUrl);
      }
      await mutate(buildUrl("/modules"));
      addNotification({
        type: "success",
        title: "Success",
        message: "Module updated.",
      });
    } catch (error) {
      addNotification({
        type: "error",
        title: "Error",
        message: errorMessageFrom(error, "Unable to update module."),
      });
    } finally {
      setIsUpdating(false);
    }
  };

  const handleManualUpdate = async (id: string) => {
    const trimmed = manualUpdateUrl.trim();
    if (!trimmed) {
      addNotification({
        type: "error",
        title: "Error",
        message: "URL is required.",
      });
      return;
    }
    setIsManualUpdating(true);
    try {
      await apiFetch(buildUrl(`/modules/${id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: trimmed }),
      });
      setManualUpdateUrl("");
      setIsManualUpdateOpen(false);
      if (moduleDetailUrl) {
        await mutate(moduleDetailUrl);
      }
      await mutate(buildUrl("/modules"));
      addNotification({
        type: "success",
        title: "Success",
        message: "Module updated.",
      });
    } catch (error) {
      addNotification({
        type: "error",
        title: "Error",
        message: errorMessageFrom(error, "Unable to update module."),
      });
    } finally {
      setIsManualUpdating(false);
    }
  };

  const handleDelete = async (id: string) => {
    setIsDeleting(true);
    try {
      await apiFetch(buildUrl(`/modules/${id}`), {
        method: "DELETE",
      });
      await mutate(buildUrl("/modules"));
      addNotification({
        type: "success",
        title: "Success",
        message: "Module deleted.",
      });
      navigate("/modules");
    } catch (error) {
      addNotification({
        type: "error",
        title: "Error",
        message: errorMessageFrom(error, "Unable to delete module."),
      });
    } finally {
      setIsDeleting(false);
    }
  };

  if (!moduleId) {
    navigate("/modules");
    return null;
  }

  if (!moduleDetail) {
    return (
      <section className="flex min-h-0 flex-1 flex-col gap-6 p-6 h-screen overflow-hidden">
        <header>
          <Button
            type="button"
            variant="ghost"
            onClick={() => navigate("/modules")}
            className="gap-2"
          >
            <ArrowLeft />
            Back to Modules
          </Button>
        </header>
        <div className="flex items-center justify-center flex-1">
          <Loader2 className="animate-spin" />
        </div>
      </section>
    );
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-6 p-6 h-screen overflow-hidden">
      <header>
        <Button
          type="button"
          variant="ghost"
          onClick={() => navigate("/modules")}
          className="gap-2"
        >
          <ArrowLeft />
          Back to Modules
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-6">
        <Card>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-semibold">{moduleDetail.name}</h2>
                <Badge variant="secondary">{moduleDetail.type}</Badge>
                {moduleDetail.isBuiltin ? (
                  <Badge variant="outline">built-in</Badge>
                ) : null}
                {moduleDetail.missing ? (
                  <Badge variant="destructive">missing</Badge>
                ) : null}
              </div>
              <p className="text-muted-foreground text-xs font-mono">
                {moduleDetail.id}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant={moduleDetail.enabled ? "outline" : "default"}
                  disabled={
                    togglingModuleId === moduleDetail.id || moduleDetail.missing
                  }
                  onClick={() =>
                    void handleSetEnabled(
                      moduleDetail.id,
                      !moduleDetail.enabled,
                    )
                  }
                >
                  {moduleDetail.enabled ? "Disable" : "Enable"}
                </Button>
                {!moduleDetail.isBuiltin ? (
                  <>
                    {moduleDetail.source ? (
                      <div className="flex items-center">
                        <Button
                          type="button"
                          variant="outline"
                          disabled={isUpdating || isCheckingUpdate}
                          onClick={() => void handleCheckForUpdate()}
                          className="rounded-r-none"
                          aria-label={
                            isUpdating ? "Updating module" : "Check for update"
                          }
                        >
                          {hasUpdate ? (
                            <Circle className="fill-amber-500 text-amber-500" />
                          ) : null}
                          {isCheckingUpdate ? (
                            <Loader2 className="animate-spin" />
                          ) : isUpdating ? (
                            <Loader2 className="animate-spin" />
                          ) : (
                            "Check for update"
                          )}
                        </Button>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              type="button"
                              variant="outline"
                              className="rounded-l-none border-l-0 px-2"
                              disabled={isUpdating || isCheckingUpdate}
                            >
                              <ChevronDown />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              onClick={() => void handleCheckForUpdate()}
                            >
                              Check for update
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => setIsManualUpdateOpen(true)}
                            >
                              Manual update
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    ) : (
                      <Popover
                        open={isManualUpdateOpen}
                        onOpenChange={setIsManualUpdateOpen}
                      >
                        <PopoverTrigger asChild>
                          <Button type="button" variant="outline">
                            Manual update
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent align="end" className="w-md">
                          <div className="space-y-4">
                            <div className="space-y-1">
                              <h3 className="text-sm font-medium">
                                Manual update
                              </h3>
                              <p className="text-muted-foreground text-xs">
                                Provide a new archive URL.
                              </p>
                            </div>
                            <div className="space-y-2">
                              <Label htmlFor="module-update-url">
                                Archive URL
                              </Label>
                              <Input
                                id="module-update-url"
                                onChange={(event) =>
                                  setManualUpdateUrl(event.target.value)
                                }
                                placeholder="https://example.com/module.tar.zst"
                                value={manualUpdateUrl}
                              />
                            </div>
                            <div className="flex items-center justify-end gap-2">
                              <Button
                                type="button"
                                variant="outline"
                                onClick={() => setIsManualUpdateOpen(false)}
                              >
                                Cancel
                              </Button>
                              <Button
                                type="button"
                                disabled={
                                  isManualUpdating || !manualUpdateUrl.trim()
                                }
                                onClick={() =>
                                  void handleManualUpdate(moduleDetail.id)
                                }
                              >
                                {isManualUpdating ? "Updating" : "Update"}
                              </Button>
                            </div>
                          </div>
                        </PopoverContent>
                      </Popover>
                    )}
                    <Button
                      type="button"
                      variant="destructive"
                      disabled={isDeleting}
                      onClick={() => {
                        setIsDeleteDialogOpen(true);
                      }}
                      aria-label={
                        isDeleting ? "Deleting module" : "Delete module"
                      }
                    >
                      {isDeleting ? (
                        <Loader2 className="animate-spin" />
                      ) : (
                        <Trash2 />
                      )}
                    </Button>
                  </>
                ) : null}
              </div>
              {moduleDetail.description ? (
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    p: ({ children }) => (
                      <p className="text-muted-foreground text-sm">
                        {children}
                      </p>
                    ),
                  }}
                >
                  {moduleDetail.description}
                </ReactMarkdown>
              ) : (
                <p className="text-muted-foreground text-sm">No description</p>
              )}
            </div>
          </CardContent>
        </Card>

        <div className="max-h-[calc(100vh-3rem)] flex flex-col lg:flex-row gap-6">
          <JsonSchemaForm
            title="Configuration"
            schema={moduleConfigSchemaPayload?.configSchema ?? {}}
            currentValues={
              (moduleConfig?.config ?? {}) as Record<string, unknown>
            }
            patchUrl={buildUrl(`/modules/${moduleDetail.id}/config`)}
            onSaved={handleRefetchAll}
          />
          <JsonSchemaForm
            title="Secrets"
            schema={moduleSecretsSchemaPayload?.secretsSchema ?? {}}
            currentValues={{} as Record<string, unknown>}
            patchUrl={buildUrl(`/modules/${moduleDetail.id}/secrets`)}
            onSaved={handleRefetchAll}
          />
        </div>
      </div>
      <AlertDialog
        open={isUpdateDialogOpen}
        onOpenChange={(open) => {
          setIsUpdateDialogOpen(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Update available</AlertDialogTitle>
            <AlertDialogDescription>
              A new version of this module is available. Update now?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                void handleConfirmUpdate(moduleDetail.id);
              }}
            >
              Update
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={isDeleteDialogOpen}
        onOpenChange={(open) => {
          setIsDeleteDialogOpen(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete module?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove the module and all its services.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                void handleDelete(moduleDetail.id);
                setIsDeleteDialogOpen(false);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
