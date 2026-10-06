import {
  ArrowLeft,
  ChevronDown,
  Circle,
  KeyRound,
  Loader2,
  Package,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Wrench,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import remarkGfm from "remark-gfm";
import useSWR, { useSWRConfig } from "swr";
import { z } from "zod";
import AuthSection from "@/components/AuthSection";
import { EntityIcon } from "@/components/entity-icon";
import { JsonSchemaFormSheet } from "@/components/JsonSchemaForm";
import { ServiceToolWorkbench } from "@/components/service-tool-workbench";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { VersionUpdatesDialog } from "@/components/version-updates-dialog";
import { useNotification } from "@/hooks/use-notification";
import { useUpdateSearchParams } from "@/hooks/use-update-search-params";
import { apiFetch, apiFetchJson, buildUrl, errorMessageFrom } from "@/lib/api";
import { formatVersion } from "@/lib/format";

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
  autoUpdate: z.boolean(),
  autoUpdateConstraint: z.string().nullable(),
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

const updateCheckSchema = z.object({
  id: z.string(),
  installed: z.string(),
  available: z.string().nullable(),
  constraint: z.string().nullable(),
  autoUpdate: z.boolean(),
  updateAvailable: z.boolean(),
  upToDate: z.boolean(),
  hasSource: z.boolean(),
});

const versionsSchema = z.object({
  id: z.string(),
  installed: z.string(),
  latest: z.string().nullable(),
  versions: z.array(z.string()),
});

type UpdateCheck = z.infer<typeof updateCheckSchema>;

type Service = z.infer<typeof serviceSchema>;

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
  const [isVersionDialogOpen, setIsVersionDialogOpen] = useState(false);
  const [updateCheck, setUpdateCheck] = useState<UpdateCheck | null>(null);
  const [isManualUpdateOpen, setIsManualUpdateOpen] = useState(false);
  const [constraintDraft, setConstraintDraft] = useState<string | undefined>(
    undefined,
  );
  const [isSavingAutoUpdate, setIsSavingAutoUpdate] = useState(false);
  const [manualUpdateUrl, setManualUpdateUrl] = useState("");
  const [isManualUpdating, setIsManualUpdating] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [searchParams] = useSearchParams();
  const updateSearchParams = useUpdateSearchParams();

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

  // Update checks run server-side against the stored registry source; the
  // browser never fetches registry descriptors directly.
  const versionsUrl =
    serviceId && serviceDetails?.source
      ? buildUrl(`/services/${serviceId}/versions`)
      : null;

  const { data: versionsData } = useSWR(
    versionsUrl,
    (url) => apiFetchJson(url, versionsSchema),
    { refreshInterval: 120_000 },
  );

  useEffect(() => {
    setUpdateCheck(null);
    setConstraintDraft(undefined);
    setIsVersionDialogOpen(false);
    setIsManualUpdateOpen(false);
    // Reference serviceId so update state resets when navigating services.
    void serviceId;
  }, [serviceId]);

  useEffect(() => {
    if (serviceDetails && constraintDraft === undefined) {
      setConstraintDraft(serviceDetails.autoUpdateConstraint ?? "");
    }
  }, [serviceDetails, constraintDraft]);

  const hasUpdate = updateCheck?.updateAvailable ?? false;

  const {
    data: toolList,
    error: toolsError,
    isLoading: isLoadingTools,
  } = useSWR(toolsUrl, (url) => apiFetchJson(url, toolListSchema), {
    refreshInterval: 12000,
  });

  const tools = useMemo(() => toolList?.items ?? [], [toolList]);

  const refreshTools = async () => {
    if (toolsUrl) await mutate(toolsUrl);
  };

  const refreshServiceLists = async () => {
    await mutate(
      (key) =>
        typeof key === "string" && key.startsWith(`${buildUrl("/services")}?`),
    );
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

  const rawTab = searchParams.get("tab");
  const activeSheet = rawTab && availableTabs.includes(rawTab) ? rawTab : null;
  const isSheetOpen = activeSheet !== null;

  const openSheet = (value: string) => {
    updateSearchParams({ tab: value });
  };

  const closeSheet = () => {
    updateSearchParams({ tab: undefined });
  };

  const sheetTitles: Record<string, { title: string; description: string }> = {
    tools: {
      title: "Tools",
      description: "Browse tools and inspect a tool in place.",
    },
    configuration: {
      title: "Configuration",
      description: "Non-secret settings for this service.",
    },
    secrets: {
      title: "Secrets",
      description: "Secret values for this service.",
    },
    authentication: {
      title: "Authentication",
      description: "Credentials for this service's auth schemes.",
    },
  };

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
      const check = await apiFetchJson(
        buildUrl(`/services/${serviceDetails.id}/update-check`),
        updateCheckSchema,
      );
      setUpdateCheck(check);

      if (!check.hasSource) {
        addNotification({
          type: "warning",
          title: "Update unavailable",
          message:
            "This service has no registry source. Use manual update with a direct URL.",
        });
        return;
      }

      if (check.upToDate) {
        addNotification({
          type: "success",
          title: "Up to date",
          message: `Installed ${formatVersion(check.installed)}${check.constraint ? ` matches update policy ${check.constraint}` : " is the latest"}.`,
        });
        return;
      }

      setIsUpdateDialogOpen(true);
    } catch (error) {
      addNotification({
        type: "error",
        title: "Update check failed",
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
      const result = await apiFetchJson(
        buildUrl(`/services/${id}/update`),
        z.object({
          updated: z.boolean(),
          fromVersion: z.string(),
          toVersion: z.string(),
        }),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            constraint: updateCheck?.constraint ?? null,
          }),
        },
      );

      await refreshServiceLists();
      if (serviceDetailsUrl) {
        await mutate(serviceDetailsUrl);
      }
      await refreshTools();
      setUpdateCheck(null);
      addNotification({
        type: "success",
        title: result.updated ? "Service updated" : "Already current",
        message: result.updated
          ? `Updated from ${formatVersion(result.fromVersion)} → ${formatVersion(result.toVersion)}.`
          : `Already at ${formatVersion(result.toVersion)}.`,
      });
    } catch (error) {
      addNotification({
        type: "error",
        title: "Service update failed",
        message: errorMessageFrom(error, "Unable to update service."),
      });
    } finally {
      setIsUpdating(false);
    }
  };

  const handleToggleAutoUpdate = async (next: boolean) => {
    if (!serviceDetails) return;
    setIsSavingAutoUpdate(true);
    try {
      await apiFetch(buildUrl(`/services/${serviceDetails.id}/auto-update`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          autoUpdate: next,
          constraint:
            (constraintDraft ?? "").trim().length > 0
              ? (constraintDraft?.trim() ?? null)
              : null,
        }),
      });
      if (serviceDetailsUrl) await mutate(serviceDetailsUrl);
      addNotification({
        type: "success",
        title: next ? "Automatic updates on" : "Automatic updates off",
        message: next
          ? "This service will follow its update policy on the background sweep."
          : "Automatic updates are off for this service.",
      });
    } catch (error) {
      addNotification({
        type: "error",
        title: "Automatic update change failed",
        message: errorMessageFrom(error, "Unable to change auto-update."),
      });
    } finally {
      setIsSavingAutoUpdate(false);
    }
  };

  const handleSaveConstraint = async () => {
    if (!serviceDetails) return;
    const trimmed = (constraintDraft ?? "").trim();
    setIsSavingAutoUpdate(true);
    try {
      await apiFetch(buildUrl(`/services/${serviceDetails.id}/auto-update`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          autoUpdate: serviceDetails.autoUpdate,
          constraint: trimmed.length > 0 ? trimmed : null,
        }),
      });
      if (serviceDetailsUrl) await mutate(serviceDetailsUrl);
      addNotification({
        type: "success",
        title: "Update policy saved",
        message:
          trimmed.length > 0
            ? `Update policy set to ${trimmed}.`
            : "Update policy set to latest.",
      });
    } catch (error) {
      addNotification({
        type: "error",
        title: "Update policy save failed",
        message: errorMessageFrom(error, "Unable to save update policy."),
      });
    } finally {
      setIsSavingAutoUpdate(false);
    }
  };

  const handleManualUpdate = async (id: string) => {
    const trimmed = manualUpdateUrl.trim();
    if (!trimmed) {
      addNotification({
        type: "error",
        title: "URL required",
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
        title: "Service updated",
        message: "Service updated.",
      });
    } catch (error) {
      addNotification({
        type: "error",
        title: "Service update failed",
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
        title: "Service synced",
        message: "Service synced.",
      });
    } catch (error) {
      addNotification({
        type: "error",
        title: "Service sync failed",
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
        title: `Service ${enabled ? "enabled" : "disabled"}`,
        message: `Service ${enabled ? "enabled" : "disabled"}.`,
      });
    } catch (error) {
      addNotification({
        type: "error",
        title: "Service state update failed",
        message: errorMessageFrom(error, "Unable to update service state."),
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
        title: "Service uninstalled",
        message: "Service uninstalled.",
      });
      navigate("/services");
    } catch (error) {
      addNotification({
        type: "error",
        title: "Service deletion failed",
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
      <section className="flex h-svh flex-col px-6 pb-6">
        <header className="sticky top-0 z-10 shrink-0 -mx-6 space-y-4 border-b bg-background p-6">
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
              <div className="flex items-start gap-3">
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
                    <Link to={`/settings/modules/${serviceDetails.adapter}`}>
                      <Badge variant="secondary">
                        {serviceDetails.adapter}
                      </Badge>
                    </Link>
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
                          onClick={() => setIsVersionDialogOpen(true)}
                        >
                          Version & updates…
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
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setIsManualUpdateOpen(true)}
                  >
                    Manual update
                  </Button>
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
                {hasTools ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="gap-2"
                    onClick={() => openSheet("tools")}
                  >
                    <Wrench />
                    Tools (
                    {isLoadingTools
                      ? "…"
                      : `${tools.length}${toolList?.hasMore ? "+" : ""}`}
                    )
                  </Button>
                ) : null}
                {hasConfig ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="gap-2"
                    onClick={() => openSheet("configuration")}
                  >
                    <SlidersHorizontal />
                    Configuration
                  </Button>
                ) : null}
                {hasSecrets ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="gap-2"
                    onClick={() => openSheet("secrets")}
                  >
                    <KeyRound />
                    Secrets
                  </Button>
                ) : null}
                {hasAuth && serviceDetails.schemes ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="gap-2"
                    onClick={() => openSheet("authentication")}
                  >
                    <ShieldCheck />
                    Authentication
                  </Button>
                ) : null}
              </div>
            </>
          ) : null}
        </header>

        {serviceDetails ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            <div className="space-y-2 pt-6">
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

            {availableTabs.length === 0 ? (
              <div className="flex items-center justify-center h-full py-12">
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <Package aria-hidden />
                    </EmptyMedia>
                    <EmptyTitle>Nothing to configure</EmptyTitle>
                    <EmptyDescription>
                      No tools, configuration, or secrets available for this
                      service.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      {serviceDetails && isSheetOpen ? (
        <Sheet
          open={isSheetOpen}
          onOpenChange={(open) => {
            if (!open) closeSheet();
          }}
        >
          <SheetContent
            side="right"
            className="data-[side=right]:w-full data-[side=right]:sm:max-w-lg"
          >
            <SheetHeader className="text-left">
              <SheetTitle>
                {activeSheet ? sheetTitles[activeSheet]?.title : ""}
              </SheetTitle>
              <SheetDescription>
                {activeSheet ? sheetTitles[activeSheet]?.description : ""}
              </SheetDescription>
            </SheetHeader>
            {activeSheet === "tools" || activeSheet === "authentication" ? (
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 pb-4">
                {activeSheet === "tools" && hasTools ? (
                  <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                    <ServiceToolWorkbench serviceId={serviceDetails.id} />
                  </div>
                ) : null}
                {activeSheet === "authentication" &&
                hasAuth &&
                serviceDetails.schemes ? (
                  <div className="min-h-0 flex-1 overflow-y-auto pr-1">
                    <AuthSection
                      target={{ kind: "service", id: serviceDetails.id }}
                      authSchemes={serviceDetails.schemes}
                    />
                  </div>
                ) : null}
              </div>
            ) : null}
            {activeSheet === "configuration" && hasConfig ? (
              <JsonSchemaFormSheet
                schema={
                  serviceConfigSchemaPayload?.configSchema ??
                  serviceDetails.configSchema ??
                  {}
                }
                currentValues={
                  (serviceConfig?.config ?? {}) as Record<string, unknown>
                }
                patchUrl={buildUrl(`/services/${serviceDetails.id}/config`)}
                outdatedPaths={serviceConfig?.outdated}
                onSaved={handleRefetchAll}
              />
            ) : null}
            {activeSheet === "secrets" && hasSecrets ? (
              <JsonSchemaFormSheet
                schema={
                  serviceSecretsSchemaPayload?.secretsSchema ??
                  serviceDetails.secretsSchema ??
                  {}
                }
                currentValues={currentSecretsValues}
                presentSet={presentSet}
                patchUrl={buildUrl(`/services/${serviceDetails.id}/secrets`)}
                outdatedPaths={serviceSecretsPresence?.outdated}
                onSaved={handleRefetchAll}
              />
            ) : null}
          </SheetContent>
        </Sheet>
      ) : null}

      {serviceDetails ? (
        <VersionUpdatesDialog
          open={isVersionDialogOpen}
          onOpenChange={setIsVersionDialogOpen}
          kind="service"
          installedVersion={serviceDetails.version}
          autoUpdate={serviceDetails.autoUpdate}
          autoUpdateConstraint={serviceDetails.autoUpdateConstraint}
          hasSource={Boolean(serviceDetails.source)}
          latest={versionsData?.latest ?? null}
          available={updateCheck?.available ?? null}
          upToDate={updateCheck ? updateCheck.upToDate : null}
          constraintDraft={constraintDraft ?? ""}
          onConstraintDraftChange={setConstraintDraft}
          isSaving={isSavingAutoUpdate}
          isChecking={isCheckingUpdate}
          onToggleAutoUpdate={(next) => void handleToggleAutoUpdate(next)}
          onSaveConstraint={() => void handleSaveConstraint()}
          onCheckForUpdate={() => void handleCheckForUpdate()}
        />
      ) : null}
      <Dialog open={isManualUpdateOpen} onOpenChange={setIsManualUpdateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Manual update</DialogTitle>
            <DialogDescription>
              Provide a new definition URL for this service.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 pt-2">
            <Label htmlFor="service-update-url">Definition URL</Label>
            <Input
              id="service-update-url"
              onChange={(event) => setManualUpdateUrl(event.target.value)}
              placeholder="https://example.com/manifest.json"
              value={manualUpdateUrl}
            />
          </div>
          <DialogFooter className="pt-2">
            <Button
              type="button"
              disabled={isManualUpdating || !manualUpdateUrl.trim()}
              onClick={() =>
                serviceDetails && void handleManualUpdate(serviceDetails.id)
              }
            >
              {isManualUpdating ? "Updating" : "Update"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
              {updateCheck?.available
                ? `Update from ${formatVersion(updateCheck.installed)} → ${formatVersion(updateCheck.available)}${updateCheck.constraint ? ` (policy ${updateCheck.constraint})` : ""}?`
                : "A new version of this service is available. Update now?"}
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
