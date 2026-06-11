import { Plus, RotateCcw, Trash2, Wrench } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiFetch, apiFetchJson, buildUrl, errorMessageFrom } from "@/lib/api";
import { cn } from "@/lib/utils";

const serviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  adapter: z.string(),
  enabled: z.boolean(),
});

const serviceListSchema = z.object({
  services: z.array(serviceSchema),
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

const moduleSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["adapter", "environment"]),
  description: z.string(),
  isBuiltin: z.boolean(),
  enabled: z.boolean(),
  orphaned: z.boolean(),
});

const moduleListSchema = z.object({
  modules: z.array(moduleSchema),
});

const installServiceSchema = z.object({
  id: z
    .string()
    .trim()
    .regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/, {
      message: "Id must be a valid TypeScript identifier.",
    }),
  source: z
    .string()
    .trim()
    .url({ message: "Definition URL must be a valid URL." }),
  adapter: z.string().trim().min(1, { message: "Adapter is required." }),
});

type Service = z.infer<typeof serviceSchema>;

type InstallServiceErrors = Partial<
  Record<"id" | "source" | "adapter" | "form", string>
>;

export default function ServicesPage() {
  const { mutate } = useSWRConfig();
  const [queryFilter, setQueryFilter] = useState("");
  const [enabledFilter, setEnabledFilter] = useState<
    "all" | "enabled" | "disabled"
  >("all");
  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(
    null,
  );
  const [isInstallOpen, setIsInstallOpen] = useState(false);
  const [installId, setInstallId] = useState("");
  const [installSource, setInstallSource] = useState("");
  const [installAdapter, setInstallAdapter] = useState("");
  const [installErrors, setInstallErrors] = useState<InstallServiceErrors>({});
  const [isInstalling, setIsInstalling] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
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

  const normalizedQuery = queryFilter.trim();
  const enabledParam =
    enabledFilter === "all"
      ? undefined
      : enabledFilter === "enabled"
        ? "true"
        : "false";

  const servicesUrl = useMemo(() => {
    return buildUrl("/services", {
      query: normalizedQuery.length > 0 ? normalizedQuery : undefined,
      enabled: enabledParam,
    });
  }, [normalizedQuery, enabledParam]);

  const adaptersUrl = useMemo(
    () => buildUrl("/modules", { type: "adapter", enabled: "true" }),
    [],
  );

  const {
    data: serviceList,
    error: servicesError,
    isLoading: isLoadingServices,
  } = useSWR(servicesUrl, (url) => apiFetchJson(url, serviceListSchema), {
    refreshInterval: 8000,
  });

  const { data: adapterList } = useSWR(
    adaptersUrl,
    (url) => apiFetchJson(url, moduleListSchema),
    { refreshInterval: 30000 },
  );

  const adapters = adapterList?.modules ?? [];

  const apiServices = serviceList?.services ?? [];
  const services = useMemo(() => apiServices, [apiServices]);

  useEffect(() => {
    if (services.length === 0) {
      setSelectedServiceId(null);
      return;
    }

    if (
      selectedServiceId === null ||
      !services.some((service) => service.id === selectedServiceId)
    ) {
      setSelectedServiceId(services[0]?.id ?? null);
    }
  }, [services, selectedServiceId]);

  const selectedService = useMemo(() => {
    return services.find((service) => service.id === selectedServiceId) ?? null;
  }, [services, selectedServiceId]);

  const serviceDetailsUrl = selectedServiceId
    ? buildUrl(`/services/${selectedServiceId}`)
    : null;

  const toolsUrl = selectedServiceId
    ? buildUrl("/tools", { serviceId: selectedServiceId })
    : null;

  const configUrl = selectedServiceId
    ? buildUrl(`/services/${selectedServiceId}/config`)
    : null;

  const configSchemaUrl = selectedServiceId
    ? buildUrl(`/services/${selectedServiceId}/config/schema`)
    : null;

  const secretsSchemaUrl = selectedServiceId
    ? buildUrl(`/services/${selectedServiceId}/secrets/schema`)
    : null;

  const { data: serviceDetails, error: detailsError } = useSWR(
    serviceDetailsUrl,
    (url) => apiFetchJson(url, serviceDetailsSchema),
    {
      refreshInterval: 8000,
    },
  );

  const {
    data: toolList,
    error: toolsError,
    isLoading: isLoadingTools,
  } = useSWR(toolsUrl, (url) => apiFetchJson(url, toolListSchema), {
    refreshInterval: 8000,
  });

  const tools = toolList?.tools ?? [];

  const detailService = serviceDetails ?? selectedService;

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
    if (!selectedServiceId) {
      return;
    }

    setConfigDraftError(null);
    const normalized = JSON.stringify(serviceConfig?.config ?? {}, null, 2);
    setConfigDraft(normalized);
  }, [selectedServiceId, serviceConfig?.config]);

  useEffect(() => {
    if (!selectedServiceId) {
      return;
    }

    setSecretsDraftError(null);
    setSecretsDraft("{\n  \n}");
  }, [selectedServiceId]);

  const escapeJsonPointer = (value: string) =>
    value.replace(/~/g, "~0").replace(/\//g, "~1");

  const handleSaveConfiguration = async (serviceId: string) => {
    setActionError(null);
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
      await apiFetch(buildUrl(`/services/${serviceId}/config`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });

      if (configUrl) {
        await mutate(configUrl);
      }
    } catch (error) {
      setActionError(errorMessageFrom(error, "Unable to save configuration."));
    } finally {
      setIsSavingConfig(false);
    }
  };

  const handleSaveSecrets = async (serviceId: string) => {
    setActionError(null);
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
      await apiFetch(buildUrl(`/services/${serviceId}/secrets`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });

      setSecretsDraft("{\n  \n}");
    } catch (error) {
      setActionError(errorMessageFrom(error, "Unable to save secrets."));
    } finally {
      setIsSavingSecrets(false);
    }
  };

  const handleInstallService = async () => {
    setInstallErrors({});

    const parsed = installServiceSchema.safeParse({
      id: installId,
      source: installSource,
      adapter: installAdapter,
    });

    if (!parsed.success) {
      const fieldErrors = parsed.error.flatten().fieldErrors;
      setInstallErrors({
        id: fieldErrors.id?.[0],
        source: fieldErrors.source?.[0],
        adapter: fieldErrors.adapter?.[0],
      });
      return;
    }

    setIsInstalling(true);
    try {
      await apiFetch(buildUrl("/services/install"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });

      setInstallId("");
      setInstallSource("");
      setInstallAdapter("");
      setIsInstallOpen(false);
      await mutate(servicesUrl);
    } catch (error) {
      setInstallErrors({
        form: errorMessageFrom(error, "Unable to install service."),
      });
    } finally {
      setIsInstalling(false);
    }
  };

  const handleUpdateService = async (serviceId: string) => {
    setActionError(null);
    setIsUpdating(true);
    try {
      await apiFetch(buildUrl(`/services/${serviceId}/update`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      await mutate(servicesUrl);
      if (serviceDetailsUrl) {
        await mutate(serviceDetailsUrl);
      }
      if (toolsUrl) {
        await mutate(toolsUrl);
      }
    } catch (error) {
      setActionError(errorMessageFrom(error, "Unable to update service."));
    } finally {
      setIsUpdating(false);
    }
  };

  const handleSetServiceEnabled = async (
    serviceId: string,
    enabled: boolean,
  ) => {
    setActionError(null);
    try {
      await apiFetch(buildUrl(`/services/${serviceId}/enabled`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });

      await mutate(servicesUrl);
      if (serviceDetailsUrl) {
        await mutate(serviceDetailsUrl);
      }
      if (toolsUrl) {
        await mutate(toolsUrl);
      }
    } catch (error) {
      setActionError(
        errorMessageFrom(error, "Unable to update service state."),
      );
    }
  };

  const handleSetToolEnabled = async (
    serviceId: string,
    toolId: string,
    enabled: boolean,
  ) => {
    setActionError(null);
    try {
      await apiFetch(buildUrl(`/tools/${serviceId}/${toolId}/enabled`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });

      if (toolsUrl) {
        await mutate(toolsUrl);
      }
      await mutate(servicesUrl);
    } catch (error) {
      setActionError(errorMessageFrom(error, "Unable to update tool state."));
    }
  };

  const handleDeleteService = async (serviceId: string) => {
    setActionError(null);
    try {
      await apiFetch(buildUrl(`/services/${serviceId}`), {
        method: "DELETE",
      });

      setSelectedServiceId(null);
      await mutate(servicesUrl);
      if (serviceDetailsUrl) {
        await mutate(serviceDetailsUrl);
      }
      if (toolsUrl) {
        await mutate(toolsUrl);
      }
    } catch (error) {
      setActionError(errorMessageFrom(error, "Unable to delete service."));
    }
  };

  const hasDetailPanel = selectedServiceId !== null;

  return (
    <>
      <section className="flex min-h-0 flex-1 flex-col gap-6 p-6">
        <header className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-1">
              <h1 className="text-xl font-semibold">Services</h1>
              <p className="text-muted-foreground text-sm">
                Install, and manage services.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Popover open={isInstallOpen} onOpenChange={setIsInstallOpen}>
                <PopoverTrigger asChild>
                  <Button className="gap-2" type="button">
                    <Plus />
                    Install service
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-md">
                  <div className="space-y-4">
                    <div className="space-y-1">
                      <h3 className="text-sm font-medium">Install service</h3>
                      <p className="text-muted-foreground text-xs">
                        Provide a service id, definition URL, and adapter.
                      </p>
                    </div>
                    <div className="space-y-3">
                      <div className="space-y-2">
                        <Label htmlFor="service-id">Id</Label>
                        <Input
                          id="service-id"
                          onChange={(event) => setInstallId(event.target.value)}
                          placeholder="myService"
                          value={installId}
                        />
                        {installErrors.id ? (
                          <p className="text-xs text-destructive">
                            {installErrors.id}
                          </p>
                        ) : null}
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="service-source">Definition URL</Label>
                        <Input
                          id="service-source"
                          onChange={(event) =>
                            setInstallSource(event.target.value)
                          }
                          placeholder="https://example.com/manifest.json"
                          value={installSource}
                        />
                        {installErrors.source ? (
                          <p className="text-xs text-destructive">
                            {installErrors.source}
                          </p>
                        ) : null}
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="service-adapter">Adapter</Label>
                        {adapters.length > 0 ? (
                          <Select
                            onValueChange={setInstallAdapter}
                            value={installAdapter}
                          >
                            <SelectTrigger id="service-adapter">
                              <SelectValue placeholder="Select an adapter" />
                            </SelectTrigger>
                            <SelectContent>
                              {adapters.map((adapter) => (
                                <SelectItem key={adapter.id} value={adapter.id}>
                                  {adapter.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <Input
                            id="service-adapter"
                            onChange={(event) =>
                              setInstallAdapter(event.target.value)
                            }
                            placeholder="openapi"
                            value={installAdapter}
                          />
                        )}
                        {installErrors.adapter ? (
                          <p className="text-xs text-destructive">
                            {installErrors.adapter}
                          </p>
                        ) : null}
                      </div>
                      {installErrors.form ? (
                        <p className="text-xs text-destructive">
                          {installErrors.form}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setIsInstallOpen(false)}
                      >
                        Cancel
                      </Button>
                      <Button
                        type="button"
                        disabled={isInstalling}
                        onClick={() => void handleInstallService()}
                      >
                        <Wrench />
                        {isInstalling ? "Installing" : "Install"}
                      </Button>
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex flex-1 items-center gap-2">
              <Input
                placeholder="Filter by name or description"
                value={queryFilter}
                onChange={(event) => setQueryFilter(event.target.value)}
              />
            </div>
            <div className="flex items-center gap-2">
              <Select
                onValueChange={(value) =>
                  setEnabledFilter(value as "all" | "enabled" | "disabled")
                }
                value={enabledFilter}
              >
                <SelectTrigger className="w-[170px]">
                  <SelectValue placeholder="Enabled" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All services</SelectItem>
                  <SelectItem value="enabled">Enabled</SelectItem>
                  <SelectItem value="disabled">Disabled</SelectItem>
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="outline"
                className="gap-2"
                onClick={() => void mutate(servicesUrl)}
                aria-label="Refresh services"
              >
                <RotateCcw />
              </Button>
            </div>
          </div>
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-6 lg:flex-row">
          <Card
            className={cn(
              "flex min-h-0 flex-1 flex-col",
              hasDetailPanel ? "lg:max-w-[20rem]" : "",
            )}
          >
            <CardContent className="min-h-0 flex-1">
              <ScrollArea className="h-full">
                <div
                  className={cn(
                    "grid gap-4",
                    hasDetailPanel
                      ? "grid-cols-1"
                      : "grid-cols-1 md:grid-cols-2 xl:grid-cols-3",
                  )}
                >
                  {services.map((service) => (
                    <button
                      key={service.id}
                      type="button"
                      onClick={() => setSelectedServiceId(service.id)}
                      className={cn(
                        "text-left",
                        "border bg-card p-4",
                        "hover:bg-muted",
                        selectedServiceId === service.id
                          ? "border-primary"
                          : "border-border",
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="flex items-center gap-2">
                            <h3 className="text-sm font-semibold">
                              {service.name}
                            </h3>
                            <span className="text-muted-foreground text-xs">
                              {service.id}
                            </span>
                          </div>
                          <p className="text-muted-foreground text-xs">
                            {service.description || "No description"}
                          </p>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
                {servicesError ? (
                  <p className="p-4 text-sm text-destructive">
                    Failed to load services.
                  </p>
                ) : null}
                {!isLoadingServices && services.length === 0 ? (
                  <p className="p-4 text-sm text-muted-foreground">
                    No services installed yet.
                  </p>
                ) : null}
                {actionError ? (
                  <p className="p-4 text-sm text-destructive">{actionError}</p>
                ) : null}
              </ScrollArea>
            </CardContent>
          </Card>

          {hasDetailPanel ? (
            <aside className="flex w-full min-h-0 flex-col gap-4 lg:flex-1">
              <Card className="flex min-h-0 flex-1 flex-col">
                <CardContent className="min-h-0 flex-1">
                  <ScrollArea className="h-full">
                    {detailService ? (
                      <div className="space-y-6">
                        <div className="space-y-4">
                          <div className="space-y-1">
                            <h2 className="text-lg font-semibold">
                              {detailService.name}
                            </h2>
                            <p className="text-muted-foreground text-xs font-mono">
                              {detailService.id} · adapter:{" "}
                              {detailService.adapter}
                            </p>
                            <p className="text-muted-foreground text-sm">
                              {detailService.description || "No description"}
                            </p>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              type="button"
                              variant={
                                detailService.enabled ? "outline" : "default"
                              }
                              onClick={() =>
                                void handleSetServiceEnabled(
                                  detailService.id,
                                  !detailService.enabled,
                                )
                              }
                            >
                              {detailService.enabled ? "Disable" : "Enable"}
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              disabled={isUpdating}
                              onClick={() =>
                                void handleUpdateService(detailService.id)
                              }
                            >
                              <RotateCcw />
                              {isUpdating ? "Updating" : "Update"}
                            </Button>
                            <Button
                              type="button"
                              variant="destructive"
                              onClick={() => {
                                setDeleteCandidate(detailService);
                                setIsDeleteDialogOpen(true);
                              }}
                            >
                              <Trash2 />
                              Uninstall
                            </Button>
                          </div>
                          {detailsError ? (
                            <p className="text-sm text-destructive">
                              Failed to load service details.
                            </p>
                          ) : null}
                        </div>

                        <div className="space-y-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <h3 className="text-sm font-semibold">Tools</h3>
                            <p className="py-1 px-2 text-muted-foreground text-xs bg-muted border-1">
                              {isLoadingTools
                                ? "Loading..."
                                : `${tools.length} total`}
                            </p>
                          </div>

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
                                className="border bg-background p-4"
                              >
                                <div className="flex flex-wrap items-center justify-between gap-3">
                                  <div className="space-y-1">
                                    <p className="text-sm font-semibold">
                                      {tool.name}
                                    </p>
                                    <p className="text-muted-foreground text-xs">
                                      {tool.description || "No description"}
                                    </p>
                                    {!tool.effectivelyEnabled &&
                                    tool.enabled ? (
                                      <p className="text-xs text-amber-600">
                                        Tool is enabled but service is disabled.
                                      </p>
                                    ) : null}
                                  </div>
                                  <button
                                    type="button"
                                    role="switch"
                                    aria-checked={tool.enabled}
                                    className={cn(
                                      "relative inline-flex h-6 w-11 items-center transition",
                                      tool.enabled ? "bg-primary" : "bg-muted",
                                    )}
                                    onClick={() => {
                                      if (!detailService) {
                                        return;
                                      }
                                      void handleSetToolEnabled(
                                        detailService.id,
                                        tool.name,
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
                              </div>
                            ))}
                          </div>
                        </div>

                        <div className="space-y-4">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <h3 className="text-sm font-semibold">
                              Configuration
                            </h3>
                            <Button
                              type="button"
                              variant="outline"
                              disabled={isSavingConfig || !detailService}
                              onClick={() => {
                                if (!detailService) {
                                  return;
                                }
                                void handleSaveConfiguration(detailService.id);
                              }}
                            >
                              {isSavingConfig ? "Saving" : "Save"}
                            </Button>
                          </div>

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

                        <div className="space-y-4">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <h3 className="text-sm font-semibold">Secrets</h3>
                            <Button
                              type="button"
                              variant="outline"
                              disabled={isSavingSecrets || !detailService}
                              onClick={() => {
                                if (!detailService) {
                                  return;
                                }
                                void handleSaveSecrets(detailService.id);
                              }}
                            >
                              {isSavingSecrets ? "Saving" : "Save"}
                            </Button>
                          </div>

                          {secretsDraftError ? (
                            <p className="text-sm text-destructive">
                              {secretsDraftError}
                            </p>
                          ) : null}

                          <p className="text-xs text-muted-foreground">
                            Stored secrets are write-only. Provide a JSON object
                            (or JSON Patch array) with the values to set. They
                            will be encrypted at rest.
                          </p>

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
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        Select a service to view details.
                      </p>
                    )}
                  </ScrollArea>
                </CardContent>
              </Card>
            </aside>
          ) : null}
        </div>
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
