import { ChevronDown, Library, Plus, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import useSWR, { useSWRConfig } from "swr";
import useSWRInfinite from "swr/infinite";
import { z } from "zod";
import { InstalledServiceCard } from "@/components/installed-service-card";
import { RegistryServiceCard } from "@/components/registry-service-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useNotification } from "@/hooks/use-notification";
import { useUpdateSearchParams } from "@/hooks/use-update-search-params";
import { apiFetch, apiFetchJson, buildUrl, errorMessageFrom } from "@/lib/api";

const serviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  summary: z.string(),
  description: z.string(),
  source: z.string(),
  adapter: z.string(),
  version: z.string(),
  enabled: z.boolean(),
  stale: z.boolean(),
  hasIcon: z.boolean(),
});

const serviceListSchema = z.object({
  items: z.array(serviceSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});

type Service = z.infer<typeof serviceSchema>;

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
  items: z.array(moduleSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
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

const adapterListBaseParams: Record<string, string | undefined> = {
  type: "adapter",
  enabled: "true",
  limit: "100",
};

const registryListSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      baseUrl: z.string(),
      lastSyncedAt: z.string().nullable(),
      createdAt: z.string(),
      updatedAt: z.string(),
    }),
  ),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});

const exploreEntrySchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  source: z.string(),
  kind: z.string().optional(),
  type: z.enum(["adapter", "environment"]).optional(),
  icon: z.string().optional(),
});

const definitionsPageSchema = z.object({
  definitions: z.array(exploreEntrySchema),
  nextCursor: z.string().nullable(),
});

