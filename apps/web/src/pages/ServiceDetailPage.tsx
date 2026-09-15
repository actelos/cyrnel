import {
  ArrowLeft,
  ChevronDown,
  Circle,
  Loader2,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { useNavigate, useParams, useSearchParams } from "react-router";
import remarkGfm from "remark-gfm";
import useSWR, { useSWRConfig } from "swr";
import { z } from "zod";
import AuthSection from "@/components/AuthSection";
import { EntityIcon } from "@/components/entity-icon";
import JsonSchemaForm from "@/components/JsonSchemaForm";
import { ToolCard } from "@/components/tool-card";
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
import { ButtonGroup } from "@/components/ui/button-group";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useNotification } from "@/hooks/use-notification";
import { useUpdateSearchParams } from "@/hooks/use-update-search-params";
import { apiFetch, apiFetchJson, buildUrl, errorMessageFrom } from "@/lib/api";

const serviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  summary: z.string(),
  description: z.string(),
  adapter: z.string(),
  version: z.string(),
  enabled: z.boolean(),
  stale: z.boolean(),
  hasIcon: z.boolean(),
});

const serviceDetailsSchema = serviceSchema.extend({
  hash: z.string(),
  version: z.string(),
  source: z.string(),
  configSchema: z.record(z.string(), z.unknown()),
  secretsSchema: z.record(z.string(), z.unknown()),
  schemes: z
    .record(z.string(), z.object({ type: z.string() }).passthrough())
    .optional(),
  credentialSchemes: z
    .record(
      z.string(),
      z.object({
        configured: z.boolean(),
        status: z.string().optional(),
        grantedSource: z.string().nullable().optional(),
      }),
    )
    .optional(),
});

const serviceConfigSchema = z.object({
  config: z.record(z.string(), z.unknown()),
  outdated: z.array(z.string()).default([]),
});

const serviceConfigSchemaSchema = z.object({
  configSchema: z.record(z.string(), z.unknown()),
});

const serviceSecretsSchemaSchema = z.object({
  secretsSchema: z.record(z.string(), z.unknown()),
});

const secretsPresenceSchema = z.object({
  present: z.array(z.string()),
  outdated: z.array(z.string()).default([]),
});

const toolSchema = z.object({
  id: z.string(),
  name: z.string(),
  summary: z.string(),
  description: z.string(),
  serviceId: z.string(),
  policy: z
    .object({
      decision: z.enum(["allow", "block", "ask"]),
      updatedAt: z.number().nullable(),
    })
    .optional(),
  score: z.number().optional(),
  matchType: z.enum(["fts", "vector", "both"]).optional(),
  ftsRank: z.number().optional(),
  vectorRank: z.number().optional(),
});

const toolListSchema = z.object({
  items: z.array(toolSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});

type Service = z.infer<typeof serviceSchema>;
type Tool = z.infer<typeof toolSchema>;

function buildFormSkeleton(
  schema: Record<string, unknown>,
  presentSet: Set<string>,
  basePath = "",
): Record<string, unknown> {
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const [name, prop] of Object.entries(properties)) {
    const propSchema = prop as Record<string, unknown>;
    const propType = Array.isArray(propSchema.type)
      ? propSchema.type[0]
      : propSchema.type;
    const path = basePath ? `${basePath}/${name}` : `/${name}`;
    const isPresent = presentSet.has(path);

    if (
      propType === "object" &&
      typeof propSchema.properties === "object" &&
      propSchema.properties !== null
    ) {
      const nested = buildFormSkeleton(
        propSchema as Record<string, unknown>,
        presentSet,
        path,
      );
      if (isPresent || Object.keys(nested).length > 0) {
        result[name] = nested;
      }
    } else if (propType === "array") {
      result[name] = [];
    } else {
      if (isPresent) result[name] = "";
    }
  }

  return result;
}

function hasSchemaProperties(schema: unknown): boolean {
  if (!schema || typeof schema !== "object") return false;
  const properties = (schema as Record<string, unknown>).properties;
  return Boolean(
    properties &&
      typeof properties === "object" &&
      Object.keys(properties).length > 0,
  );
}

