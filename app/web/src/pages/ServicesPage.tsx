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
import { cn } from "@/lib/utils";

const metadataSchema = z.record(z.string(), z.unknown());

const serviceSchema = z.object({
  name: z.string(),
  type: z.string(),
  source: z.string(),
  description: z.string(),
  hash: z.string(),
  enabled: z.boolean(),
});

const serviceListSchema = z.object({
  services: z.array(serviceSchema),
});

const serviceDetailsSchema = serviceSchema.extend({
  metadata: metadataSchema,
  configSchema: metadataSchema,
  secretsSchema: metadataSchema,
});

const serviceConfigSchema = z.object({
  config: metadataSchema,
});

const serviceConfigSchemaSchema = z.object({
  configSchema: metadataSchema,
});

const serviceSecretsSchema = z.object({
  secrets: metadataSchema,
});

const serviceSecretsSchemaSchema = z.object({
  secretsSchema: metadataSchema,
});

const toolSchema = z.object({
  name: z.string(),
  description: z.string(),
  enabled: z.boolean(),
  inputSchema: metadataSchema,
  outputSchema: metadataSchema,
});

const toolListSchema = z.object({
  tools: z.array(toolSchema),
});

const installServiceSchema = z.object({
  type: z.string().trim().min(1, { message: "Type is required." }),
  source: z
    .string()
    .trim()
    .url({ message: "Definition URL must be a valid URL." }),
});

type Service = z.infer<typeof serviceSchema>;

type InstallServiceErrors = Partial<Record<"type" | "source" | "form", string>>;

const apiBase = import.meta.env.VITE_MCI_API_URL ?? "";

const buildUrl = (
  path: string,
  params?: Record<string, string | undefined>,
) => {
  const base = apiBase.length > 0 ? apiBase : window.location.origin;
  const url = new URL(path, base);
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined) {
        url.searchParams.set(key, value);
      }
    });
  }
  return url.toString();
};

const fetchJson = async <T,>(url: string, schema: z.ZodType<T>) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  const data = await response.json();
  return schema.parse(data);
};

