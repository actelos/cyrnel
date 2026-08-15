import { ChevronDown, Library, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import useSWR, { mutate } from "swr";
import useSWRInfinite from "swr/infinite";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useNotification } from "@/hooks/use-notification";
import { apiFetch, apiFetchJson, buildUrl, errorMessageFrom } from "@/lib/api";
import { cn } from "@/lib/utils";

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

const registryEntrySchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  source: z.string(),
  kind: z.string().optional(),
  type: z.enum(["adapter", "environment"]).optional(),
  icon: z.string().optional(),
});

const definitionsPageSchema = z.object({
  definitions: z.array(registryEntrySchema),
  nextCursor: z.string().nullable(),
});

const modulesPageSchema = z.object({
  modules: z.array(registryEntrySchema),
  nextCursor: z.string().nullable(),
});

const installAdapterItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  compatible: z.boolean(),
  active: z.boolean(),
});

const installAdaptersResponseSchema = z.object({
  default: z.string().nullable(),
  adapters: z.array(installAdapterItemSchema),
});

type RegistryEntry = z.infer<typeof registryEntrySchema>;
type InstallAdaptersResponse = z.infer<typeof installAdaptersResponseSchema>;

interface RegistryBrowserProps {
  kind: "service" | "module";
  onInstalled: () => void | Promise<void>;
}

type EntryOverride = { id?: string; adapter?: string; version?: string };

const NO_ADAPTER = "__none__";

function toBase64(buf: Uint8Array | null | undefined): string {
  if (!buf) return "";
  let binary = "";
  for (let i = 0; i < buf.length; i++) {
    binary += String.fromCharCode(buf[i]);
  }
  return btoa(binary);
}

function buildAdapterItems(ranked: InstallAdaptersResponse | undefined): Array<{
  value: string;
  label: string;
  compatible: boolean;
  active: boolean;
  isDefault: boolean;
}> {
  if (ranked) {
    return ranked.adapters.map((adapter) => ({
      value: adapter.id,
      label: adapter.name,
      compatible: adapter.compatible,
      active: adapter.active,
      isDefault: ranked.default === adapter.id,
    }));
  }
  return [];
}

function EntryAdapterSelect({
  entry,
  overrides,
  setEntryOverride,
}: {
  entry: RegistryEntry;
  overrides: EntryOverride;
  setEntryOverride: (
    id: string,
    field: keyof EntryOverride,
    value: string,
  ) => void;
}) {
  const adapterUrl = buildUrl("/services/install/adapters", {
    kind: entry.kind ?? undefined,
  });

  const { data: ranked } = useSWR(adapterUrl, (url) =>
    apiFetchJson(url, installAdaptersResponseSchema),
  );

  const selectedValue =
    (overrides.adapter ?? "").length > 0 ? overrides.adapter : NO_ADAPTER;

  return (
    <Select
      value={selectedValue}
      onValueChange={(value) =>
        setEntryOverride(entry.id, "adapter", value === NO_ADAPTER ? "" : value)
      }
    >
      <SelectTrigger className="h-8 min-w-0 flex-1 text-xs">
        <SelectValue placeholder="Adapter" />
      </SelectTrigger>
      <SelectContent className="max-h-80">
        {entry.kind ? (
          <>
            <SelectGroup>
              <SelectLabel>Compatible adapters</SelectLabel>
              {buildAdapterItems(ranked).map((item) =>
                item.compatible && item.active ? (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                    {item.isDefault ? " (recommended)" : ""}
                  </SelectItem>
                ) : null,
              )}
            </SelectGroup>
            <SelectGroup>
              <SelectLabel>Other adapters</SelectLabel>
              {buildAdapterItems(ranked).map((item) =>
                !item.compatible || !item.active ? (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}{" "}
                    <span className="text-xs text-muted-foreground">
                      ({item.compatible ? "inactive" : "kind mismatch"})
                    </span>
                  </SelectItem>
                ) : null,
              )}
            </SelectGroup>
          </>
        ) : null}
      </SelectContent>
    </Select>
  );
}

