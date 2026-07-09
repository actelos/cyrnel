import { Plus, RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";
import Markdown from "react-markdown";
import { Link } from "react-router-dom";
import remarkGfm from "remark-gfm";
import useSWR, { useSWRConfig } from "swr";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useNotification } from "@/hooks/use-notification";
import { apiFetch, apiFetchJson, buildUrl, errorMessageFrom } from "@/lib/api";
import { cn } from "@/lib/utils";

const serviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  adapter: z.string(),
  version: z.string(),
  enabled: z.boolean(),
  stale: z.boolean(),
});

const serviceListSchema = z.object({
  services: z.array(serviceSchema),
});

const moduleSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["adapter", "environment"]),
  description: z.string(),
  isBuiltin: z.boolean(),
  enabled: z.boolean(),
  missing: z.boolean(),
});

const moduleListSchema = z.object({
  modules: z.array(moduleSchema),
});

const manualServiceSchema = z.object({
  id: z
    .string()
    .trim()
    .regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/, {
      message: "Id must be a valid TypeScript identifier.",
    }),
  url: z.url({ message: "Definition URL must be a valid URL." }),
  adapter: z.string().trim().min(1, { message: "Adapter is required." }),
});

const registryServiceSchema = z.object({
  source: z.url({ message: "Source must be a valid URL." }),
  adapter: z.string().trim().optional(),
  id: z
    .string()
    .trim()
    .regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/, {
      message: "Id must be a valid TypeScript identifier.",
    })
    .optional(),
});

