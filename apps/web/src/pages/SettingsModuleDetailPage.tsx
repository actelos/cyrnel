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
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import { useNavigate, useParams, useSearchParams } from "react-router";
import remarkGfm from "remark-gfm";
import useSWR, { useSWRConfig } from "swr";
import { z } from "zod";
import AuthSection from "@/components/AuthSection";
import { EntityIcon } from "@/components/entity-icon";
import { JsonSchemaFormSheet } from "@/components/JsonSchemaForm";
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

const moduleTypeSchema = z.enum(["adapter", "environment"]);

const moduleDetailSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: moduleTypeSchema,
  summary: z.string(),
  description: z.string(),
  version: z.string(),
  hash: z.string(),
  source: z.string(),
  autoUpdate: z.boolean(),
  autoUpdateConstraint: z.string().nullable(),
  isBuiltin: z.boolean(),
  enabled: z.boolean(),
  missing: z.boolean(),
  hasIcon: z.boolean(),
  configSchema: z.record(z.string(), z.unknown()),
  secretsSchema: z.record(z.string(), z.unknown()),
  schemes: z
    .record(z.string(), z.object({ type: z.string() }).passthrough())
    .optional(),
  security: z.array(z.record(z.string(), z.array(z.string()))).optional(),
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

const moduleConfigSchema = z.object({
  config: z.record(z.string(), z.unknown()).nullable(),
  outdated: z.array(z.string()).default([]),
});

const moduleConfigSchemaSchema = z.object({
  configSchema: z.record(z.string(), z.unknown()),
});

const moduleSecretsSchemaSchema = z.object({
  secretsSchema: z.record(z.string(), z.unknown()),
});

