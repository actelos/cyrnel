import { ArrowLeft, Loader2, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { useNavigate, useParams } from "react-router-dom";
import remarkGfm from "remark-gfm";
import useSWR, { useSWRConfig } from "swr";
import { z } from "zod";
import ConfigEditor from "@/components/ConfigEditor";
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
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
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
  orphaned: z.boolean(),
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
  const [configDraft, setConfigDraft] = useState<string>("{\n  \n}");
  const [configDraftError, setConfigDraftError] = useState<string | null>(null);
  const [isSavingConfig, setIsSavingConfig] = useState(false);
  const [secretsDraft, setSecretsDraft] = useState<string>("{\n  \n}");
  const [secretsDraftError, setSecretsDraftError] = useState<string | null>(
    null,
  );
  const [isSavingSecrets, setIsSavingSecrets] = useState(false);

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

  const currentConfigDisplay = JSON.stringify(
    moduleConfig?.config ?? {},
    null,
    2,
  );

  useEffect(() => {
    if (!moduleId) return;

    setConfigDraftError(null);
    const normalized = JSON.stringify(moduleConfig?.config ?? {}, null, 2);
    setConfigDraft(normalized);
  }, [moduleId, moduleConfig?.config]);

  useEffect(() => {
    if (!moduleId) return;

    setSecretsDraftError(null);
    setSecretsDraft("{\n  \n}");
  }, [moduleId]);

  const escapeJsonPointer = (value: string) =>
    value.replace(/~/g, "~0").replace(/\//g, "~1");

  const buildPatchFromObject = (
    current: Record<string, unknown>,
    next: Record<string, unknown>,
  ): Array<Record<string, unknown>> => {
    const patch: Array<Record<string, unknown>> = [];

    for (const key of Object.keys(current)) {
      if (!Object.hasOwn(next, key)) {
        patch.push({ op: "remove", path: `/${escapeJsonPointer(key)}` });
      }
    }

    for (const [key, value] of Object.entries(next)) {
      const op = Object.hasOwn(current, key) ? "replace" : "add";
      if (
        Object.hasOwn(current, key) &&
        JSON.stringify(current[key]) === JSON.stringify(value)
      ) {
        continue;
      }
      patch.push({ op, path: `/${escapeJsonPointer(key)}`, value });
    }

    return patch;
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

  const handleSaveConfiguration = async (id: string) => {
    setConfigDraftError(null);

    let desiredConfig: unknown;
    try {
      desiredConfig = JSON.parse(configDraft);
    } catch (error) {
      setConfigDraftError(
        error instanceof Error
          ? error.message
          : "Configuration is not valid JSON.",
      );
      return;
    }

    let patch: Array<Record<string, unknown>>;

    if (Array.isArray(desiredConfig)) {
      patch = desiredConfig as Array<Record<string, unknown>>;
    } else {
      if (!desiredConfig || typeof desiredConfig !== "object") {
        setConfigDraftError(
          "Configuration must be a JSON object or JSON Patch array.",
        );
        return;
      }

      patch = buildPatchFromObject(
        (moduleConfig?.config ?? {}) as Record<string, unknown>,
        desiredConfig as Record<string, unknown>,
      );
    }

    setIsSavingConfig(true);
    try {
      const saved = await apiFetchJson(
        buildUrl(`/modules/${id}/config`),
        moduleConfigSchema,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        },
      );
      const normalized = JSON.stringify(saved.config ?? {}, null, 2);
      setConfigDraft(normalized);

      if (configUrl) await mutate(configUrl, saved, { revalidate: true });
      await mutate(buildUrl("/modules"));
      addNotification({
        type: "success",
        title: "Success",
        message: "Configuration saved.",
      });
    } catch (error) {
      addNotification({
        type: "error",
        title: "Error",
        message: errorMessageFrom(error, "Unable to save configuration."),
      });
    } finally {
      setIsSavingConfig(false);
    }
  };

  const handleSaveSecrets = async (id: string) => {
    setSecretsDraftError(null);

    let desiredSecrets: unknown;
    try {
      desiredSecrets = JSON.parse(secretsDraft);
    } catch (error) {
      setSecretsDraftError(
        error instanceof Error ? error.message : "Secrets are not valid JSON.",
      );
      return;
    }

    const patch: Array<Record<string, unknown>> = [];

    if (Array.isArray(desiredSecrets)) {
      patch.push(...(desiredSecrets as Array<Record<string, unknown>>));
    } else {
      if (!desiredSecrets || typeof desiredSecrets !== "object") {
        setSecretsDraftError(
          "Secrets must be a JSON object or JSON Patch array.",
        );
        return;
      }

      patch.push({ op: "replace", path: "", value: desiredSecrets });
    }

    setIsSavingSecrets(true);
    try {
      await apiFetch(buildUrl(`/modules/${id}/secrets`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });

      setSecretsDraft("{\n  \n}");
      await mutate(buildUrl("/modules"));
      addNotification({
        type: "success",
        title: "Success",
        message: "Secrets saved.",
      });
    } catch (error) {
      addNotification({
        type: "error",
        title: "Error",
        message: errorMessageFrom(error, "Unable to save secrets."),
      });
    } finally {
      setIsSavingSecrets(false);
    }
  };

  const handleUpdate = async (id: string) => {
    setIsUpdating(true);
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
                {moduleDetail.orphaned ? (
                  <Badge variant="destructive">orphaned</Badge>
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
                    togglingModuleId === moduleDetail.id ||
                    (!moduleDetail.enabled && moduleDetail.orphaned)
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
                    <Button
                      type="button"
                      variant="outline"
                      disabled={isUpdating}
                      onClick={() => void handleUpdate(moduleDetail.id)}
                      aria-label={
                        isUpdating ? "Updating module" : "Update module"
                      }
                    >
                      {isUpdating ? (
                        <Loader2 className="animate-spin" />
                      ) : (
                        "Update"
                      )}
                    </Button>
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
          <Card className="flex flex-1 flex-col">
            <CardHeader className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">Configuration</h3>
              <Button
                type="button"
                disabled={isSavingConfig}
                onClick={() => {
                  void handleSaveConfiguration(moduleDetail.id);
                }}
              >
                {isSavingConfig ? "Saving" : "Save"}
              </Button>
            </CardHeader>
            <CardContent className="min-h-0 flex-1">
              <ScrollArea className="h-full">
                <div className="space-y-4">
                  {configDraftError ? (
                    <p className="text-sm text-destructive">
                      {configDraftError}
                    </p>
                  ) : null}

                  <ConfigEditor
                    idPrefix="module-config"
                    config={currentConfigDisplay}
                    schema={JSON.stringify(
                      moduleConfigSchemaPayload?.configSchema ?? {},
                      null,
                      2,
                    )}
                    jsonPatch={configDraft}
                    onJsonPatchChange={(value) => {
                      setConfigDraftError(null);
                      setConfigDraft(value);
                    }}
                    labels={{
                      config: "Current Configuration",
                      schema: "Schema",
                      patch: "Edit Configuration (JSON or JSON Patch)",
                    }}
                  />
                </div>
              </ScrollArea>
            </CardContent>
          </Card>

          <Card className="flex flex-1 flex-col">
            <CardHeader className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">Secrets</h3>
              <Button
                type="button"
                disabled={isSavingSecrets}
                onClick={() => {
                  void handleSaveSecrets(moduleDetail.id);
                }}
              >
                {isSavingSecrets ? "Saving" : "Save"}
              </Button>
            </CardHeader>
            <CardContent className="min-h-0 flex-1">
              <ScrollArea className="h-full">
                <div className="space-y-4">
                  {secretsDraftError ? (
                    <p className="text-sm text-destructive">
                      {secretsDraftError}
                    </p>
                  ) : null}

                  <ConfigEditor
                    idPrefix="module-secrets"
                    labels={{
                      config: "Current Secrets",
                      schema: "Schema",
                      patch: "Edit Secrets (JSON or JSON Patch)",
                    }}
                    hideConfig
                    config={secretsDraft}
                    schema={JSON.stringify(
                      moduleSecretsSchemaPayload?.secretsSchema ?? {},
                      null,
                      2,
                    )}
                    jsonPatch={secretsDraft}
                    onJsonPatchChange={(value) => {
                      setSecretsDraftError(null);
                      setSecretsDraft(value);
                    }}
                  />
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
        </div>
      </div>
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