export default function ServicesPage() {
  const { mutate } = useSWRConfig();
  const [queryFilter, setQueryFilter] = useState("");
  const [enabledFilter, setEnabledFilter] = useState<
    "all" | "enabled" | "disabled"
  >("all");
  const [staleFilter, setStaleFilter] = useState<"all" | "stale" | "fresh">(
    "all",
  );
  const [adapterFilter, setAdapterFilter] = useState("all");
  const [isInstallOpen, setIsInstallOpen] = useState(false);
  const [installTab, setInstallTab] = useState<"manual" | "registry">(
    "registry",
  );
  const [manualId, setManualId] = useState("");
  const [manualUrl, setManualUrl] = useState("");
  const [manualAdapter, setManualAdapter] = useState("");
  const [manualErrors, setManualErrors] = useState<
    Partial<Record<"id" | "url" | "adapter" | "form", string>>
  >({});
  const [registrySource, setRegistrySource] = useState("");
  const [registryAdapter, setRegistryAdapter] = useState("");
  const [registryId, setRegistryId] = useState("");
  const [registryVersion, setRegistryVersion] = useState("");
  const [registryErrors, setRegistryErrors] = useState<
    Partial<Record<"source" | "adapter" | "id" | "version" | "form", string>>
  >({});
  const [isInstalling, setIsInstalling] = useState(false);
  const { addNotification } = useNotification();
  const normalizedQuery = queryFilter.trim();
  const enabledParam =
    enabledFilter === "all"
      ? undefined
      : enabledFilter === "enabled"
        ? "true"
        : "false";
  const staleParam =
    staleFilter === "all"
      ? undefined
      : staleFilter === "stale"
        ? "true"
        : "false";

  const servicesUrl = useMemo(() => {
    return buildUrl("/services", {
      query: normalizedQuery.length > 0 ? normalizedQuery : undefined,
      enabled: enabledParam,
      stale: staleParam,
      adapter: adapterFilter !== "all" ? adapterFilter : undefined,
    });
  }, [normalizedQuery, enabledParam, staleParam, adapterFilter]);

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

  const handleManualInstall = async () => {
    setManualErrors({});

    const parsed = manualServiceSchema.safeParse({
      id: manualId,
      url: manualUrl,
      adapter: manualAdapter,
    });

    if (!parsed.success) {
      const fieldErrors = z.flattenError(parsed.error).fieldErrors;
      setManualErrors({
        id: fieldErrors.id?.[0],
        url: fieldErrors.url?.[0],
        adapter: fieldErrors.adapter?.[0],
      });
      return;
    }

    setIsInstalling(true);
    try {
      await apiFetch(buildUrl("/services"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });

      setManualId("");
      setManualUrl("");
      setManualAdapter("");
      setIsInstallOpen(false);
      await mutate(servicesUrl);
      addNotification({
        type: "success",
        title: "Success",
        message: "Service installed.",
      });
    } catch (error) {
      addNotification({
        type: "error",
        title: "Error",
        message: errorMessageFrom(error, "Unable to install service."),
      });
    } finally {
      setIsInstalling(false);
    }
  };

  const handleRegistryInstall = async () => {
    setRegistryErrors({});

    const body: Record<string, string> = { source: registrySource.trim() };
    if (registryAdapter.trim()) body.adapter = registryAdapter.trim();
    if (registryId.trim()) body.id = registryId.trim();
    if (registryVersion.trim()) body.version = registryVersion.trim();

    const parsed = registryServiceSchema.safeParse(body);

    if (!parsed.success) {
      const fieldErrors = z.flattenError(parsed.error).fieldErrors;
      setRegistryErrors({
        source: fieldErrors.source?.[0],
        adapter: fieldErrors.adapter?.[0],
        id: fieldErrors.id?.[0],
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

      setRegistrySource("");
      setRegistryAdapter("");
      setRegistryId("");
      setIsInstallOpen(false);
      await mutate(servicesUrl);
      addNotification({
        type: "success",
        title: "Success",
        message: "Service installed.",
      });
    } catch (error) {
      addNotification({
        type: "error",
        title: "Error",
        message: errorMessageFrom(error, "Unable to install service."),
      });
    } finally {
      setIsInstalling(false);
    }
  };

  const handleSyncService = async (serviceId: string) => {
    try {
      await apiFetch(buildUrl(`/services/${serviceId}/sync`), {
        method: "POST",
      });
      await mutate(servicesUrl);
      addNotification({
        type: "success",
        title: "Success",
        message: "Service synced.",
      });
    } catch (error) {
      addNotification({
        type: "error",
        title: "Error",
        message: errorMessageFrom(error, "Unable to sync service."),
      });
    }
  };

  const handleToggleService = async (serviceId: string, enabled: boolean) => {
    try {
      await apiFetch(buildUrl(`/services/${serviceId}/enabled`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !enabled }),
      });
      await mutate(servicesUrl);
      addNotification({
        type: "success",
        title: "Success",
        message: `Service ${enabled ? "disabled" : "enabled"}.`,
      });
    } catch (error) {
      addNotification({
        type: "error",
        title: "Error",
        message: errorMessageFrom(error, "Failed to toggle service."),
      });
    }
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-6 p-6">
      <header className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-xl font-semibold">Services</h1>
            <p className="text-muted-foreground text-sm">
              Install, and manage services and tools.
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
                      Install from a registry or provide details manually.
                    </p>
                  </div>
                  <Tabs
                    value={installTab}
                    onValueChange={(v) =>
                      setInstallTab(v as "manual" | "registry")
                    }
                  >
                    <TabsList className="w-full">
                      <TabsTrigger className="flex-1" value="registry">
                        Registry
                      </TabsTrigger>
                      <TabsTrigger className="flex-1" value="manual">
                        Manual
                      </TabsTrigger>
                    </TabsList>
                    <TabsContent value="registry">
                      <div className="space-y-3 pt-2">
                        <div className="space-y-2">
                          <Label htmlFor="service-registry-id">
                            ID{" "}
                            <span className="text-muted-foreground">
                              (optional)
                            </span>
                          </Label>
                          <Input
                            id="service-registry-id"
                            onChange={(event) =>
                              setRegistryId(event.target.value)
                            }
                            placeholder="myService"
                            value={registryId}
                          />
                          {registryErrors.id ? (
                            <p className="text-xs text-destructive">
                              {registryErrors.id}
                            </p>
                          ) : null}
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="service-registry-source">
                            Source URL
                          </Label>
                          <Input
                            id="service-registry-source"
                            onChange={(event) =>
                              setRegistrySource(event.target.value)
                            }
                            placeholder="https://registry.example.com/service"
                            value={registrySource}
                          />
                          {registryErrors.source ? (
                            <p className="text-xs text-destructive">
                              {registryErrors.source}
                            </p>
                          ) : null}
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="service-registry-adapter">
                            Adapter
                          </Label>
                          {adapters.length > 0 ? (
                            <Select
                              onValueChange={setRegistryAdapter}
                              value={registryAdapter}
                            >
                              <SelectTrigger
                                id="service-registry-adapter"
                                className="w-full"
                              >
                                <SelectValue placeholder="From registry" />
                              </SelectTrigger>
                              <SelectContent>
                                {adapters.map((adapter) => (
                                  <SelectItem
                                    key={adapter.id}
                                    value={adapter.id}
                                  >
                                    {adapter.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ) : (
                            <Input
                              id="service-registry-adapter"
                              onChange={(event) =>
                                setRegistryAdapter(event.target.value)
                              }
                              placeholder="openapi"
                              value={registryAdapter}
                            />
                          )}
                          {registryErrors.adapter ? (
                            <p className="text-xs text-destructive">
                              {registryErrors.adapter}
                            </p>
                          ) : null}
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="service-registry-version">
                            Version{" "}
                            <span className="text-muted-foreground">
                              (optional, default: latest)
                            </span>
                          </Label>
                          <Input
                            id="service-registry-version"
                            onChange={(event) =>
                              setRegistryVersion(event.target.value)
                            }
                            placeholder="^1.0.0"
                            value={registryVersion}
                          />
                          {registryErrors.version ? (
                            <p className="text-xs text-destructive">
                              {registryErrors.version}
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
                            onClick={() => void handleRegistryInstall()}
                          >
                            {isInstalling ? "Installing" : "Install"}
                          </Button>
                        </div>
                      </div>
                    </TabsContent>
                    <TabsContent value="manual">
                      <div className="space-y-3 pt-2">
                        <div className="space-y-2">
                          <Label htmlFor="service-manual-id">ID</Label>
                          <Input
                            id="service-manual-id"
                            onChange={(event) =>
                              setManualId(event.target.value)
                            }
                            placeholder="myService"
                            value={manualId}
                          />
                          {manualErrors.id ? (
                            <p className="text-xs text-destructive">
                              {manualErrors.id}
                            </p>
                          ) : null}
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="service-manual-url">
                            Definition URL
                          </Label>
                          <Input
                            id="service-manual-url"
                            onChange={(event) =>
                              setManualUrl(event.target.value)
                            }
                            placeholder="https://example.com/manifest.json"
                            value={manualUrl}
                          />
                          {manualErrors.url ? (
                            <p className="text-xs text-destructive">
                              {manualErrors.url}
                            </p>
                          ) : null}
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="service-manual-adapter">
                            Adapter
                          </Label>
                          {adapters.length > 0 ? (
                            <Select
                              onValueChange={setManualAdapter}
                              value={manualAdapter}
                            >
                              <SelectTrigger
                                id="service-manual-adapter"
                                className="w-full"
                              >
                                <SelectValue placeholder="Select an adapter" />
                              </SelectTrigger>
                              <SelectContent>
                                {adapters.map((adapter) => (
                                  <SelectItem
                                    key={adapter.id}
                                    value={adapter.id}
                                  >
                                    {adapter.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ) : (
                            <Input
                              id="service-manual-adapter"
                              onChange={(event) =>
                                setManualAdapter(event.target.value)
                              }
                              placeholder="openapi"
                              value={manualAdapter}
                            />
                          )}
                          {manualErrors.adapter ? (
                            <p className="text-xs text-destructive">
                              {manualErrors.adapter}
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
                            onClick={() => void handleManualInstall()}
                          >
                            {isInstalling ? "Installing" : "Install"}
                          </Button>
                        </div>
                      </div>
                    </TabsContent>
                  </Tabs>
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex flex-1 items-center gap-2">
            <Input
              placeholder="Filter by a query"
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
            <Select
              onValueChange={(value) =>
                setStaleFilter(value as "all" | "stale" | "fresh")
              }
              value={staleFilter}
            >
              <SelectTrigger className="w-[170px]">
                <SelectValue placeholder="Stale" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All states</SelectItem>
                <SelectItem value="stale">Stale</SelectItem>
                <SelectItem value="fresh">Fresh</SelectItem>
              </SelectContent>
            </Select>
            <Select onValueChange={setAdapterFilter} value={adapterFilter}>
              <SelectTrigger className="w-[170px]">
                <SelectValue placeholder="Adapter" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All adapters</SelectItem>
                {adapters.map((adapter) => (
                  <SelectItem key={adapter.id} value={adapter.id}>
                    {adapter.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="outline"
              className="gap-2"
              onClick={() => {
                mutate(servicesUrl)
                  .then(() => {
                    addNotification({
                      type: "success",
                      title: "Success",
                      message: "Services refreshed.",
                    });
                  })
                  .catch((error) => {
                    addNotification({
                      type: "error",
                      title: "Error",
                      message: errorMessageFrom(
                        error,
                        "Failed to refresh services.",
                      ),
                    });
                  });
              }}
              aria-label="Refresh services"
            >
              <RotateCcw />
            </Button>
          </div>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-6">
        <Card className="flex min-h-0 flex-1 flex-col max-h-[calc(100vh-10.8rem)]">
          <CardContent className="min-h-0 flex-1">
            <ScrollArea className="h-full">
              <div className="grid gap-4 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
                {services.map((service) => (
                  <div
                    key={service.id}
                    className="flex flex-col justify-between border bg-card p-4 border-border"
                  >
                    <Link
                      to={`/services/${service.id}`}
                      className="block -mx-4 -mt-4 -mr-4 mb-3 p-4"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="space-y-2 min-w-0">
                          <div className="flex items-center justify-between flex-wrap gap-2">
                            <h3 className="text-sm font-semibold">
                              {service.name}
                            </h3>
                            <Badge variant="secondary">{service.adapter}</Badge>
                            {service.stale ? (
                              <Badge variant="destructive">Stale</Badge>
                            ) : null}
                          </div>
                          <p className="text-muted-foreground text-xs font-mono truncate max-w-full">
                            {service.id}
                          </p>
                          <div className="text-muted-foreground text-xs line-clamp-3">
                            {service.description ? (
                              <Markdown
                                components={{
                                  p: ({ children }) => <>{children}</>,
                                }}
                                remarkPlugins={[remarkGfm]}
                              >
                                {service.description}
                              </Markdown>
                            ) : (
                              "No description"
                            )}
                          </div>
                        </div>
                      </div>
                    </Link>
                    {service.stale ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="w-full mb-2 gap-2"
                        onClick={() => void handleSyncService(service.id)}
                      >
                        <RotateCcw />
                        Sync
                      </Button>
                    ) : null}
                    <div
                      className="flex cursor-pointer items-center justify-between gap-2"
                      onClick={() => {
                        void handleToggleService(service.id, service.enabled);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          void handleToggleService(service.id, service.enabled);
                        }
                      }}
                      role="switch"
                      aria-checked={service.enabled}
                      tabIndex={0}
                    >
                      <span className="text-xs text-muted-foreground">
                        {service.enabled ? "Enabled" : "Disabled"}
                      </span>
                      <span
                        className={cn(
                          "inline-flex h-6 w-11 items-center transition",
                          service.enabled ? "bg-primary" : "bg-secondary",
                        )}
                      >
                        <span
                          className={cn(
                            "inline-block h-4 w-4 transform bg-background shadow transition",
                            service.enabled ? "translate-x-6" : "translate-x-1",
                          )}
                        />
                      </span>
                    </div>
                  </div>
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
            </ScrollArea>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