const secretsPresenceSchema = z.object({
  present: z.array(z.string()),
  outdated: z.array(z.string()).default([]),
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

export default function SettingsModuleDetailPage() {
  const { moduleId } = useParams<{ moduleId: string }>();
  const navigate = useNavigate();
  const { mutate } = useSWRConfig();

  const { addNotification } = useNotification();
  const [togglingModuleId, setTogglingModuleId] = useState<string | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
  const [isUpdateDialogOpen, setIsUpdateDialogOpen] = useState(false);
  const [isVersionDialogOpen, setIsVersionDialogOpen] = useState(false);
  const [updateCheck, setUpdateCheck] = useState<UpdateCheck | null>(null);
  const [isManualUpdateOpen, setIsManualUpdateOpen] = useState(false);
  const [constraintDraft, setConstraintDraft] = useState<string | undefined>(
    undefined,
  );
  const [isSavingAutoUpdate, setIsSavingAutoUpdate] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);
  const [isRestartDialogOpen, setIsRestartDialogOpen] = useState(false);
  const [manualUpdateUrl, setManualUpdateUrl] = useState("");
  const [isManualUpdating, setIsManualUpdating] = useState(false);
  const [searchParams] = useSearchParams();
  const updateSearchParams = useUpdateSearchParams();

  const handleBack = () => {
    const idx = (window.history.state as { idx?: number } | null)?.idx;
    if (typeof idx === "number" ? idx > 0 : window.history.length > 1) {
      void navigate(-1);
    } else {
      void navigate("/settings/modules");
    }
  };

  const configUrl = moduleId ? buildUrl(`/modules/${moduleId}/config`) : null;

  const configSchemaUrl = moduleId
    ? buildUrl(`/modules/${moduleId}/config/schema`)
    : null;

  const secretsUrl = moduleId ? buildUrl(`/modules/${moduleId}/secrets`) : null;

  const secretsSchemaUrl = moduleId
    ? buildUrl(`/modules/${moduleId}/secrets/schema`)
    : null;

  const moduleDetailUrl = moduleId ? buildUrl(`/modules/${moduleId}`) : null;

  const { data: moduleDetail, error: detailsError } = useSWR(
    moduleDetailUrl,
    (url) => apiFetchJson(url, moduleDetailSchema),
    { refreshInterval: 12000 },
  );

  // Update checks run server-side against the stored registry source; the
  // browser never fetches registry descriptors directly.
  const versionsUrl =
    moduleId && moduleDetail?.source
      ? buildUrl(`/modules/${moduleId}/versions`)
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
    // Reference moduleId so update state resets when navigating modules.
    void moduleId;
  }, [moduleId]);

  useEffect(() => {
    if (moduleDetail && constraintDraft === undefined) {
      setConstraintDraft(moduleDetail.autoUpdateConstraint ?? "");
    }
  }, [moduleDetail, constraintDraft]);

  const hasUpdate = updateCheck?.updateAvailable ?? false;

  const { data: moduleConfig } = useSWR(
    configUrl,
    (url) => apiFetchJson(url, moduleConfigSchema),
    { refreshInterval: 12000 },
  );

  const { data: moduleConfigSchemaPayload } = useSWR(
    configSchemaUrl,
    (url) => apiFetchJson(url, moduleConfigSchemaSchema),
    { refreshInterval: 12000 },
  );

  const { data: moduleSecretsPresence } = useSWR(
    secretsUrl,
    (url) => apiFetchJson(url, secretsPresenceSchema),
    { refreshInterval: 12000 },
  );

  const { data: moduleSecretsSchemaPayload } = useSWR(
    secretsSchemaUrl,
    (url) => apiFetchJson(url, moduleSecretsSchemaSchema),
    { refreshInterval: 12000 },
  );

  const presentSet = useMemo(
    () => new Set(moduleSecretsPresence?.present ?? []),
    [moduleSecretsPresence],
  );

  const currentSecretsValues = useMemo(
    () =>
      buildFormSkeleton(
        moduleSecretsSchemaPayload?.secretsSchema ?? {},
        presentSet,
      ),
    [moduleSecretsSchemaPayload, presentSet],
  );

  const hasConfig = Boolean(
    hasSchemaProperties(
      moduleConfigSchemaPayload?.configSchema ?? moduleDetail?.configSchema,
    ) ||
      (moduleConfig?.config && Object.keys(moduleConfig.config).length > 0) ||
      (moduleConfig?.outdated && moduleConfig.outdated.length > 0),
  );

  const hasSecrets = Boolean(
    hasSchemaProperties(
      moduleSecretsSchemaPayload?.secretsSchema ?? moduleDetail?.secretsSchema,
    ) ||
      (moduleSecretsPresence?.present &&
        moduleSecretsPresence.present.length > 0) ||
      (moduleSecretsPresence?.outdated &&
        moduleSecretsPresence.outdated.length > 0),
  );

  const hasAuth = Boolean(
    moduleDetail?.schemes && Object.keys(moduleDetail.schemes).length > 0,
  );

  const availableTabs = useMemo(() => {
    const list: string[] = [];
    if (hasConfig) list.push("configuration");
    if (hasSecrets) list.push("secrets");
    if (hasAuth) list.push("authentication");
    return list;
  }, [hasConfig, hasSecrets, hasAuth]);

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
    configuration: {
      title: "Configuration",
      description: "Non-secret settings for this module.",
    },
    secrets: {
      title: "Secrets",
      description: "Secret values for this module.",
    },
    authentication: {
      title: "Authentication",
      description: "Credentials for this module's auth schemes.",
    },
  };

  const refreshModuleLists = async () => {
    await mutate(
      (key) =>
        typeof key === "string" && key.startsWith(`${buildUrl("/modules")}?`),
    );
  };

  const handleRefetchAll = async () => {
    if (configUrl) await mutate(configUrl);
    if (secretsUrl) await mutate(secretsUrl);
    if (secretsSchemaUrl) await mutate(secretsSchemaUrl);
    if (configSchemaUrl) await mutate(configSchemaUrl);
    if (moduleDetailUrl) await mutate(moduleDetailUrl);
    await refreshModuleLists();
  };

  const handleSetEnabled = async (id: string, enabled: boolean) => {
    setTogglingModuleId(id);
    try {
      await apiFetch(buildUrl(`/modules/${id}/enabled`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });

      await refreshModuleLists();
      if (moduleDetailUrl) {
        await mutate(moduleDetailUrl);
      }
      if (configUrl) {
        await mutate(configUrl);
      }
      addNotification({
        type: "success",
        title: `Module ${enabled ? "enabled" : "disabled"}`,
        message: `Module ${enabled ? "enabled" : "disabled"}.`,
      });
    } catch (error) {
      addNotification({
        type: "error",
        title: "Module state update failed",
        message: errorMessageFrom(error, "Unable to update module state."),
      });
    } finally {
      setTogglingModuleId(null);
    }
  };

  const handleCheckForUpdate = async () => {
    if (!moduleDetail?.source) {
      setIsManualUpdateOpen(true);
      return;
    }

    setIsCheckingUpdate(true);
    try {
      const check = await apiFetchJson(
        buildUrl(`/modules/${moduleDetail.id}/update-check`),
        updateCheckSchema,
      );
      setUpdateCheck(check);

      if (!check.hasSource) {
        addNotification({
          type: "warning",
          title: "Update unavailable",
          message:
            "This module has no registry source. Use manual update with a direct URL.",
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
        buildUrl(`/modules/${id}/update`),
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
      if (moduleDetailUrl) {
        await mutate(moduleDetailUrl);
      }
      await refreshModuleLists();
      setUpdateCheck(null);
      addNotification({
        type: "success",
        title: result.updated ? "Module updated" : "Already current",
        message: result.updated
          ? `Updated from ${formatVersion(result.fromVersion)} → ${formatVersion(result.toVersion)}.`
          : `Already at ${formatVersion(result.toVersion)}.`,
      });
    } catch (error) {
      addNotification({
        type: "error",
        title: "Module update failed",
        message: errorMessageFrom(error, "Unable to update module."),
      });
    } finally {
      setIsUpdating(false);
    }
  };

  const handleToggleAutoUpdate = async (next: boolean) => {
    if (!moduleDetail) return;
    setIsSavingAutoUpdate(true);
    try {
      await apiFetch(buildUrl(`/modules/${moduleDetail.id}/auto-update`), {
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
      if (moduleDetailUrl) await mutate(moduleDetailUrl);
      addNotification({
        type: "success",
        title: next ? "Automatic updates on" : "Automatic updates off",
        message: next
          ? "This module will follow its update policy on the background sweep."
          : "Automatic updates are off for this module.",
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
    if (!moduleDetail) return;
    const trimmed = (constraintDraft ?? "").trim();
    setIsSavingAutoUpdate(true);
    try {
      await apiFetch(buildUrl(`/modules/${moduleDetail.id}/auto-update`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          autoUpdate: moduleDetail.autoUpdate,
          constraint: trimmed.length > 0 ? trimmed : null,
        }),
      });
      if (moduleDetailUrl) await mutate(moduleDetailUrl);
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

  const handleRestartModule = async (id: string) => {
    setIsRestarting(true);
    try {
      await apiFetch(buildUrl(`/modules/${id}/restart`), { method: "POST" });
      if (moduleDetailUrl) await mutate(moduleDetailUrl);
      await refreshModuleLists();
      addNotification({
        type: "success",
        title: "Module restarted",
        message:
          "The module was reloaded in place. Dependent services were reconciled.",
      });
    } catch (error) {
      addNotification({
        type: "error",
        title: "Module restart failed",
        message: errorMessageFrom(error, "Unable to restart module."),
      });
    } finally {
      setIsRestarting(false);
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
      await apiFetch(buildUrl(`/modules/${id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: trimmed }),
      });
      setManualUpdateUrl("");
      setIsManualUpdateOpen(false);
      if (moduleDetailUrl) {
        await mutate(moduleDetailUrl);
      }
      await refreshModuleLists();
      addNotification({
        type: "success",
        title: "Module updated",
        message: "Module updated.",
      });
    } catch (error) {
      addNotification({
        type: "error",
        title: "Module update failed",
        message: errorMessageFrom(error, "Unable to update module."),
      });
    } finally {
      setIsManualUpdating(false);
    }
  };

  const handleDelete = async (id: string) => {
    setIsDeleting(true);
    try {
      await apiFetch(buildUrl(`/modules/${id}`), {
        method: "DELETE",
      });
      await refreshModuleLists();
      addNotification({
        type: "success",
        title: "Module deleted",
        message: "Module deleted.",
      });
      navigate("/settings/modules");
    } catch (error) {
      addNotification({
        type: "error",
        title: "Module deletion failed",
        message: errorMessageFrom(error, "Unable to delete module."),
      });
    } finally {
      setIsDeleting(false);
    }
  };

  if (!moduleId) {
    navigate("/settings/modules");
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
              Back to Modules
            </Button>
          </div>

          {detailsError ? (
            <p className="text-sm text-destructive">
              Failed to load module details.
            </p>
          ) : null}

          {moduleDetail ? (
            <>
              <div className="flex items-start gap-3">
                <EntityIcon
                  kind="module"
                  id={moduleDetail.id}
                  label={moduleDetail.name}
                  hasIcon={moduleDetail.hasIcon}
                />
                <div>
                  <div className="flex items-center flex-wrap gap-2">
                    <h2 className="text-md font-semibold">
                      {moduleDetail.name}
                    </h2>
                    <Badge variant="secondary">{moduleDetail.type}</Badge>
                    {moduleDetail.isBuiltin ? (
                      <Badge variant="outline">built-in</Badge>
                    ) : null}
                    {moduleDetail.missing ? (
                      <Badge variant="destructive">missing</Badge>
                    ) : null}
                  </div>
                  <p className="text-muted-foreground text-xs font-mono">
                    {moduleDetail.id}@{moduleDetail.version}
                  </p>
                </div>
              </div>
              {moduleDetail.summary ? (
                <p className="text-muted-foreground text-sm">
                  {moduleDetail.summary}
                </p>
              ) : null}
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant={moduleDetail.enabled ? "outline" : "default"}
                  disabled={
                    togglingModuleId === moduleDetail.id || moduleDetail.missing
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
                    {moduleDetail.source ? (
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
                    <Button
                      type="button"
                      variant="outline"
                      disabled={isRestarting}
                      onClick={() => setIsRestartDialogOpen(true)}
                      className="gap-2"
                    >
                      <RotateCcw
                        className={isRestarting ? "animate-spin" : undefined}
                      />
                      {isRestarting ? "Restarting" : "Restart"}
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      disabled={isDeleting}
                      onClick={() => {
                        setIsDeleteDialogOpen(true);
                      }}
                    >
                      {isDeleting ? (
                        <Loader2 className="animate-spin" />
                      ) : (
                        <Trash2 />
                      )}
                      Delete
                    </Button>
                  </>
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
                {hasAuth && moduleDetail.schemes ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="gap-2"
                    onClick={() => openSheet("authentication")}
                  >
                    <ShieldCheck />
                    Authentication
                    <Badge variant="secondary" size="sm" className="p-1.5">
                      {Object.keys(moduleDetail.schemes).length}
                    </Badge>
                  </Button>
                ) : null}
              </div>
            </>
          ) : null}
        </header>

        {moduleDetail ? (
          <div className="flex min-h-0 flex-1 flex-col gap-6 p-6">
            <div className="space-y-2">
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

            {availableTabs.length === 0 ? (
              <div className="flex items-center justify-center h-full py-12">
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <Package aria-hidden />
                    </EmptyMedia>
                    <EmptyTitle>Nothing to configure</EmptyTitle>
                    <EmptyDescription>
                      No configuration or secrets available for this module.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="flex items-center justify-center flex-1">
            <Loader2 className="animate-spin" />
          </div>
        )}
      </section>

      {moduleDetail && isSheetOpen ? (
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
            {activeSheet === "configuration" && hasConfig ? (
              <JsonSchemaFormSheet
                schema={
                  moduleConfigSchemaPayload?.configSchema ??
                  moduleDetail.configSchema ??
                  {}
                }
                currentValues={
                  (moduleConfig?.config ?? {}) as Record<string, unknown>
                }
                patchUrl={buildUrl(`/modules/${moduleDetail.id}/config`)}
                outdatedPaths={moduleConfig?.outdated}
                onSaved={handleRefetchAll}
              />
            ) : null}
            {activeSheet === "secrets" && hasSecrets ? (
              <JsonSchemaFormSheet
                schema={
                  moduleSecretsSchemaPayload?.secretsSchema ??
                  moduleDetail.secretsSchema ??
                  {}
                }
                currentValues={currentSecretsValues}
                presentSet={presentSet}
                patchUrl={buildUrl(`/modules/${moduleDetail.id}/secrets`)}
                outdatedPaths={moduleSecretsPresence?.outdated}
                onSaved={handleRefetchAll}
              />
            ) : null}
            {activeSheet === "authentication" &&
            hasAuth &&
            moduleDetail.schemes ? (
              <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
                <AuthSection
                  target={{ kind: "module", id: moduleDetail.id }}
                  authSchemes={moduleDetail.schemes}
                />
              </div>
            ) : null}
          </SheetContent>
        </Sheet>
      ) : null}

      {moduleDetail && !moduleDetail.isBuiltin ? (
        <VersionUpdatesDialog
          open={isVersionDialogOpen}
          onOpenChange={setIsVersionDialogOpen}
          kind="module"
          installedVersion={moduleDetail.version}
          autoUpdate={moduleDetail.autoUpdate}
          autoUpdateConstraint={moduleDetail.autoUpdateConstraint}
          hasSource={Boolean(moduleDetail.source)}
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
              Provide a new archive URL for this module.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="module-update-url">Archive URL</Label>
            <Input
              id="module-update-url"
              onChange={(event) => setManualUpdateUrl(event.target.value)}
              placeholder="https://example.com/module.tar.zst"
              value={manualUpdateUrl}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              disabled={isManualUpdating || !manualUpdateUrl.trim()}
              onClick={() =>
                moduleDetail && void handleManualUpdate(moduleDetail.id)
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
                : "A new version of this module is available. Update now?"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                void handleConfirmUpdate(moduleDetail.id);
              }}
            >
              Update
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={isRestartDialogOpen}
        onOpenChange={(open) => {
          setIsRestartDialogOpen(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restart module?</AlertDialogTitle>
            <AlertDialogDescription>
              Restarting reloads the module in place and reconciles dependent
              services. In-flight invocations may be briefly interrupted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!moduleDetail) return;
                setIsRestartDialogOpen(false);
                void handleRestartModule(moduleDetail.id);
              }}
            >
              Restart
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
    </>
  );
}