export default function ServicesPage() {
  const { mutate } = useSWRConfig();
  const [queryFilter, setQueryFilter] = useState("");
  const [enabledFilter, setEnabledFilter] = useState<
    "all" | "enabled" | "disabled"
  >("all");
  const [selectedServiceName, setSelectedServiceName] = useState<string | null>(
    null,
  );
  const [isInstallOpen, setIsInstallOpen] = useState(false);
  const [installType, setInstallType] = useState("registry");
  const [installSource, setInstallSource] = useState("");
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

  const {
    data: serviceList,
    error: servicesError,
    isLoading: isLoadingServices,
  } = useSWR(servicesUrl, (url) => fetchJson(url, serviceListSchema), {
    refreshInterval: 8000,
  });

  const apiServices = serviceList?.services ?? [];
  const services = useMemo(() => apiServices, [apiServices]);

  useEffect(() => {
    if (services.length === 0) {
      setSelectedServiceName(null);
      return;
    }

    if (
      selectedServiceName === null ||
      !services.some((service) => service.name === selectedServiceName)
    ) {
      setSelectedServiceName(services[0]?.name ?? null);
    }
  }, [services, selectedServiceName]);

  const selectedService = useMemo(() => {
    return (
      services.find((service) => service.name === selectedServiceName) ?? null
    );
  }, [services, selectedServiceName]);

  const serviceDetailsUrl = selectedServiceName
    ? buildUrl(`/services/${selectedServiceName}`)
    : null;

  const toolsUrl = selectedServiceName
    ? buildUrl(`/services/${selectedServiceName}/tools`)
    : null;

  const configUrl = selectedServiceName
    ? buildUrl(`/services/${selectedServiceName}/configuration`)
    : null;

  const configSchemaUrl = selectedServiceName
    ? buildUrl(`/services/${selectedServiceName}/configuration/schema`)
    : null;

  const secretsUrl = selectedServiceName
    ? buildUrl(`/services/${selectedServiceName}/secrets`)
    : null;

  const secretsSchemaUrl = selectedServiceName
    ? buildUrl(`/services/${selectedServiceName}/secrets/schema`)
    : null;

  const { data: serviceDetails, error: detailsError } = useSWR(
    serviceDetailsUrl,
    (url) => fetchJson(url, serviceDetailsSchema),
    {
      refreshInterval: 8000,
    },
  );

  const {
    data: toolList,
    error: toolsError,
    isLoading: isLoadingTools,
  } = useSWR(toolsUrl, (url) => fetchJson(url, toolListSchema), {
    refreshInterval: 8000,
  });

  const tools = toolList?.tools ?? [];

  const detailService = serviceDetails ?? selectedService;

  const { data: serviceConfig } = useSWR(
    configUrl,
    (url) => fetchJson(url, serviceConfigSchema),
    { refreshInterval: 8000 },
  );

  const { data: serviceConfigSchemaPayload } = useSWR(
    configSchemaUrl,
    (url) => fetchJson(url, serviceConfigSchemaSchema),
    { refreshInterval: 8000 },
  );

  const { data: serviceSecrets } = useSWR(
    secretsUrl,
    (url) => fetchJson(url, serviceSecretsSchema),
    { refreshInterval: 8000 },
  );

  const { data: serviceSecretsSchemaPayload } = useSWR(
    secretsSchemaUrl,
    (url) => fetchJson(url, serviceSecretsSchemaSchema),
    { refreshInterval: 8000 },
  );

  const currentConfigDisplay = JSON.stringify(
    serviceConfig?.config ?? {},
    null,
    2,
  );

  useEffect(() => {
    if (!selectedServiceName) {
      return;
    }

    setConfigDraftError(null);
    const normalized = JSON.stringify(serviceConfig?.config ?? {}, null, 2);
    setConfigDraft(normalized);
  }, [selectedServiceName, serviceConfig?.config]);

  useEffect(() => {
    if (!selectedServiceName) {
      return;
    }

    setSecretsDraftError(null);
    const normalized = JSON.stringify(serviceSecrets?.secrets ?? {}, null, 2);
    setSecretsDraft(normalized);
  }, [selectedServiceName, serviceSecrets?.secrets]);

  const escapeJsonPointer = (value: string) =>
    value.replace(/~/g, "~0").replace(/\//g, "~1");

  const handleSaveConfiguration = async (serviceName: string) => {
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
      const response = await fetch(
        buildUrl(`/services/${serviceName}/configuration`),
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        },
      );

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(
          text.trim().length > 0 ? text : `Request failed: ${response.status}`,
        );
      }

      if (configUrl) {
        await mutate(configUrl);
      }
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : "Unable to save configuration.",
      );
    } finally {
      setIsSavingConfig(false);
    }
  };

  const handleSaveSecrets = async (serviceName: string) => {
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

      const currentSecrets = (serviceSecrets?.secrets ?? {}) as Record<
        string,
        unknown
      >;
      const nextSecrets = desiredSecrets as Record<string, unknown>;

      for (const key of Object.keys(currentSecrets)) {
        if (!Object.hasOwn(nextSecrets, key)) {
          patch.push({ op: "remove", path: `/${escapeJsonPointer(key)}` });
        }
      }

      for (const [key, value] of Object.entries(nextSecrets)) {
        const op = Object.hasOwn(currentSecrets, key) ? "replace" : "add";
        if (
          Object.hasOwn(currentSecrets, key) &&
          currentSecrets[key] === value
        ) {
          continue;
        }
        patch.push({ op, path: `/${escapeJsonPointer(key)}`, value });
      }
    }

    setIsSavingSecrets(true);
    try {
      const response = await fetch(
        buildUrl(`/services/${serviceName}/secrets`),
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        },
      );

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(
          text.trim().length > 0 ? text : `Request failed: ${response.status}`,
        );
      }

      if (secretsUrl) {
        await mutate(secretsUrl);
      }
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Unable to save secrets.",
      );
    } finally {
      setIsSavingSecrets(false);
    }
  };

  const handleInstallService = async () => {
    setInstallErrors({});

    const parsed = installServiceSchema.safeParse({
      type: installType,
      source: installSource,
    });

    if (!parsed.success) {
      const fieldErrors = parsed.error.flatten().fieldErrors;
      setInstallErrors({
        type: fieldErrors.type?.[0],
        source: fieldErrors.source?.[0],
      });
      return;
    }

    setIsInstalling(true);
    try {
      const response = await fetch(buildUrl("/services/install"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });

      if (!response.ok) {
        throw new Error(`Request failed: ${response.status}`);
      }

      setInstallSource("");
      setInstallType("registry");
      setIsInstallOpen(false);
      await mutate(servicesUrl);
    } catch (error) {
      setInstallErrors({
        form:
          error instanceof Error ? error.message : "Unable to install service.",
      });
    } finally {
      setIsInstalling(false);
    }
  };

  const handleUpdateService = async (serviceName: string) => {
    setActionError(null);
    setIsUpdating(true);
    try {
      const response = await fetch(
        buildUrl(`/services/${serviceName}/update`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );

      if (!response.ok) {
        throw new Error(`Request failed: ${response.status}`);
      }

      await mutate(servicesUrl);
      if (serviceDetailsUrl) {
        await mutate(serviceDetailsUrl);
      }
      if (toolsUrl) {
        await mutate(toolsUrl);
      }
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Unable to update service.",
      );
    } finally {
      setIsUpdating(false);
    }
  };

  const handleSetServiceEnabled = async (
    serviceName: string,
    enabled: boolean,
  ) => {
    setActionError(null);
    try {
      const response = await fetch(
        buildUrl(`/services/${serviceName}/enabled`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled }),
        },
      );

      if (!response.ok) {
        throw new Error(`Request failed: ${response.status}`);
      }

      await mutate(servicesUrl);
      if (serviceDetailsUrl) {
        await mutate(serviceDetailsUrl);
      }
      if (toolsUrl) {
        await mutate(toolsUrl);
      }
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : "Unable to update service state.",
      );
    }
  };

  const handleSetToolEnabled = async (
    serviceName: string,
    toolName: string,
    enabled: boolean,
  ) => {
    setActionError(null);
    try {
      const response = await fetch(
        buildUrl(`/services/${serviceName}/tools/${toolName}/enabled`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled }),
        },
      );

      if (!response.ok) {
        throw new Error(`Request failed: ${response.status}`);
      }

      if (toolsUrl) {
        await mutate(toolsUrl);
      }
      await mutate(servicesUrl);
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Unable to update tool state.",
      );
    }
  };

  const handleDeleteService = async (serviceName: string) => {
    setActionError(null);
    try {
      const response = await fetch(buildUrl(`/services/${serviceName}`), {
        method: "DELETE",
      });

      if (!response.ok && response.status !== 204) {
        throw new Error(`Request failed: ${response.status}`);
      }

      setSelectedServiceName(null);
      await mutate(servicesUrl);
      if (serviceDetailsUrl) {
        await mutate(serviceDetailsUrl);
      }
      if (toolsUrl) {
        await mutate(toolsUrl);
      }
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Unable to delete service.",
      );
    }
  };

  const hasDetailPanel = selectedServiceName !== null;

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
                        Provide service definition URL.
                      </p>
                    </div>
                    <div className="space-y-3">
                      <div className="space-y-2">
                        <Label htmlFor="service-type">Type</Label>
                        <Input
                          id="service-type"
                          onChange={(event) =>
                            setInstallType(event.target.value)
                          }
                          placeholder="registry"
                          value={installType}
                        />
                        {installErrors.type ? (
                          <p className="text-xs text-destructive">
                            {installErrors.type}
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
                      key={service.name}
                      type="button"
                      onClick={() => setSelectedServiceName(service.name)}
                      className={cn(
                        "text-left",
                        "border bg-card p-4",
                        "hover:bg-muted",
                        selectedServiceName === service.name
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
                                  detailService.name,
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
                                void handleUpdateService(detailService.name)
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
                                key={tool.name}
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
                                        detailService.name,
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
                                void handleSaveConfiguration(
                                  detailService.name,
                                );
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
                                void handleSaveSecrets(detailService.name);
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
                void handleDeleteService(deleteCandidate.name);
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
