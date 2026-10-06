import {
  Blocks,
  ChevronDown,
  Library,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import useSWR, { useSWRConfig } from "swr";
import useSWRInfinite from "swr/infinite";
import { z } from "zod";
import { AddRegistryPopover } from "@/components/add-registry-dialog";
import { InstalledModuleCard } from "@/components/installed-module-card";
import { RegistryModuleCard } from "@/components/registry-module-card";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
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

const moduleSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["adapter", "environment"]),
  summary: z.string(),
  description: z.string(),
  version: z.string(),
  isBuiltin: z.boolean(),
  enabled: z.boolean(),
  missing: z.boolean(),
  hasIcon: z.boolean(),
});

const moduleListSchema = z.object({
  items: z.array(moduleSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});

type Module = z.infer<typeof moduleSchema>;

const registryItemSchema = z.object({
  id: z.string(),
  baseUrl: z.string(),
  isDefault: z.boolean(),
  lastSyncedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const registryListSchema = z.object({
  items: z.array(registryItemSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});

const defaultRegistrySchema = z.object({
  registry: registryItemSchema.nullable(),
});

const exploreModuleEntrySchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  source: z.string(),
  kind: z.string().optional(),
  type: z.enum(["adapter", "environment"]).optional(),
  icon: z.object({ url: z.string(), hash: z.string() }).optional(),
});

const modulesPageSchema = z.object({
  modules: z.array(exploreModuleEntrySchema),
  nextCursor: z.string().nullable(),
});

function ExploreModuleGroup({
  registryId,
  query,
  type,
  onInstalled,
  onCountChange,
  installedModules,
  onRegistryAdded,
}: {
  registryId: string;
  query: string;
  type: "all" | "adapter" | "environment";
  onInstalled: () => void | Promise<void>;
  onCountChange: (registryId: string, count: number) => void;
  installedModules: Module[];
  onRegistryAdded: () => void | Promise<void>;
}) {
  const normalizedQuery = query.trim();

  const getBrowseKey = (
    pageIndex: number,
    previousPageData: z.infer<typeof modulesPageSchema> | null,
  ) => {
    if (previousPageData && previousPageData.nextCursor === null) return null;
    const cursor =
      pageIndex === 0 ? undefined : (previousPageData?.nextCursor ?? undefined);
    return buildUrl(`/registries/${registryId}/modules`, {
      query: normalizedQuery.length > 0 ? normalizedQuery : undefined,
      type: type === "all" ? undefined : type,
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
    (url) => apiFetchJson(url, modulesPageSchema),
    { refreshInterval: 30000 },
  );

  const entries = useMemo(
    () => (pages ?? []).flatMap((page) => page.modules),
    [pages],
  );

  const installedModuleIds = useMemo(
    () => new Set(installedModules.map((module) => module.id)),
    [installedModules],
  );

  const hasMore = pages ? pages[pages.length - 1]?.nextCursor !== null : false;

  useEffect(() => {
    onCountChange(registryId, entries.length);
  }, [registryId, entries.length, onCountChange]);

  return (
    <div className="flex flex-col gap-3 h-full">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {entries.map((entry) => (
          <RegistryModuleCard
            key={entry.id}
            entry={entry}
            registryId={registryId}
            onInstalled={onInstalled}
            installedModuleId={
              installedModuleIds.has(entry.id) ? entry.id : null
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
        <div className="flex items-center justify-center h-full py-12">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Search aria-hidden />
              </EmptyMedia>
              <EmptyTitle>No entries found</EmptyTitle>
              <EmptyDescription>
                No entries match the current filters. Try adjusting your search
                or{" "}
                <AddRegistryPopover onAdded={onRegistryAdded} align="center">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="underline"
                    type="button"
                  >
                    add a registry
                  </Button>
                </AddRegistryPopover>
                .
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
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

export default function SettingsModulesPage() {
  const { mutate } = useSWRConfig();
  const [searchParams] = useSearchParams();
  const updateSearchParams = useUpdateSearchParams();

  const viewTab =
    searchParams.get("tab") === "explore" ? "explore" : "installed";
  const queryFilter = searchParams.get("q") ?? "";
  const rawTypeFilter = searchParams.get("type");
  const typeFilter =
    rawTypeFilter === "adapter" || rawTypeFilter === "environment"
      ? rawTypeFilter
      : "all";
  const rawEnabledFilter = searchParams.get("enabled");
  const enabledFilter =
    rawEnabledFilter === "enabled" || rawEnabledFilter === "disabled"
      ? rawEnabledFilter
      : "all";
  const rawBuiltinFilter = searchParams.get("builtin");
  const builtinFilter =
    rawBuiltinFilter === "builtin" || rawBuiltinFilter === "custom"
      ? rawBuiltinFilter
      : "all";
  const exploreQuery = searchParams.get("eq") ?? "";
  const exploreRegistryParam = searchParams.get("registry");
  const rawExploreType = searchParams.get("etype");
  const exploreType =
    rawExploreType === "adapter" || rawExploreType === "environment"
      ? rawExploreType
      : "all";
  const [isInstallOpen, setIsInstallOpen] = useState(false);
  const [exploreCounts, setExploreCounts] = useState<Record<string, number>>(
    {},
  );
  const [manualUrl, setManualUrl] = useState("");
  const [isInstalling, setIsInstalling] = useState(false);
  const [isReloading, setIsReloading] = useState(false);
  const [togglingIds, setTogglingIds] = useState<Record<string, boolean>>({});
  const { addNotification } = useNotification();
  const normalizedQuery = queryFilter.trim();
  const enabledParam =
    enabledFilter === "all"
      ? undefined
      : enabledFilter === "enabled"
        ? "true"
        : "false";
  const builtinParam =
    builtinFilter === "all"
      ? undefined
      : builtinFilter === "builtin"
        ? "true"
        : "false";

  const debouncedExploreQuery = useDebouncedValue(exploreQuery, 300);

  const modulesUrl = useMemo(() => {
    return buildUrl("/modules", {
      query: normalizedQuery.length > 0 ? normalizedQuery : undefined,
      type: typeFilter === "all" ? undefined : typeFilter,
      enabled: enabledParam,
      isBuiltin: builtinParam,
      limit: "100",
    });
  }, [normalizedQuery, typeFilter, enabledParam, builtinParam]);

  const registriesUrl = useMemo(
    () => buildUrl("/registries", { limit: "100" }),
    [],
  );

  const {
    data: moduleList,
    error: modulesError,
    isLoading: isLoadingModules,
    isValidating: isModuleListValidating,
  } = useSWR(modulesUrl, (url) => apiFetchJson(url, moduleListSchema), {
    refreshInterval: 8000,
  });

  const { data: registryList, isLoading: isLoadingRegistries } = useSWR(
    registriesUrl,
    (url) => apiFetchJson(url, registryListSchema),
    { refreshInterval: 30000 },
  );

  const registries = useMemo(() => registryList?.items ?? [], [registryList]);

  const defaultRegistryUrl = useMemo(() => buildUrl("/registries/default"), []);

  const { data: defaultRegistryData } = useSWR(
    defaultRegistryUrl,
    (url) => apiFetchJson(url, defaultRegistrySchema),
    { refreshInterval: 30000 },
  );

  const defaultRegistry = defaultRegistryData?.registry ?? null;

  const effectiveRegistryId = useMemo(() => {
    if (
      exploreRegistryParam !== null &&
      registries.some((registry) => registry.id === exploreRegistryParam)
    ) {
      return exploreRegistryParam;
    }
    if (
      defaultRegistry !== null &&
      registries.some((registry) => registry.id === defaultRegistry.id)
    ) {
      return defaultRegistry.id;
    }
    return registries[0]?.id;
  }, [exploreRegistryParam, defaultRegistry, registries]);

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
    if (effectiveRegistryId === undefined) return 0;
    return exploreCounts[effectiveRegistryId] ?? 0;
  }, [exploreCounts, effectiveRegistryId]);

  const [extraModules, setExtraModules] = useState<Module[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const paginationVersionRef = useRef(0);

  useEffect(() => {
    if (modulesUrl === "") return;
    paginationVersionRef.current += 1;
    setExtraModules([]);
    setNextCursor(null);
    setLoadMoreError(null);
  }, [modulesUrl]);

  useEffect(() => {
    if (
      extraModules.length === 0 &&
      moduleList !== undefined &&
      !isModuleListValidating
    ) {
      setNextCursor(moduleList.nextCursor);
    }
  }, [moduleList, extraModules.length, isModuleListValidating]);

  const modules = useMemo(() => {
    const seen = new Set<string>();
    const merged: Module[] = [];
    for (const installedModule of [
      ...(moduleList?.items ?? []),
      ...extraModules,
    ]) {
      if (seen.has(installedModule.id)) continue;
      seen.add(installedModule.id);
      merged.push(installedModule);
    }
    return merged;
  }, [moduleList, extraModules]);

  const refreshModules = async () => {
    paginationVersionRef.current += 1;
    setExtraModules([]);
    setNextCursor(null);
    setLoadMoreError(null);
    await mutate(modulesUrl);
  };

  const loadMoreModules = async () => {
    if (nextCursor === null || isLoadingMore) return;
    const startedVersion = paginationVersionRef.current;
    setIsLoadingMore(true);
    setLoadMoreError(null);
    try {
      const data = await apiFetchJson(
        buildUrl("/modules", {
          query: normalizedQuery.length > 0 ? normalizedQuery : undefined,
          type: typeFilter === "all" ? undefined : typeFilter,
          enabled: enabledParam,
          isBuiltin: builtinParam,
          limit: "100",
          cursor: nextCursor,
        }),
        moduleListSchema,
      );
      if (paginationVersionRef.current !== startedVersion) return;
      setExtraModules((previous) => [...previous, ...data.items]);
      setNextCursor(data.nextCursor);
    } catch (error) {
      if (paginationVersionRef.current !== startedVersion) return;
      const message = errorMessageFrom(error, "Failed to load more modules.");
      setLoadMoreError(message);
      addNotification({
        type: "error",
        title: "Load more failed",
        message,
      });
    } finally {
      setIsLoadingMore(false);
    }
  };

  const handleManualInstall = async () => {
    const trimmed = manualUrl.trim();
    if (!trimmed) {
      addNotification({
        type: "error",
        title: "URL required",
        message: "URL is required.",
      });
      return;
    }
    setIsInstalling(true);
    try {
      await apiFetch(buildUrl("/modules"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: trimmed }),
      });
      setManualUrl("");
      setIsInstallOpen(false);
      await refreshModules();
      addNotification({
        type: "success",
        title: "Module installed",
        message: "Module installed.",
      });
    } catch (error) {
      addNotification({
        type: "error",
        title: "Module installation failed",
        message: errorMessageFrom(error, "Unable to install module."),
      });
    } finally {
      setIsInstalling(false);
    }
  };

  const handleReloadModules = async () => {
    setIsReloading(true);
    try {
      await apiFetch(buildUrl("/modules/reload"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      await refreshModules();
      addNotification({
        type: "success",
        title: "Modules reloaded",
        message: "Modules reloaded.",
      });
    } catch (error) {
      addNotification({
        type: "error",
        title: "Modules reload failed",
        message: errorMessageFrom(error, "Unable to reload modules."),
      });
    } finally {
      setIsReloading(false);
    }
  };

  const handleToggleModule = async (installedModule: Module) => {
    const nextEnabled = !installedModule.enabled;
    setTogglingIds((previous) => ({
      ...previous,
      [installedModule.id]: true,
    }));
    try {
      await apiFetch(buildUrl(`/modules/${installedModule.id}/enabled`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: nextEnabled }),
      });
      await refreshModules();
      addNotification({
        type: "success",
        title: `Module ${nextEnabled ? "enabled" : "disabled"}`,
        message: `Module ${nextEnabled ? "enabled" : "disabled"}.`,
      });
    } catch (error) {
      addNotification({
        type: "error",
        title: "Module state update failed",
        message: errorMessageFrom(error, "Unable to update module state."),
      });
    } finally {
      setTogglingIds((previous) => {
        const next = { ...previous };
        delete next[installedModule.id];
        return next;
      });
    }
  };

  const selectedRegistry = registries.find(
    (registry) => registry.id === effectiveRegistryId,
  );

  return (
    <section className="flex flex-1 flex-col px-6 pb-6">
      <div className="space-y-1 pt-4">
        <h1 className="text-xl font-semibold">Modules</h1>
        <p className="text-muted-foreground text-sm">
          Manage adapter and environment modules.
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
                Installed ({modules.length})
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="flex flex-wrap items-center gap-2">
            {viewTab === "explore" ? (
              <AddRegistryPopover onAdded={() => void mutate(registriesUrl)}>
                <Button type="button" className="gap-2">
                  <Plus />
                  Add registry
                </Button>
              </AddRegistryPopover>
            ) : (
              <>
                <Popover open={isInstallOpen} onOpenChange={setIsInstallOpen}>
                  <PopoverTrigger asChild>
                    <Button className="gap-2" type="button">
                      <Plus />
                      Install Module
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-[26rem]">
                    <div className="space-y-4">
                      <div className="space-y-1">
                        <h3 className="text-sm font-medium">
                          Install custom module
                        </h3>
                        <p className="text-muted-foreground text-xs">
                          Provide a URL to install a module archive.
                        </p>
                      </div>
                      <div className="space-y-3">
                        <div className="space-y-2">
                          <Label htmlFor="module-manual-url">Archive URL</Label>
                          <Input
                            id="module-manual-url"
                            onChange={(event) =>
                              setManualUrl(event.target.value)
                            }
                            placeholder="https://example.com/module.tar.zst"
                            value={manualUrl}
                          />
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
                          disabled={isInstalling || !manualUrl.trim()}
                          onClick={() => void handleManualInstall()}
                        >
                          {isInstalling ? "Installing" : "Install"}
                        </Button>
                      </div>
                    </div>
                  </PopoverContent>
                </Popover>
                <Button
                  type="button"
                  variant="secondary"
                  className="gap-2"
                  disabled={isReloading}
                  onClick={() => void handleReloadModules()}
                >
                  <RefreshCw />
                  {isReloading ? "Reloading" : "Reload"}
                </Button>
              </>
            )}
          </div>
        </div>
        {viewTab === "installed" ? (
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex min-w-[200px] flex-1 items-center gap-2">
              <Input
                placeholder="Search modules"
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
                    type: value === "all" ? undefined : value,
                  })
                }
                value={typeFilter}
              >
                <SelectTrigger className="min-w-[140px] flex-1 sm:w-[170px] sm:flex-none">
                  <SelectValue placeholder="Type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All types</SelectItem>
                  <SelectItem value="adapter">Adapter</SelectItem>
                  <SelectItem value="environment">Environment</SelectItem>
                </SelectContent>
              </Select>
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
                  <SelectItem value="all">All states</SelectItem>
                  <SelectItem value="enabled">Enabled</SelectItem>
                  <SelectItem value="disabled">Disabled</SelectItem>
                </SelectContent>
              </Select>
              <Select
                onValueChange={(value) =>
                  updateSearchParams({
                    builtin: value === "all" ? undefined : value,
                  })
                }
                value={builtinFilter}
              >
                <SelectTrigger className="min-w-[140px] flex-1 sm:w-[170px] sm:flex-none">
                  <SelectValue placeholder="Origin" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All origins</SelectItem>
                  <SelectItem value="builtin">Built-in</SelectItem>
                  <SelectItem value="custom">Custom</SelectItem>
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="outline"
                className="shrink-0 gap-2"
                onClick={() => {
                  refreshModules()
                    .then(() => {
                      addNotification({
                        type: "success",
                        title: "Modules refreshed",
                        message: "Modules refreshed.",
                      });
                    })
                    .catch((error) => {
                      addNotification({
                        type: "error",
                        title: "Refresh modules failed",
                        message: errorMessageFrom(
                          error,
                          "Failed to refresh modules.",
                        ),
                      });
                    });
                }}
                aria-label="Refresh modules"
              >
                <RotateCcw />
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex min-w-[200px] flex-1 items-center gap-2">
              <Input
                placeholder="Search modules"
                value={exploreQuery}
                onChange={(event) =>
                  updateSearchParams({ eq: event.target.value || undefined })
                }
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                onValueChange={(value) =>
                  updateSearchParams({ registry: value })
                }
                value={effectiveRegistryId ?? ""}
              >
                <SelectTrigger
                  className="min-w-[140px] flex-1 sm:w-[220px] sm:flex-none"
                  aria-label="Change registry"
                >
                  <SelectValue placeholder="Select registry" />
                </SelectTrigger>
                <SelectContent>
                  {registries.map((registry) => (
                    <SelectItem key={registry.id} value={registry.id}>
                      {registry.id}
                      {registry.isDefault ? " (default)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                onValueChange={(value) =>
                  updateSearchParams({
                    etype: value === "all" ? undefined : value,
                  })
                }
                value={exploreType}
              >
                <SelectTrigger className="min-w-[140px] flex-1 sm:w-[170px] sm:flex-none">
                  <SelectValue placeholder="Type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All types</SelectItem>
                  <SelectItem value="adapter">Adapter</SelectItem>
                  <SelectItem value="environment">Environment</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        )}
      </div>
      {viewTab === "installed" ? (
        <div className="h-full flex flex-col gap-6">
          <div className="grid gap-4 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
            {modules.map((installedModule) => (
              <InstalledModuleCard
                key={installedModule.id}
                installedModule={installedModule}
                onToggle={() => void handleToggleModule(installedModule)}
                isToggling={togglingIds[installedModule.id] ?? false}
              />
            ))}
          </div>
          {modulesError ? (
            <p className="p-4 text-sm text-destructive">
              Failed to load modules.
            </p>
          ) : null}
          {!isLoadingModules && modules.length === 0 ? (
            <div className="flex items-center justify-center h-full py-12">
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Blocks aria-hidden />
                  </EmptyMedia>
                  <EmptyTitle>No modules installed</EmptyTitle>
                  <EmptyDescription>
                    <Button
                      variant="link"
                      size="sm"
                      className="p-0"
                      onClick={() => updateSearchParams({ tab: "explore" })}
                    >
                      Browse the explore tab
                    </Button>{" "}
                    to install your first module.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            </div>
          ) : null}
          {nextCursor !== null ? (
            <div className="flex justify-center p-4">
              <Button
                type="button"
                variant="outline"
                className="gap-2"
                disabled={isLoadingMore}
                onClick={() => void loadMoreModules()}
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
        <div className="h-full flex flex-col gap-6">
          {isLoadingRegistries && registries.length === 0 ? (
            <p className="text-sm text-muted-foreground">Loading registries…</p>
          ) : registries.length === 0 ? (
            <div className="flex items-center justify-center h-full py-12">
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Library aria-hidden />
                  </EmptyMedia>
                  <EmptyTitle>No registries yet</EmptyTitle>
                  <EmptyDescription>
                    Add one to browse and install modules.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            </div>
          ) : selectedRegistry ? (
            <div className="flex flex-col gap-3">
              <ExploreModuleGroup
                registryId={selectedRegistry.id}
                query={debouncedExploreQuery}
                type={exploreType}
                onInstalled={refreshModules}
                onCountChange={handleExploreCount}
                installedModules={modules}
                onRegistryAdded={() => void mutate(registriesUrl)}
              />
            </div>
          ) : (
            <div className="flex items-center justify-center h-full py-12">
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Library aria-hidden />
                  </EmptyMedia>
                  <EmptyTitle>No registry selected</EmptyTitle>
                  <EmptyDescription>
                    Select a registry to browse and install its entries, or{" "}
                    <AddRegistryPopover
                      onAdded={() => void mutate(registriesUrl)}
                      align="center"
                    >
                      <Button
                        variant="ghost"
                        size="sm"
                        className="underline"
                        type="button"
                      >
                        add a registry
                      </Button>
                    </AddRegistryPopover>
                    .
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