export default function ServiceDetailPage() {
  const { serviceId } = useParams<{ serviceId: string }>();
  const navigate = useNavigate();
  const { mutate } = useSWRConfig();

  const { addNotification } = useNotification();
  const [deleteCandidate, setDeleteCandidate] = useState<Service | null>(null);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
  const [isUpdateDialogOpen, setIsUpdateDialogOpen] = useState(false);
  const [hasUpdate, setHasUpdate] = useState(false);
  const [isManualUpdateOpen, setIsManualUpdateOpen] = useState(false);
  const [manualUpdateUrl, setManualUpdateUrl] = useState("");
  const [isManualUpdating, setIsManualUpdating] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [searchParams] = useSearchParams();
  const updateSearchParams = useUpdateSearchParams();

  const toolQuery = searchParams.get("q") ?? "";
  const rawToolPolicy = searchParams.get("policy");
  const toolPolicyFilter =
    rawToolPolicy === "allow" ||
    rawToolPolicy === "block" ||
    rawToolPolicy === "ask"
      ? rawToolPolicy
      : "all";

  const handleBack = () => {
    const idx = (window.history.state as { idx?: number } | null)?.idx;
    if (typeof idx === "number" ? idx > 0 : window.history.length > 1) {
      void navigate(-1);
    } else {
      void navigate("/services");
    }
  };

  const serviceDetailsUrl = serviceId
    ? buildUrl(`/services/${serviceId}`)
    : null;

  const toolsUrl = serviceId
    ? buildUrl("/tools", { serviceId, limit: "100" })
    : null;

  const configUrl = serviceId
    ? buildUrl(`/services/${serviceId}/config`)
    : null;

  const configSchemaUrl = serviceId
    ? buildUrl(`/services/${serviceId}/config/schema`)
    : null;

  const secretsUrl = serviceId
    ? buildUrl(`/services/${serviceId}/secrets`)
    : null;

  const secretsSchemaUrl = serviceId
    ? buildUrl(`/services/${serviceId}/secrets/schema`)
    : null;

  const { data: serviceDetails, error: detailsError } = useSWR(
    serviceDetailsUrl,
    (url) => apiFetchJson(url, serviceDetailsSchema),
    { refreshInterval: 12000 },
  );

  const { data: updateCheck } = useSWR(
    serviceDetails?.source ? `service-update-${serviceId}` : null,
    async () => {
      if (!serviceDetails?.source) return { hasUpdate: false };
      try {
        const res = await fetch(serviceDetails.source);
        const data = (await res.json()) as { hash?: string };
        if (!data.hash) return { hasUpdate: false };
        return { hasUpdate: data.hash !== serviceDetails.hash };
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

  const {
    data: toolList,
    error: toolsError,
    isLoading: isLoadingTools,
    isValidating: isToolListValidating,
  } = useSWR(toolsUrl, (url) => apiFetchJson(url, toolListSchema), {
    refreshInterval: 12000,
  });

  const [extraTools, setExtraTools] = useState<Tool[]>([]);
  const [nextToolCursor, setNextToolCursor] = useState<string | null>(null);
  const [isLoadingMoreTools, setIsLoadingMoreTools] = useState(false);
  const [loadMoreToolsError, setLoadMoreToolsError] = useState<string | null>(
    null,
  );
  const paginationVersionRef = useRef(0);

  useEffect(() => {
    if (toolsUrl === null) return;
    paginationVersionRef.current += 1;
    setExtraTools([]);
    setNextToolCursor(null);
    setLoadMoreToolsError(null);
  }, [toolsUrl]);

  useEffect(() => {
    if (
      extraTools.length === 0 &&
      toolList !== undefined &&
      !isToolListValidating
    ) {
      setNextToolCursor(toolList.nextCursor);
    }
  }, [toolList, extraTools.length, isToolListValidating]);

  const tools = useMemo(() => {
    const seen = new Set<string>();
    const merged: Tool[] = [];
    for (const tool of [...(toolList?.items ?? []), ...extraTools]) {
      if (seen.has(tool.id)) continue;
      seen.add(tool.id);
      merged.push(tool);
    }
    return merged;
  }, [toolList, extraTools]);

  const filteredTools = useMemo(() => {
    const query = toolQuery.trim().toLowerCase();
    return tools.filter(
      (tool) =>
        (toolPolicyFilter === "all" ||
          (tool.policy?.decision ?? "ask") === toolPolicyFilter) &&
        (!query ||
          [tool.name, tool.id, tool.summary, tool.description].some((field) =>
            field.toLowerCase().includes(query),
          )),
    );
  }, [tools, toolQuery, toolPolicyFilter]);

  const refreshTools = async () => {
    paginationVersionRef.current += 1;
    setExtraTools([]);
    setNextToolCursor(null);
    setLoadMoreToolsError(null);
    if (toolsUrl) await mutate(toolsUrl);
  };

  const refreshServiceLists = async () => {
    await mutate(
      (key) =>
        typeof key === "string" && key.startsWith(`${buildUrl("/services")}?`),
    );
  };

  const loadMoreTools = async () => {
    if (toolsUrl === null || nextToolCursor === null || isLoadingMoreTools) {
      return;
    }
    const startedVersion = paginationVersionRef.current;
    setIsLoadingMoreTools(true);
    setLoadMoreToolsError(null);
    try {
      const data = await apiFetchJson(
        buildUrl("/tools", {
          serviceId,
          limit: "100",
          cursor: nextToolCursor,
        }),
        toolListSchema,
      );
      if (paginationVersionRef.current !== startedVersion) return;
      setExtraTools((previous) => [...previous, ...data.items]);
      setNextToolCursor(data.nextCursor);
    } catch (error) {
      if (paginationVersionRef.current !== startedVersion) return;
      setLoadMoreToolsError(
        errorMessageFrom(error, "Failed to load more tools."),
      );
    } finally {
      setIsLoadingMoreTools(false);
    }
  };

  const { data: serviceConfig } = useSWR(
    configUrl,
    (url) => apiFetchJson(url, serviceConfigSchema),
    { refreshInterval: 12000 },
  );

  const { data: serviceConfigSchemaPayload } = useSWR(
    configSchemaUrl,
    (url) => apiFetchJson(url, serviceConfigSchemaSchema),
    { refreshInterval: 12000 },
  );

  const { data: serviceSecretsPresence } = useSWR(
    secretsUrl,
    (url) => apiFetchJson(url, secretsPresenceSchema),
    { refreshInterval: 12000 },
  );

  const { data: serviceSecretsSchemaPayload } = useSWR(
    secretsSchemaUrl,
    (url) => apiFetchJson(url, serviceSecretsSchemaSchema),
    { refreshInterval: 12000 },
  );

  const presentSet = useMemo(
    () => new Set(serviceSecretsPresence?.present ?? []),
    [serviceSecretsPresence],
  );

  const currentSecretsValues = useMemo(
    () =>
      buildFormSkeleton(
        serviceSecretsSchemaPayload?.secretsSchema ?? {},
        presentSet,
      ),
    [serviceSecretsSchemaPayload, presentSet],
  );

  const hasTools =
    toolList === undefined
      ? isLoadingTools || Boolean(toolsError)
      : tools.length > 0 || Boolean(toolsError);

  const hasConfig = Boolean(
    hasSchemaProperties(
      serviceConfigSchemaPayload?.configSchema ?? serviceDetails?.configSchema,
    ) ||
      (serviceConfig?.config && Object.keys(serviceConfig.config).length > 0) ||
      (serviceConfig?.outdated && serviceConfig.outdated.length > 0),
  );

  const hasSecrets = Boolean(
    hasSchemaProperties(
      serviceSecretsSchemaPayload?.secretsSchema ??
        serviceDetails?.secretsSchema,
    ) ||
      (serviceSecretsPresence?.present &&
        serviceSecretsPresence.present.length > 0) ||
      (serviceSecretsPresence?.outdated &&
        serviceSecretsPresence.outdated.length > 0),
  );

  const hasAuth = Boolean(
    serviceDetails?.schemes && Object.keys(serviceDetails.schemes).length > 0,
  );

  const availableTabs = useMemo(() => {
    const list: string[] = [];
    if (hasTools) list.push("tools");
    if (hasConfig) list.push("configuration");
    if (hasSecrets) list.push("secrets");
    if (hasAuth) list.push("authentication");
    return list;
  }, [hasTools, hasConfig, hasSecrets, hasAuth]);

  const defaultTab = availableTabs[0] ?? "tools";

  const rawTab = searchParams.get("tab");
  const tab = rawTab && availableTabs.includes(rawTab) ? rawTab : defaultTab;

  const handleRefetchAll = async () => {
    if (configUrl) await mutate(configUrl);
    if (secretsUrl) await mutate(secretsUrl);
    if (secretsSchemaUrl) await mutate(secretsSchemaUrl);
    if (configSchemaUrl) await mutate(configSchemaUrl);
    if (serviceDetailsUrl) await mutate(serviceDetailsUrl);
    await refreshServiceLists();
    await refreshTools();
  };

  const handleCheckForUpdate = async () => {
    if (!serviceDetails?.source) {
      setIsManualUpdateOpen(true);
      return;
    }

    setIsCheckingUpdate(true);
    try {
      const res = await fetch(serviceDetails.source);
      const data = (await res.json()) as { hash?: string };

      if (data.hash && data.hash === serviceDetails.hash) {
        addNotification({
          type: "success",
          title: "Up to date",
          message: "Service is up to date.",
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
      await apiFetch(buildUrl(`/services/${id}/update`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      await refreshServiceLists();
      if (serviceDetailsUrl) {
        await mutate(serviceDetailsUrl);
      }
      await refreshTools();
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
      await apiFetch(buildUrl(`/services/${id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: trimmed }),
      });

      setManualUpdateUrl("");
      setIsManualUpdateOpen(false);
      await refreshServiceLists();
      if (serviceDetailsUrl) {
        await mutate(serviceDetailsUrl);
      }
      await refreshTools();
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
      setIsManualUpdating(false);
    }
  };

  const handleSyncService = async (id: string) => {
    setIsSyncing(true);
    try {
      await apiFetch(buildUrl(`/services/${id}/sync`), {
        method: "POST",
      });

      await refreshServiceLists();
      if (serviceDetailsUrl) {
        await mutate(serviceDetailsUrl);
      }
      await refreshTools();
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
    } finally {
      setIsSyncing(false);
    }
  };

  const handleSetServiceEnabled = async (id: string, enabled: boolean) => {
    try {
      await apiFetch(buildUrl(`/services/${id}/enabled`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });

      await refreshServiceLists();
      if (serviceDetailsUrl) {
        await mutate(serviceDetailsUrl);
      }
      await refreshTools();
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

  const handleSetToolPolicy = async (
    serviceId: string,
    toolId: string,
    decision: "allow" | "block" | "ask",
  ) => {
    try {
      await apiFetch(buildUrl(`/tools/${serviceId}/${toolId}/policy`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      if (toolsUrl) await mutate(toolsUrl);
      addNotification({
        type: "success",
        title: "Success",
        message: `Tool policy set to ${decision}.`,
      });
    } catch (error) {
      addNotification({
        type: "error",
        title: "Error",
        message: errorMessageFrom(error, "Unable to update tool policy."),
      });
    }
  };

  const handleDeleteService = async (id: string) => {
    try {
      await apiFetch(buildUrl(`/services/${id}`), {
        method: "DELETE",
      });

      await refreshServiceLists();
      if (serviceDetailsUrl) {
        await mutate(serviceDetailsUrl);
      }
      await refreshTools();

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
      <section className="flex min-h-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 shrink-0 space-y-4 border-b bg-background p-6">
          <div>
            <Button
              type="button"
              variant="ghost"
              onClick={handleBack}
              className="gap-2"
            >
              <ArrowLeft />
              Back to Services
            </Button>
          </div>

          {detailsError ? (
            <p className="text-sm text-destructive">
              Failed to load service details.
            </p>
          ) : null}

          {serviceDetails ? (
            <>
              <div className="flex items-start gap-2">
                <EntityIcon
                  kind="service"
                  id={serviceDetails.id}
                  label={serviceDetails.name}
                  hasIcon={serviceDetails.hasIcon}
                />
                <div>
                  <div className="flex items-center flex-wrap gap-2">
                    <h2 className="text-md font-semibold">
                      {serviceDetails.name}
                    </h2>
                    <Badge variant="secondary">{serviceDetails.adapter}</Badge>
                    {serviceDetails.stale ? (
                      <Badge variant="destructive">Stale</Badge>
                    ) : null}
                  </div>
                  <p className="text-muted-foreground text-xs font-mono">
                    {serviceDetails.id}@{serviceDetails.version}
                  </p>
                </div>
              </div>
              {serviceDetails.summary ? (
                <p className="text-muted-foreground text-sm">
                  {serviceDetails.summary}
                </p>
              ) : null}
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
                {serviceDetails.source ? (
                  <ButtonGroup>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={isUpdating || isCheckingUpdate}
                      onClick={() => void handleCheckForUpdate()}
                      className="rounded-r-none"
                    >
                      {hasUpdate ? (
                        <Circle className="fill-amber-500 text-amber-500" />
                      ) : null}
                      {isCheckingUpdate ? (
                        <RotateCcw className="animate-spin" />
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
                  </ButtonGroup>
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
                          <h3 className="text-sm font-medium">Manual update</h3>
                          <p className="text-muted-foreground text-xs">
                            Provide a new definition URL.
                          </p>
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="service-update-url">
                            Definition URL
                          </Label>
                          <Input
                            id="service-update-url"
                            onChange={(event) =>
                              setManualUpdateUrl(event.target.value)
                            }
                            placeholder="https://example.com/manifest.json"
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
                              void handleManualUpdate(serviceDetails.id)
                            }
                          >
                            {isManualUpdating ? "Updating" : "Update"}
                          </Button>
                        </div>
                      </div>
                    </PopoverContent>
                  </Popover>
                )}
                {serviceDetails.stale ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={isSyncing}
                    onClick={() => void handleSyncService(serviceDetails.id)}
                    className="gap-2"
                  >
                    <RotateCcw
                      className={isSyncing ? "animate-spin" : undefined}
                    />
                    {isSyncing ? "Syncing" : "Sync"}
                  </Button>
                ) : null}
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
            </>
          ) : null}
        </header>

        {serviceDetails ? (
          <div className="flex min-h-0 flex-1 flex-col gap-6 p-6">
            <div className="space-y-2">
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
                <p className="text-muted-foreground text-sm">No description</p>
              )}
            </div>

            {availableTabs.length > 0 ? (
              <Tabs
                value={tab}
                onValueChange={(value) =>
                  updateSearchParams({
                    tab: value === defaultTab ? undefined : value,
                  })
                }
              >
                <TabsList>
                  {hasTools ? (
                    <TabsTrigger value="tools">
                      Tools (
                      {isLoadingTools
                        ? "…"
                        : `${tools.length}${nextToolCursor !== null ? "+" : ""}`}
                      )
                    </TabsTrigger>
                  ) : null}
                  {hasConfig ? (
                    <TabsTrigger value="configuration">
                      Configuration
                    </TabsTrigger>
                  ) : null}
                  {hasSecrets ? (
                    <TabsTrigger value="secrets">Secrets</TabsTrigger>
                  ) : null}
                  {hasAuth && serviceDetails.schemes ? (
                    <TabsTrigger value="authentication">
                      Authentication
                      <Badge variant="secondary" size="sm" className="p-1.5">
                        {Object.keys(serviceDetails.schemes).length}
                      </Badge>
                    </TabsTrigger>
                  ) : null}
                </TabsList>
                {hasTools ? (
                  <TabsContent value="tools" className="space-y-3">
                    {toolsError ? (
                      <p className="text-sm text-destructive">
                        Failed to load tools.
                      </p>
                    ) : null}
                    <div className="flex flex-wrap items-center gap-3">
                      <div className="flex min-w-[200px] flex-1 items-center gap-2">
                        <Input
                          placeholder="Search tools"
                          value={toolQuery}
                          onChange={(event) =>
                            updateSearchParams({
                              q: event.target.value || undefined,
                            })
                          }
                        />
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Select
                          value={toolPolicyFilter}
                          onValueChange={(value) =>
                            updateSearchParams({
                              policy: value === "all" ? undefined : value,
                            })
                          }
                        >
                          <SelectTrigger className="min-w-[140px] flex-1 sm:w-[170px] sm:flex-none">
                            <SelectValue placeholder="Policy" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="all">All policies</SelectItem>
                            <SelectItem value="allow">Allow</SelectItem>
                            <SelectItem value="block">Block</SelectItem>
                            <SelectItem value="ask">Ask</SelectItem>
                          </SelectContent>
                        </Select>
                        {toolQuery.trim() || toolPolicyFilter !== "all" ? (
                          <p className="text-muted-foreground text-xs whitespace-nowrap">
                            {filteredTools.length} of {tools.length}
                          </p>
                        ) : null}
                      </div>
                    </div>
                    {tools.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        No tools registered for this service.
                      </p>
                    ) : filteredTools.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        No tools match the current filters.
                      </p>
                    ) : null}

                    <div className="space-y-3">
                      {filteredTools.map((tool) => (
                        <ToolCard
                          key={tool.id}
                          tool={tool}
                          onPolicyChange={(decision) =>
                            void handleSetToolPolicy(
                              serviceDetails.id,
                              tool.id,
                              decision,
                            )
                          }
                        />
                      ))}
                    </div>
                    {nextToolCursor !== null ? (
                      <div className="flex justify-center p-4">
                        <Button
                          type="button"
                          variant="outline"
                          className="gap-2"
                          disabled={isLoadingMoreTools}
                          onClick={() => void loadMoreTools()}
                        >
                          <ChevronDown />
                          {isLoadingMoreTools ? "Loading more…" : "Load more"}
                        </Button>
                      </div>
                    ) : null}
                    {loadMoreToolsError !== null ? (
                      <p className="p-4 text-sm text-destructive">
                        {loadMoreToolsError}
                      </p>
                    ) : null}
                  </TabsContent>
                ) : null}
                {hasConfig ? (
                  <TabsContent value="configuration">
                    <JsonSchemaForm
                      schema={
                        serviceConfigSchemaPayload?.configSchema ??
                        serviceDetails.configSchema ??
                        {}
                      }
                      currentValues={
                        (serviceConfig?.config ?? {}) as Record<string, unknown>
                      }
                      patchUrl={buildUrl(
                        `/services/${serviceDetails.id}/config`,
                      )}
                      outdatedPaths={serviceConfig?.outdated}
                      onSaved={handleRefetchAll}
                    />
                  </TabsContent>
                ) : null}
                {hasSecrets ? (
                  <TabsContent value="secrets">
                    <JsonSchemaForm
                      schema={
                        serviceSecretsSchemaPayload?.secretsSchema ??
                        serviceDetails.secretsSchema ??
                        {}
                      }
                      currentValues={currentSecretsValues}
                      presentSet={presentSet}
                      patchUrl={buildUrl(
                        `/services/${serviceDetails.id}/secrets`,
                      )}
                      outdatedPaths={serviceSecretsPresence?.outdated}
                      onSaved={handleRefetchAll}
                    />
                  </TabsContent>
                ) : null}
                {hasAuth && serviceDetails.schemes ? (
                  <TabsContent value="authentication">
                    <AuthSection
                      target={{ kind: "service", id: serviceDetails.id }}
                      authSchemes={serviceDetails.schemes}
                    />
                  </TabsContent>
                ) : null}
              </Tabs>
            ) : (
              <p className="text-muted-foreground text-sm">
                No tools, configuration, or secrets available for this service.
              </p>
            )}
          </div>
        ) : null}
      </section>

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
              A new version of this service is available. Update now?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!serviceDetails) return;
                void handleConfirmUpdate(serviceDetails.id);
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
