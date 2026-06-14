import { ArrowLeft, RotateCcw, Trash2 } from "lucide-react";
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
import { cn } from "@/lib/utils";

const serviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  adapter: z.string(),
  enabled: z.boolean(),
});

const serviceDetailsSchema = serviceSchema.extend({
  hash: z.string(),
  source: z.string(),
  configSchema: z.record(z.string(), z.unknown()),
  secretsSchema: z.record(z.string(), z.unknown()),
});

const serviceConfigSchema = z.object({
  config: z.record(z.string(), z.unknown()),
});

const serviceConfigSchemaSchema = z.object({
  configSchema: z.record(z.string(), z.unknown()),
});

const serviceSecretsSchemaSchema = z.object({
  secretsSchema: z.record(z.string(), z.unknown()),
});

const toolSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  serviceId: z.string(),
  enabled: z.boolean(),
  effectivelyEnabled: z.boolean(),
});

const toolListSchema = z.object({
  tools: z.array(toolSchema),
});

type Service = z.infer<typeof serviceSchema>;

export default function ServiceDetailPage() {
  const { serviceId } = useParams<{ serviceId: string }>();
  const navigate = useNavigate();
  const { mutate } = useSWRConfig();

  const { addNotification } = useNotification();
  const [deleteCandidate, setDeleteCandidate] = useState<Service | null>(null);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [configDraft, setConfigDraft] = useState<string>("{\n  \n}");
  const [configDraftError, setConfigDraftError] = useState<string | null>(null);
  const [isSavingConfig, setIsSavingConfig] = useState(false);
  const [secretsDraft, setSecretsDraft] = useState<string>("{\n  \n}");
  const [secretsDraftError, setSecretsDraftError] = useState<string | null>(
    null,
  );
  const [isSavingSecrets, setIsSavingSecrets] = useState(false);

  const serviceDetailsUrl = serviceId
    ? buildUrl(`/services/${serviceId}`)
    : null;

  const toolsUrl = serviceId ? buildUrl("/tools", { serviceId }) : null;

  const configUrl = serviceId
    ? buildUrl(`/services/${serviceId}/config`)
    : null;

  const configSchemaUrl = serviceId
    ? buildUrl(`/services/${serviceId}/config/schema`)
    : null;

  const secretsSchemaUrl = serviceId
    ? buildUrl(`/services/${serviceId}/secrets/schema`)
    : null;

  const { data: serviceDetails, error: detailsError } = useSWR(
    serviceDetailsUrl,
    (url) => apiFetchJson(url, serviceDetailsSchema),
    { refreshInterval: 8000 },
  );

  const {
    data: toolList,
    error: toolsError,
    isLoading: isLoadingTools,
  } = useSWR(toolsUrl, (url) => apiFetchJson(url, toolListSchema), {
    refreshInterval: 8000,
  });

  const tools = toolList?.tools ?? [];

  const { data: serviceConfig } = useSWR(
    configUrl,
    (url) => apiFetchJson(url, serviceConfigSchema),
    { refreshInterval: 8000 },
  );

  const { data: serviceConfigSchemaPayload } = useSWR(
    configSchemaUrl,
    (url) => apiFetchJson(url, serviceConfigSchemaSchema),
    { refreshInterval: 8000 },
  );

  const { data: serviceSecretsSchemaPayload } = useSWR(
    secretsSchemaUrl,
    (url) => apiFetchJson(url, serviceSecretsSchemaSchema),
    { refreshInterval: 8000 },
  );

  const currentConfigDisplay = JSON.stringify(
    serviceConfig?.config ?? {},
    null,
    2,
  );

  useEffect(() => {
    if (!serviceId) {
      return;
    }

    setConfigDraftError(null);
    const normalized = JSON.stringify(serviceConfig?.config ?? {}, null, 2);
    setConfigDraft(normalized);
  }, [serviceId, serviceConfig?.config]);

  useEffect(() => {
    if (!serviceId) {
      return;
    }

    setSecretsDraftError(null);
    setSecretsDraft("{\n  \n}");
  }, [serviceId]);

  const escapeJsonPointer = (value: string) =>
    value.replace(/~/g, "~0").replace(/\//g, "~1");

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

    const patch: Array<Record<string, unknown>> = [];

    if (Array.isArray(desiredConfig)) {
      patch.push(...(desiredConfig as Array<Record<string, unknown>>));
    } else {
      if (!desiredConfig || typeof desiredConfig !== "object") {
        setConfigDraftError(
          "Configuration must be a JSON object or JSON Patch array.",
        );
        return;
      }

      const currentConfig = (serviceConfig?.config ?? {}) as Record<
        string,
        unknown
      >;
      const nextConfig = desiredConfig as Record<string, unknown>;

      for (const key of Object.keys(currentConfig)) {
        if (!Object.hasOwn(nextConfig, key)) {
          patch.push({ op: "remove", path: `/${escapeJsonPointer(key)}` });
        }
      }

      for (const [key, value] of Object.entries(nextConfig)) {
        const op = Object.hasOwn(currentConfig, key) ? "replace" : "add";
        if (Object.hasOwn(currentConfig, key) && currentConfig[key] === value) {
          continue;
        }
        patch.push({ op, path: `/${escapeJsonPointer(key)}`, value });
      }
    }

    setIsSavingConfig(true);
    try {
      await apiFetch(buildUrl(`/services/${id}/config`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });

      if (configUrl) {
        await mutate(configUrl);
      }
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

      const nextSecrets = desiredSecrets as Record<string, unknown>;

      for (const [key, value] of Object.entries(nextSecrets)) {
        patch.push({
          op: "add",
          path: `/${escapeJsonPointer(key)}`,
          value,
        });
      }
    }

    setIsSavingSecrets(true);
    try {
      await apiFetch(buildUrl(`/services/${id}/secrets`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });

      setSecretsDraft("{\n  \n}");
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

  const handleUpdateService = async (id: string) => {
    setIsUpdating(true);
    try {
      await apiFetch(buildUrl(`/services/${id}/update`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      await mutate(buildUrl("/services"));
      if (serviceDetailsUrl) {
        await mutate(serviceDetailsUrl);
      }
      if (toolsUrl) {
        await mutate(toolsUrl);
      }
      addNotification({
        type: "success",
        title: "Success",
        message: "Service updated.",
      });
    } catch (error) {
      addNotification({
        type: "error",
        title: "Error",
        message: errorMessageFrom(error, "Unable to update service."),
      });
    } finally {
      setIsUpdating(false);
    }
  };

  const handleSetServiceEnabled = async (id: string, enabled: boolean) => {
    try {
      await apiFetch(buildUrl(`/services/${id}/enabled`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });

      await mutate(buildUrl("/services"));
      if (serviceDetailsUrl) {
        await mutate(serviceDetailsUrl);
      }
      if (toolsUrl) {
        await mutate(toolsUrl);
      }
      addNotification({
        type: "success",
        title: "Success",
        message: `Service ${enabled ? "enabled" : "disabled"}.`,
      });
    } catch (error) {
      addNotification({
        type: "error",
        title: "Error",
        message: errorMessageFrom(error, "Unable to update service state."),
      });
    }
  };

  const handleSetToolEnabled = async (
    serviceId: string,
    toolId: string,
    enabled: boolean,
  ) => {
    try {
      await apiFetch(buildUrl(`/tools/${serviceId}/${toolId}/enabled`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });

      if (toolsUrl) {
        await mutate(toolsUrl);
      }
      await mutate(buildUrl("/services"));
      addNotification({
        type: "success",
        title: "Success",
        message: `Tool ${enabled ? "enabled" : "disabled"}.`,
      });
    } catch (error) {
      addNotification({
        type: "error",
        title: "Error",
        message: errorMessageFrom(error, "Unable to update tool state."),
      });
    }
  };

  const handleDeleteService = async (id: string) => {
    try {
      await apiFetch(buildUrl(`/services/${id}`), {
        method: "DELETE",
      });

      await mutate(buildUrl("/services"));
      if (serviceDetailsUrl) {
        await mutate(serviceDetailsUrl);
      }
      if (toolsUrl) {
        await mutate(toolsUrl);
      }

      addNotification({
        type: "success",
        title: "Success",
        message: "Service uninstalled.",
      });
      navigate("/services");
    } catch (error) {
      addNotification({
        type: "error",
        title: "Error",
        message: errorMessageFrom(error, "Unable to delete service."),
      });
    }
  };

  if (!serviceId) {
    navigate("/services");
    return null;
  }

  return (
    <>
      <section className="flex min-h-0 flex-1 flex-col gap-6 p-6 h-screen overflow-hidden">
        <header>
          <Button
            type="button"
            variant="ghost"
            onClick={() => navigate("/services")}
            className="gap-2"
          >
            <ArrowLeft />
            Back to Services
          </Button>
        </header>

        {detailsError ? (
          <p className="text-sm text-destructive">
            Failed to load service details.
          </p>
        ) : null}

        {serviceDetails ? (
          <div className="flex min-h-0 flex-1 flex-col gap-6">
            <Card>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <div className="flex items-center flex-wrap gap-2">
                    <h2 className="text-lg font-semibold">
                      {serviceDetails.name}
                    </h2>
                    <Badge variant="secondary">{serviceDetails.adapter}</Badge>
                  </div>
                  <p className="text-muted-foreground text-xs font-mono">
                    {serviceDetails.id}
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant={serviceDetails.enabled ? "outline" : "default"}
                      onClick={() =>
                        void handleSetServiceEnabled(
                          serviceDetails.id,
                          !serviceDetails.enabled,
                        )
                      }
                    >
                      {serviceDetails.enabled ? "Disable" : "Enable"}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={isUpdating}
                      onClick={() =>
                        void handleUpdateService(serviceDetails.id)
                      }
                    >
                      <RotateCcw />
                      {isUpdating ? "Updating" : "Update"}
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      onClick={() => {
                        setDeleteCandidate(serviceDetails);
                        setIsDeleteDialogOpen(true);
                      }}
                    >
                      <Trash2 />
                      Uninstall
                    </Button>
                  </div>
                  {serviceDetails.description ? (
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
                      {serviceDetails.description}
                    </ReactMarkdown>
                  ) : (
                    <p className="text-muted-foreground text-sm">
                      No description
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>

            <div className="flex flex-col lg:flex-row gap-6">
              <Card className="max-h-[calc(100vh-3rem)] flex flex-1 flex-col h-full">
                <CardHeader className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold">Tools</h3>
                  <p className="py-1 px-2 text-muted-foreground text-xs bg-muted border-1">
                    {isLoadingTools ? "Loading..." : `${tools.length} total`}
                  </p>
                </CardHeader>
                <CardContent className="flex-1 overflow-hidden">
                  <ScrollArea className="h-full">
                    <div className="space-y-3">
                      {toolsError ? (
                        <p className="text-sm text-destructive">
                          Failed to load tools.
                        </p>
                      ) : null}
                      {tools.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                          No tools registered for this service.
                        </p>
                      ) : null}

                      <div className="space-y-3">
                        {tools.map((tool) => (
                          <div
                            key={tool.id}
                            className="flex flex-col gap-2 border bg-background p-4"
                          >
                            <div className="space-y-1">
                              <p className="text-sm font-semibold">
                                {tool.name}
                              </p>
                              <p className="text-muted-foreground text-xs font-mono">
                                {tool.id}
                              </p>
                              {tool.description ? (
                                <ReactMarkdown
                                  remarkPlugins={[remarkGfm]}
                                  components={{
                                    p: ({ children }) => <p>{children}</p>,
                                  }}
                                >
                                  {tool.description}
                                </ReactMarkdown>
                              ) : (
                                <p className="text-muted-foreground text-xs">
                                  No description
                                </p>
                              )}
                            </div>
                            <button
                              type="button"
                              role="switch"
                              aria-checked={tool.enabled}
                              className={cn(
                                "relative inline-flex h-6 w-11 items-center transition",
                                tool.enabled ? "bg-primary" : "bg-muted",
                                "disabled:opacity-50 disabled:cursor-not-allowed",
                              )}
                              disabled={
                                !tool.effectivelyEnabled && tool.enabled
                              }
                              onClick={() => {
                                void handleSetToolEnabled(
                                  serviceDetails.id,
                                  tool.id,
                                  !tool.enabled,
                                );
                              }}
                            >
                              <span
                                className={cn(
                                  "inline-block h-4 w-4 transform bg-background shadow transition",
                                  tool.enabled
                                    ? "translate-x-6"
                                    : "translate-x-1",
                                )}
                              />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  </ScrollArea>
                </CardContent>
              </Card>
              <div className="max-h-[calc(100vh-3rem)] flex flex-1 flex-col gap-6 h-full min-h-0">
                <Card className="h-1/2 flex flex-col">
                  <CardHeader className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold">Configuration</h3>
                    <Button
                      type="button"
                      disabled={isSavingConfig}
                      onClick={() => {
                        void handleSaveConfiguration(serviceDetails.id);
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
                          idPrefix="config"
                          config={currentConfigDisplay}
                          schema={JSON.stringify(
                            serviceConfigSchemaPayload?.configSchema ?? {},
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

                <Card className="h-1/2 flex flex-col">
                  <CardHeader className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold">Secrets</h3>
                    <Button
                      type="button"
                      disabled={isSavingSecrets}
                      onClick={() => {
                        void handleSaveSecrets(serviceDetails.id);
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
                          idPrefix="secrets"
                          labels={{
                            config: "Current Secrets",
                            schema: "Schema",
                            patch: "Edit Secrets (JSON or JSON Patch)",
                          }}
                          hideConfig
                          config={secretsDraft}
                          schema={JSON.stringify(
                            serviceSecretsSchemaPayload?.secretsSchema ?? {},
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
          </div>
        ) : null}
      </section>

      <AlertDialog
        open={isDeleteDialogOpen}
        onOpenChange={(open) => {
          setIsDeleteDialogOpen(open);
          if (!open) {
            setDeleteCandidate(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Uninstall service?</AlertDialogTitle>
            <AlertDialogDescription>
              This action removes the service and its tools from the registry.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!deleteCandidate) {
                  return;
                }
                void handleDeleteService(deleteCandidate.id);
                setIsDeleteDialogOpen(false);
                setDeleteCandidate(null);
              }}
            >
              Uninstall
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