function RegistryEntryItem({
  entry,
  kind,
  selectedRegistryId,
  installOverrides,
  expandedEntryIds,
  installingEntryId,
  setEntryOverride,
  toggleEntryExpanded,
  handleInstallEntry,
}: {
  entry: RegistryEntry;
  kind: "service" | "module";
  selectedRegistryId: string;
  installOverrides: Record<string, EntryOverride>;
  expandedEntryIds: Set<string>;
  installingEntryId: string | null;
  setEntryOverride: (
    entryId: string,
    field: keyof EntryOverride,
    value: string,
  ) => void;
  toggleEntryExpanded: (entryId: string) => void;
  handleInstallEntry: (entry: RegistryEntry) => void | Promise<void>;
}) {
  const overrides = installOverrides[entry.id] ?? {};
  const expanded = expandedEntryIds.has(entry.id);
  const installing = installingEntryId === entry.id;

  const { data: iconData } = useSWR(
    entry.icon
      ? `${selectedRegistryId}/${kind === "service" ? "definitions" : "modules"}/${entry.id}/icon`
      : null,
    async () => {
      if (!entry.icon) return "";
      const res = await apiFetch(
        buildUrl(
          `/registries/${selectedRegistryId}/${kind === "service" ? "definitions" : "modules"}/${entry.id}/icon`,
        ),
      );
      const bytes = await res.arrayBuffer();
      return toBase64(new Uint8Array(bytes));
    },
    {
      refreshInterval: 30000,
    },
  );

  return (
    <Card className="h-fit">
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            {entry.icon && iconData ? (
              <img
                src={`data:image/png;base64,${iconData}`}
                alt=""
                loading="lazy"
                className="h-6 w-6 shrink-0 rounded-md bg-secondary object-contain p-0.5"
              />
            ) : (
              <span
                aria-hidden
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-secondary text-xs font-semibold text-secondary-foreground"
              >
                {(entry.name ?? entry.id).trim().charAt(0).toUpperCase()}
              </span>
            )}
            <p className="text-sm font-semibold">{entry.name ?? entry.id}</p>
            {kind === "service" && entry.kind ? (
              <Badge variant="secondary">{entry.kind}</Badge>
            ) : null}
            {kind === "module" && entry.type ? (
              <Badge variant="secondary">{entry.type}</Badge>
            ) : null}
          </div>
          {entry.description ? (
            <p className="text-muted-foreground text-xs line-clamp-2">
              {entry.description}
            </p>
          ) : null}
          <p
            className="text-muted-foreground text-xs font-mono truncate"
            title={entry.source}
          >
            {entry.source}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {kind === "service" ? (
            <EntryAdapterSelect
              entry={entry}
              overrides={overrides}
              setEntryOverride={setEntryOverride}
            />
          ) : null}
          <Button
            type="button"
            size="sm"
            className="shrink-0"
            disabled={installingEntryId === entry.id}
            onClick={() => void handleInstallEntry(entry)}
          >
            {installing ? "Installing" : "Install"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="shrink-0"
            aria-label="Options"
            aria-expanded={expanded}
            onClick={() => toggleEntryExpanded(entry.id)}
          >
            <ChevronDown
              className={cn("transition-transform", expanded && "rotate-180")}
            />
          </Button>
        </div>
        {expanded ? (
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label
                className="text-xs text-muted-foreground"
                htmlFor={`${entry.id}-override-id`}
              >
                Id override
              </Label>
              <Input
                id={`${entry.id}-override-id`}
                className="h-8 text-xs"
                placeholder={entry.id}
                value={overrides.id ?? ""}
                onChange={(event) =>
                  setEntryOverride(entry.id, "id", event.target.value)
                }
              />
            </div>
            <div className="space-y-1">
              <Label
                className="text-xs text-muted-foreground"
                htmlFor={`${entry.id}-override-version`}
              >
                Version
              </Label>
              <Input
                id={`${entry.id}-override-version`}
                className="h-8 text-xs"
                placeholder="latest"
                value={overrides.version ?? ""}
                onChange={(event) =>
                  setEntryOverride(entry.id, "version", event.target.value)
                }
              />
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function RegistryBrowser({ kind, onInstalled }: RegistryBrowserProps) {
  const { addNotification } = useNotification();

  const [selectedRegistryId, setSelectedRegistryId] = useState<string | null>(
    null,
  );

  const [browseQuery, setBrowseQuery] = useState("");
  const [browseType, setBrowseType] = useState<
    "all" | "adapter" | "environment"
  >("all");

  const [installingEntryId, setInstallingEntryId] = useState<string | null>(
    null,
  );
  const [installOverrides, setInstallOverrides] = useState<
    Record<string, EntryOverride>
  >({});
  const [expandedEntryIds, setExpandedEntryIds] = useState<Set<string>>(
    new Set(),
  );

  const registriesUrl = buildUrl("/registries");

  const { data: registryList, isLoading: isLoadingRegistries } = useSWR(
    registriesUrl,
    (url) => apiFetchJson(url, registryListSchema),
    { refreshInterval: 30000 },
  );

  const registries = registryList?.items ?? [];

  const [isSyncing, setIsSyncing] = useState(false);
  const selectedRegistry = registries.find((r) => r.id === selectedRegistryId);

  const handleSyncRegistry = async () => {
    if (!selectedRegistryId) return;
    setIsSyncing(true);
    try {
      await apiFetch(buildUrl(`/registries/${selectedRegistryId}/refresh`), {
        method: "POST",
      });
      addNotification({
        type: "success",
        title: "Success",
        message: `Registry '${selectedRegistryId}' synced successfully.`,
      });
      await mutate(registriesUrl);
    } catch (error) {
      addNotification({
        type: "error",
        title: "Error",
        message: errorMessageFrom(error, "Failed to sync registry."),
      });
    } finally {
      setIsSyncing(false);
    }
  };

  const debouncedBrowseQuery = useDebouncedValue(browseQuery, 300);
  const normalizedQuery = debouncedBrowseQuery.trim();

  const getBrowseKey = (
    pageIndex: number,
    previousPageData:
      | z.infer<typeof definitionsPageSchema>
      | z.infer<typeof modulesPageSchema>
      | null,
  ) => {
    if (selectedRegistryId === null) return null;
    if (previousPageData && previousPageData.nextCursor === null) return null;

    const cursor =
      pageIndex === 0 ? undefined : (previousPageData?.nextCursor ?? undefined);

    return buildUrl(
      `/registries/${selectedRegistryId}/${kind === "service" ? "definitions" : "modules"}`,
      {
        query: normalizedQuery.length > 0 ? normalizedQuery : undefined,
        type:
          kind === "module" && browseType !== "all" ? browseType : undefined,
        cursor,
        limit: "20",
      },
    );
  };

  const pageSchema =
    kind === "service" ? definitionsPageSchema : modulesPageSchema;

  const {
    data: pages,
    error: browseError,
    size,
    setSize,
    isLoading: isLoadingBrowse,
  } = useSWRInfinite(getBrowseKey, (url) => apiFetchJson(url, pageSchema), {
    refreshInterval: 30000,
  });

  const entries = useMemo(
    () =>
      (pages ?? []).flatMap((page) =>
        kind === "service" ? page.definitions : page.modules,
      ),
    [pages, kind],
  );

  const hasMore = pages ? pages[pages.length - 1]?.nextCursor !== null : false;

  const setEntryOverride = (
    entryId: string,
    field: keyof EntryOverride,
    value: string,
  ) => {
    setInstallOverrides((previous) => ({
      ...previous,
      [entryId]: { ...previous[entryId], [field]: value },
    }));
  };

  const toggleEntryExpanded = (entryId: string) => {
    setExpandedEntryIds((previous) => {
      const next = new Set(previous);
      if (next.has(entryId)) next.delete(entryId);
      else next.add(entryId);
      return next;
    });
  };

  const handleInstallEntry = async (entry: RegistryEntry) => {
    const overrides = installOverrides[entry.id] ?? {};
    const adapterOverride = overrides.adapter;
    const adapter = adapterOverride !== undefined ? adapterOverride : "";
    const body: Record<string, string> = { source: entry.source };
    if (overrides.id?.trim()) body.id = overrides.id.trim();
    if (overrides.version?.trim()) body.version = overrides.version.trim();
    if (kind === "service" && adapter.trim()) body.adapter = adapter.trim();

    setInstallingEntryId(entry.id);
    try {
      await apiFetch(
        buildUrl(kind === "service" ? "/services/install" : "/modules/install"),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      addNotification({
        type: "success",
        title: "Success",
        message: `${entry.name ?? entry.id} installed.`,
      });
      await onInstalled();
    } catch (error) {
      addNotification({
        type: "error",
        title: "Error",
        message: errorMessageFrom(
          error,
          `Unable to install ${entry.name ?? entry.id}.`,
        ),
      });
    } finally {
      setInstallingEntryId(null);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-center gap-2">
        <Select
          value={selectedRegistryId ?? ""}
          onValueChange={setSelectedRegistryId}
        >
          <SelectTrigger className="min-w-0 flex-1">
            <SelectValue placeholder="Select a registry" />
          </SelectTrigger>
          <SelectContent>
            {registries.map((registry) => (
              <SelectItem key={registry.id} value={registry.id}>
                {registry.id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0 gap-1.5"
          disabled={isSyncing || selectedRegistryId === null}
          onClick={() => void handleSyncRegistry()}
        >
          <RefreshCw className={cn(isSyncing && "animate-spin")} />
          Sync
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0 gap-1.5"
          asChild
        >
          <Link to="/registries">
            <Library />
            Manage registries
          </Link>
        </Button>
      </div>
      {selectedRegistry && (
        <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
          <span className="truncate">URL: {selectedRegistry.baseUrl}</span>
          <span className="shrink-0">
            Last synced:{" "}
            {selectedRegistry.lastSyncedAt
              ? new Date(selectedRegistry.lastSyncedAt).toLocaleString()
              : "Never"}
          </span>
        </div>
      )}

      {selectedRegistryId !== null ? (
        <>
          <div className="flex items-center gap-2">
            <Input
              placeholder={
                kind === "service" ? "Search services…" : "Search modules…"
              }
              value={browseQuery}
              onChange={(event) => setBrowseQuery(event.target.value)}
            />
            {kind === "module" ? (
              <Select
                value={browseType}
                onValueChange={(value) =>
                  setBrowseType(value as "all" | "adapter" | "environment")
                }
              >
                <SelectTrigger className="w-32 shrink-0">
                  <SelectValue placeholder="Type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All types</SelectItem>
                  <SelectItem value="adapter">Adapter</SelectItem>
                  <SelectItem value="environment">Environment</SelectItem>
                </SelectContent>
              </Select>
            ) : null}
          </div>

          <ScrollArea className="min-h-0 flex-1">
            <div className="grid grid-cols-1 gap-3 pr-3 md:grid-cols-2">
              {entries.map((entry) => (
                <RegistryEntryItem
                  key={entry.id}
                  entry={entry}
                  kind={kind}
                  selectedRegistryId={selectedRegistryId}
                  installOverrides={installOverrides}
                  expandedEntryIds={expandedEntryIds}
                  installingEntryId={installingEntryId}
                  setEntryOverride={setEntryOverride}
                  toggleEntryExpanded={toggleEntryExpanded}
                  handleInstallEntry={handleInstallEntry}
                />
              ))}

              {browseError ? (
                <p className="col-span-full p-2 text-sm text-destructive">
                  Failed to load registry entries.
                </p>
              ) : null}
              {!isLoadingBrowse && !browseError && entries.length === 0 ? (
                <p className="col-span-full p-2 text-sm text-muted-foreground">
                  No entries match the current filters.
                </p>
              ) : null}
            </div>
          </ScrollArea>

          {hasMore ? (
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={() => setSize(size + 1)}
            >
              Load more
            </Button>
          ) : null}
        </>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          {isLoadingRegistries ? (
            <p className="text-sm text-muted-foreground">Loading registries…</p>
          ) : registries.length === 0 ? (
            <>
              <p className="text-sm text-muted-foreground">
                No registries yet. Add one to browse and install{" "}
                {kind === "service" ? "services" : "modules"}.
              </p>
              <Button type="button" variant="outline" size="sm" asChild>
                <Link to="/registries">
                  <Library />
                  Add a registry
                </Link>
              </Button>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Select a registry to browse and install its entries.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