function ExploreRegistryGroup({
  registryId,
  query,
  onInstalled,
  onCountChange,
  installedServices,
}: {
  registryId: string;
  query: string;
  onInstalled: () => void | Promise<void>;
  onCountChange: (registryId: string, count: number) => void;
  installedServices: Service[];
}) {
  const normalizedQuery = query.trim();

  const getBrowseKey = (
    pageIndex: number,
    previousPageData: z.infer<typeof definitionsPageSchema> | null,
  ) => {
    if (previousPageData && previousPageData.nextCursor === null) return null;
    const cursor =
      pageIndex === 0 ? undefined : (previousPageData?.nextCursor ?? undefined);
    return buildUrl(`/registries/${registryId}/definitions`, {
      query: normalizedQuery.length > 0 ? normalizedQuery : undefined,
      cursor,
      limit: "20",
    });
  };

  const {
    data: pages,
    error: browseError,
    size,
    setSize,
    isLoading: isLoadingBrowse,
  } = useSWRInfinite(
    getBrowseKey,
    (url) => apiFetchJson(url, definitionsPageSchema),
    { refreshInterval: 30000 },
  );

  const entries = useMemo(
    () => (pages ?? []).flatMap((page) => page.definitions),
    [pages],
  );

  const installedServiceIdBySource = useMemo(() => {
    const bySource = new Map<string, string>();
    for (const service of installedServices) {
      if (service.source && !bySource.has(service.source)) {
        bySource.set(service.source, service.id);
      }
    }
    return bySource;
  }, [installedServices]);

  const installedServiceIds = useMemo(
    () => new Set(installedServices.map((service) => service.id)),
    [installedServices],
  );

  const hasMore = pages ? pages[pages.length - 1]?.nextCursor !== null : false;

  useEffect(() => {
    onCountChange(registryId, entries.length);
  }, [registryId, entries.length, onCountChange]);

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {entries.map((entry) => (
          <RegistryServiceCard
            key={entry.id}
            entry={entry}
            registryId={registryId}
            onInstalled={onInstalled}
            installedServiceId={
              installedServiceIds.has(entry.id)
                ? entry.id
                : (installedServiceIdBySource.get(entry.source) ?? null)
            }
          />
        ))}
      </div>
      {browseError ? (
        <p className="text-sm text-destructive">
          Failed to load registry entries.
        </p>
      ) : null}
      {!isLoadingBrowse && !browseError && entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No entries match the current filters.
        </p>
      ) : null}
      {hasMore ? (
        <div className="flex justify-center">
          <Button
            type="button"
            variant="outline"
            className="gap-2"
            onClick={() => void setSize(size + 1)}
          >
            <ChevronDown />
            Load more
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export default function ServicesPage() {
  const { mutate } = useSWRConfig();
  const [searchParams] = useSearchParams();
  const updateSearchParams = useUpdateSearchParams();

  const viewTab =
    searchParams.get("tab") === "explore" ? "explore" : "installed";
  const queryFilter = searchParams.get("q") ?? "";
  const rawEnabledFilter = searchParams.get("enabled");
  const enabledFilter =
    rawEnabledFilter === "enabled" || rawEnabledFilter === "disabled"
      ? rawEnabledFilter
      : "all";
  const rawStaleFilter = searchParams.get("stale");
  const staleFilter =
    rawStaleFilter === "stale" || rawStaleFilter === "fresh"
      ? rawStaleFilter
      : "all";
  const adapterFilter = searchParams.get("adapter") ?? "all";
  const exploreQuery = searchParams.get("eq") ?? "";
  const exploreRegistry = searchParams.get("registry") ?? "all";
  const [isInstallOpen, setIsInstallOpen] = useState(false);
  const [exploreCounts, setExploreCounts] = useState<Record<string, number>>(
    {},
  );
  const [manualId, setManualId] = useState("");
  const [manualUrl, setManualUrl] = useState("");
  const [manualAdapter, setManualAdapter] = useState("");
  const [manualErrors, setManualErrors] = useState<
    Partial<Record<"id" | "url" | "adapter" | "form", string>>
  >({});
  const [isInstalling, setIsInstalling] = useState(false);
  const [togglingIds, setTogglingIds] = useState<Record<string, boolean>>({});
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

  const debouncedExploreQuery = useDebouncedValue(exploreQuery, 300);

  const servicesUrl = useMemo(() => {
    return buildUrl("/services", {
      query: normalizedQuery.length > 0 ? normalizedQuery : undefined,
      enabled: enabledParam,
      stale: staleParam,
      adapter: adapterFilter !== "all" ? adapterFilter : undefined,
      limit: "100",
    });
  }, [normalizedQuery, enabledParam, staleParam, adapterFilter]);

  const adaptersUrl = useMemo(
    () => buildUrl("/modules", adapterListBaseParams),
    [],
  );

  const registriesUrl = useMemo(
    () => buildUrl("/registries", { limit: "100" }),
    [],
  );

  const {
    data: serviceList,
    error: servicesError,
    isLoading: isLoadingServices,
    isValidating: isServiceListValidating,
  } = useSWR(servicesUrl, (url) => apiFetchJson(url, serviceListSchema), {
    refreshInterval: 8000,
  });

  const { data: adapterList } = useSWR(
    adaptersUrl,
    async (): Promise<Array<z.infer<typeof moduleSchema>>> => {
      const adapters: Array<z.infer<typeof moduleSchema>> = [];
      let cursor: string | null = null;
      for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
        const page: z.infer<typeof moduleListSchema> = await apiFetchJson(
          buildUrl("/modules", {
            ...adapterListBaseParams,
            ...(cursor !== null ? { cursor } : {}),
          }),
          moduleListSchema,
        );
        adapters.push(...page.items);
        if (page.nextCursor === null || page.items.length === 0) break;
        cursor = page.nextCursor;
      }
      return adapters;
    },
    { refreshInterval: 30000 },
  );

  const adapters = useMemo(() => adapterList ?? [], [adapterList]);

  const { data: registryList, isLoading: isLoadingRegistries } = useSWR(
    registriesUrl,
    (url) => apiFetchJson(url, registryListSchema),
    { refreshInterval: 30000 },
  );

  const registries = useMemo(() => registryList?.items ?? [], [registryList]);

  const handleExploreCount = useCallback(
    (registryId: string, count: number) => {
      setExploreCounts((previous) =>
        previous[registryId] === count
          ? previous
          : { ...previous, [registryId]: count },
      );
    },
    [],
  );

  const exploreTotal = useMemo(() => {
    const visibleIds =
      exploreRegistry === "all"
        ? registries.map((registry) => registry.id)
        : [exploreRegistry];
    return visibleIds.reduce((sum, id) => sum + (exploreCounts[id] ?? 0), 0);
  }, [exploreCounts, exploreRegistry, registries]);

  const [extraServices, setExtraServices] = useState<Service[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const paginationVersionRef = useRef(0);

  useEffect(() => {
    if (servicesUrl === "") return;
    paginationVersionRef.current += 1;
    setExtraServices([]);
    setNextCursor(null);
    setLoadMoreError(null);
  }, [servicesUrl]);

  useEffect(() => {
    if (
      extraServices.length === 0 &&
      serviceList !== undefined &&
      !isServiceListValidating
    ) {
      setNextCursor(serviceList.nextCursor);
    }
  }, [serviceList, extraServices.length, isServiceListValidating]);

  const services = useMemo(() => {
    const seen = new Set<string>();
    const merged: Service[] = [];
    for (const service of [...(serviceList?.items ?? []), ...extraServices]) {
      if (seen.has(service.id)) continue;
      seen.add(service.id);
      merged.push(service);
    }
    return merged;
  }, [serviceList, extraServices]);

  const refreshServices = async () => {
    paginationVersionRef.current += 1;
    setExtraServices([]);
    setNextCursor(null);
    setLoadMoreError(null);
    await mutate(servicesUrl);
  };

  const loadMoreServices = async () => {
    if (nextCursor === null || isLoadingMore) return;
    const startedVersion = paginationVersionRef.current;
    setIsLoadingMore(true);
    setLoadMoreError(null);
    try {
      const data = await apiFetchJson(
        buildUrl("/services", {
          query: normalizedQuery.length > 0 ? normalizedQuery : undefined,
          enabled: enabledParam,
          stale: staleParam,
          adapter: adapterFilter !== "all" ? adapterFilter : undefined,
          limit: "100",
          cursor: nextCursor,
        }),
        serviceListSchema,
      );
      if (paginationVersionRef.current !== startedVersion) return;
      setExtraServices((previous) => [...previous, ...data.items]);
      setNextCursor(data.nextCursor);
    } catch (error) {
      if (paginationVersionRef.current !== startedVersion) return;
      setLoadMoreError(
        errorMessageFrom(error, "Failed to load more services."),
      );
    } finally {
      setIsLoadingMore(false);
    }
  };

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
      await refreshServices();
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
      await refreshServices();
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

  const handleToggleService = async (service: Service) => {
    const nextEnabled = !service.enabled;
    setTogglingIds((previous) => ({ ...previous, [service.id]: true }));
    try {
      await apiFetch(buildUrl(`/services/${service.id}/enabled`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: nextEnabled }),
      });
      await refreshServices();
      addNotification({
        type: "success",
        title: "Success",
        message: `Service ${nextEnabled ? "enabled" : "disabled"}.`,
      });
    } catch (error) {
      addNotification({
        type: "error",
        title: "Error",
        message: errorMessageFrom(error, "Unable to update service state."),
      });
    } finally {
      setTogglingIds((previous) => {
        const next = { ...previous };
        delete next[service.id];
        return next;
      });
    }
  };

  const selectedRegistry =
    exploreRegistry === "all"
      ? undefined
      : registries.find((registry) => registry.id === exploreRegistry);

  return (
    <section className="flex flex-1 flex-col px-6 pb-6">
      <div className="space-y-1 pt-4">
        <h1 className="text-xl font-semibold">Services</h1>
        <p className="text-muted-foreground text-sm">
          Install, and manage services and tools.
        </p>
      </div>
      <div className="sticky top-0 z-10 -mx-6 flex flex-col gap-4 border-b bg-background px-6 py-4 mb-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <Tabs
            value={viewTab}
            onValueChange={(v) =>
              updateSearchParams({
                tab: v === "explore" ? "explore" : undefined,
              })
            }
          >
            <TabsList>
              <TabsTrigger value="explore">
                Explore ({exploreTotal})
              </TabsTrigger>
              <TabsTrigger value="installed">
                Installed ({services.length})
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="flex flex-wrap items-center gap-2">
            {viewTab === "explore" ? (
              <Button type="button" className="gap-2" asChild>
                <Link to="/registries">
                  <Plus />
                  Add registry
                </Link>
              </Button>
            ) : (
              <Popover open={isInstallOpen} onOpenChange={setIsInstallOpen}>
                <PopoverTrigger asChild>
                  <Button className="gap-2" type="button">
                    <Plus />
                    Install Custom Service
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-[26rem]">
                  <div className="space-y-4">
                    <div className="space-y-1">
                      <h3 className="text-sm font-medium">
                        Install custom service
                      </h3>
                      <p className="text-muted-foreground text-xs">
                        Provide details to install a service manually.
                      </p>
                    </div>
                    <div className="space-y-3">
                      <div className="space-y-2">
                        <Label htmlFor="service-manual-id">ID</Label>
                        <Input
                          id="service-manual-id"
                          onChange={(event) => setManualId(event.target.value)}
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
                          onChange={(event) => setManualUrl(event.target.value)}
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
                        <Label htmlFor="service-manual-adapter">Adapter</Label>
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
                                <SelectItem key={adapter.id} value={adapter.id}>
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
                </PopoverContent>
              </Popover>
            )}
          </div>
        </div>
        {viewTab === "installed" ? (
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex min-w-[200px] flex-1 items-center gap-2">
              <Input
                placeholder="Search services"
                value={queryFilter}
                onChange={(event) =>
                  updateSearchParams({ q: event.target.value || undefined })
                }
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                onValueChange={(value) =>
                  updateSearchParams({
                    enabled: value === "all" ? undefined : value,
                  })
                }
                value={enabledFilter}
              >
                <SelectTrigger className="min-w-[140px] flex-1 sm:w-[170px] sm:flex-none">
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
                  updateSearchParams({
                    stale: value === "all" ? undefined : value,
                  })
                }
                value={staleFilter}
              >
                <SelectTrigger className="min-w-[140px] flex-1 sm:w-[170px] sm:flex-none">
                  <SelectValue placeholder="Stale" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All states</SelectItem>
                  <SelectItem value="stale">Stale</SelectItem>
                  <SelectItem value="fresh">Fresh</SelectItem>
                </SelectContent>
              </Select>
              <Select
                onValueChange={(value) =>
                  updateSearchParams({
                    adapter: value === "all" ? undefined : value,
                  })
                }
                value={adapterFilter}
              >
                <SelectTrigger className="min-w-[140px] flex-1 sm:w-[170px] sm:flex-none">
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
                className="shrink-0 gap-2"
                onClick={() => {
                  refreshServices()
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
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex min-w-[200px] flex-1 items-center gap-2">
              <Input
                placeholder="Search services"
                value={exploreQuery}
                onChange={(event) =>
                  updateSearchParams({ eq: event.target.value || undefined })
                }
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                onValueChange={(value) =>
                  updateSearchParams({
                    registry: value === "all" ? undefined : value,
                  })
                }
                value={exploreRegistry}
              >
                <SelectTrigger className="min-w-[140px] flex-1 sm:w-[170px] sm:flex-none">
                  <SelectValue placeholder="Registry" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All registries</SelectItem>
                  {registries.map((registry) => (
                    <SelectItem key={registry.id} value={registry.id}>
                      {registry.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}
      </div>
      {viewTab === "installed" ? (
        <div className="flex flex-col gap-6">
          <div className="grid gap-4 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
            {services.map((service) => (
              <InstalledServiceCard
                key={service.id}
                service={service}
                onSync={() => void handleSyncService(service.id)}
                onToggle={() => void handleToggleService(service)}
                isToggling={togglingIds[service.id] ?? false}
              />
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
          {nextCursor !== null ? (
            <div className="flex justify-center p-4">
              <Button
                type="button"
                variant="outline"
                className="gap-2"
                disabled={isLoadingMore}
                onClick={() => void loadMoreServices()}
              >
                <ChevronDown />
                {isLoadingMore ? "Loading more…" : "Load more"}
              </Button>
            </div>
          ) : null}
          {loadMoreError !== null ? (
            <p className="p-4 text-sm text-destructive">{loadMoreError}</p>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {isLoadingRegistries && registries.length === 0 ? (
            <p className="text-sm text-muted-foreground">Loading registries…</p>
          ) : registries.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-dashed p-6 text-center">
              <p className="text-sm text-muted-foreground">
                No registries yet. Add one to browse and install services.
              </p>
              <Button type="button" variant="outline" size="sm" asChild>
                <Link to="/registries">
                  <Library />
                  Add a registry
                </Link>
              </Button>
            </div>
          ) : exploreRegistry === "all" ? (
            registries.map((registry) => (
              <section key={registry.id} className="flex flex-col gap-3">
                <div className="min-w-0 space-y-2">
                  <h3 className="text-sm font-semibold">
                    {registry.id} ({exploreCounts[registry.id] ?? 0} results)
                  </h3>
                  <p className="text-muted-foreground truncate text-xs">
                    {registry.baseUrl}
                  </p>
                </div>
                <ExploreRegistryGroup
                  registryId={registry.id}
                  query={debouncedExploreQuery}
                  onInstalled={refreshServices}
                  onCountChange={handleExploreCount}
                  installedServices={services}
                />
              </section>
            ))
          ) : selectedRegistry ? (
            <div className="flex flex-col gap-3">
              <p className="px-1 text-xs text-muted-foreground truncate">
                URL: {selectedRegistry.baseUrl} •{" "}
                {exploreCounts[selectedRegistry.id] ?? 0} results
              </p>
              <ExploreRegistryGroup
                registryId={selectedRegistry.id}
                query={debouncedExploreQuery}
                onInstalled={refreshServices}
                onCountChange={handleExploreCount}
                installedServices={services}
              />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Select a registry to browse and install its entries.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
