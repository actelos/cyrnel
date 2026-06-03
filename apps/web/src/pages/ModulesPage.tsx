import { RefreshCw, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { z } from "zod";
import ConfigEditor from "@/components/ConfigEditor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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

const moduleTypeSchema = z.enum(["adapter", "environment"]);

const moduleSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: moduleTypeSchema,
  description: z.string(),
  isBuiltin: z.boolean(),
  enabled: z.boolean(),
  orphaned: z.boolean(),
});

const moduleListSchema = z.object({
  modules: z.array(moduleSchema),
});

const moduleConfigSchema = z.object({
  config: z.record(z.string(), z.unknown()),
});

const moduleConfigSchemaSchema = z.object({
  configSchema: z.record(z.string(), z.unknown()),
});

const moduleSecretsSchemaSchema = z.object({
  secretsSchema: z.record(z.string(), z.unknown()),
});

type Module = z.infer<typeof moduleSchema>;
type ModuleType = z.infer<typeof moduleTypeSchema>;

export default function ModulesPage() {
  const { mutate } = useSWRConfig();
  const [queryFilter, setQueryFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | ModuleType>("all");
  const [enabledFilter, setEnabledFilter] = useState<
    "all" | "enabled" | "disabled"
  >("all");
  const [builtinFilter, setBuiltinFilter] = useState<
    "all" | "builtin" | "custom"
  >("all");
  const [actionError, setActionError] = useState<string | null>(null);
  const [selectedModuleId, setSelectedModuleId] = useState<string | null>(null);
  const [togglingModuleId, setTogglingModuleId] = useState<string | null>(null);
  const [isReloading, setIsReloading] = useState(false);
  const [configDraft, setConfigDraft] = useState<string>("{\n  \n}");
  const [configDraftError, setConfigDraftError] = useState<string | null>(null);
  const [isSavingConfig, setIsSavingConfig] = useState(false);
  const [secretsDraft, setSecretsDraft] = useState<string>("{\n  \n}");
  const [secretsDraftError, setSecretsDraftError] = useState<string | null>(
    null,
  );
  const [isSavingSecrets, setIsSavingSecrets] = useState(false);
  const lastSeededConfigRef = useRef<string | null>(null);
  const lastSeededConfigModuleRef = useRef<string | null>(null);

  const normalizedQuery = queryFilter.trim();

  const modulesUrl = useMemo(() => {
    return buildUrl("/modules", {
      query: normalizedQuery.length > 0 ? normalizedQuery : undefined,
      type: typeFilter === "all" ? undefined : typeFilter,
      enabled:
        enabledFilter === "all"
          ? undefined
          : enabledFilter === "enabled"
            ? "true"
            : "false",
      isBuiltin:
        builtinFilter === "all"
          ? undefined
          : builtinFilter === "builtin"
            ? "true"
            : "false",
    });
  }, [normalizedQuery, typeFilter, enabledFilter, builtinFilter]);

  const {
    data: moduleList,
    error: modulesError,
    isLoading: isLoadingModules,
  } = useSWR(modulesUrl, (url) => apiFetchJson(url, moduleListSchema), {
    refreshInterval: 8000,
  });

  const modules = moduleList?.modules ?? [];

  useEffect(() => {
    if (modules.length === 0) {
      setSelectedModuleId(null);
      return;
    }

    if (
      selectedModuleId === null ||
      !modules.some((module) => module.id === selectedModuleId)
    ) {
      setSelectedModuleId(modules[0]?.id ?? null);
    }
  }, [modules, selectedModuleId]);

  const selectedModule = useMemo(() => {
    return modules.find((module) => module.id === selectedModuleId) ?? null;
  }, [modules, selectedModuleId]);

  const configUrl = selectedModuleId
    ? buildUrl(`/modules/${selectedModuleId}/config`)
    : null;

  const configSchemaUrl = selectedModuleId
    ? buildUrl(`/modules/${selectedModuleId}/config/schema`)
    : null;

  const secretsSchemaUrl = selectedModuleId
    ? buildUrl(`/modules/${selectedModuleId}/secrets/schema`)
    : null;

  const { data: moduleConfig } = useSWR(
    configUrl,
    (url) => apiFetchJson(url, moduleConfigSchema),
    { refreshInterval: 8000 },
  );

  const { data: moduleConfigSchemaPayload } = useSWR(
    configSchemaUrl,
    (url) => apiFetchJson(url, moduleConfigSchemaSchema),
    { refreshInterval: 8000 },
  );

  const { data: moduleSecretsSchemaPayload } = useSWR(
    secretsSchemaUrl,
    (url) => apiFetchJson(url, moduleSecretsSchemaSchema),
    { refreshInterval: 8000 },
  );

  const currentConfigDisplay = JSON.stringify(
    moduleConfig?.config ?? {},
    null,
    2,
  );

  useEffect(() => {
    if (!selectedModuleId) {
      return;
    }

    const normalized = JSON.stringify(moduleConfig?.config ?? {}, null, 2);
    const moduleChanged =
      lastSeededConfigModuleRef.current !== selectedModuleId;
    const editorPristine = configDraft === lastSeededConfigRef.current;

    if (moduleChanged || editorPristine) {
      setConfigDraftError(null);
      setConfigDraft(normalized);
      lastSeededConfigRef.current = normalized;
      lastSeededConfigModuleRef.current = selectedModuleId;
    }
  }, [selectedModuleId, moduleConfig?.config, configDraft]);

  useEffect(() => {
    if (!selectedModuleId) {
      return;
    }

    setSecretsDraftError(null);
    setSecretsDraft("{\n  \n}");
  }, [selectedModuleId]);

  const escapeJsonPointer = (value: string) =>
    value.replace(/~/g, "~0").replace(/\//g, "~1");

  const buildPatchFromObject = (
    current: Record<string, unknown>,
    next: Record<string, unknown>,
  ): Array<Record<string, unknown>> => {
    const patch: Array<Record<string, unknown>> = [];

    for (const key of Object.keys(current)) {
      if (!Object.hasOwn(next, key)) {
        patch.push({ op: "remove", path: `/${escapeJsonPointer(key)}` });
      }
    }

    for (const [key, value] of Object.entries(next)) {
      const op = Object.hasOwn(current, key) ? "replace" : "add";
      if (
        Object.hasOwn(current, key) &&
        JSON.stringify(current[key]) === JSON.stringify(value)
      ) {
        continue;
      }
      patch.push({ op, path: `/${escapeJsonPointer(key)}`, value });
    }

    return patch;
  };

  const handleSetEnabled = async (module: Module, enabled: boolean) => {
    setActionError(null);
    setTogglingModuleId(module.id);
    try {
      await apiFetch(buildUrl(`/modules/${module.id}/enabled`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });

      await mutate(modulesUrl);
      if (configUrl) {
        await mutate(configUrl);
      }
    } catch (error) {
      setActionError(errorMessageFrom(error, "Unable to update module state."));
    } finally {
      setTogglingModuleId(null);
    }
  };

  const handleReloadModules = async () => {
    setActionError(null);
    setIsReloading(true);
    try {
      await apiFetch(buildUrl("/modules/reload"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      await mutate(modulesUrl);
    } catch (error) {
      setActionError(errorMessageFrom(error, "Unable to reload modules."));
    } finally {
      setIsReloading(false);
    }
  };

  const handleSaveConfiguration = async (moduleId: string) => {
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

    let patch: Array<Record<string, unknown>>;

    if (Array.isArray(desiredConfig)) {
      patch = desiredConfig as Array<Record<string, unknown>>;
    } else {
      if (!desiredConfig || typeof desiredConfig !== "object") {
        setConfigDraftError(
          "Configuration must be a JSON object or JSON Patch array.",
        );
        return;
      }

      patch = buildPatchFromObject(
        (moduleConfig?.config ?? {}) as Record<string, unknown>,
        desiredConfig as Record<string, unknown>,
      );
    }

    setIsSavingConfig(true);
    try {
      const saved = await apiFetchJson(
        buildUrl(`/modules/${moduleId}/config`),
        moduleConfigSchema,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        },
      );
      const normalized = JSON.stringify(saved.config ?? {}, null, 2);
      setConfigDraft(normalized);
      lastSeededConfigRef.current = normalized;
      lastSeededConfigModuleRef.current = moduleId;

      if (configUrl) await mutate(configUrl, saved, { revalidate: true });
      await mutate(modulesUrl);
    } catch (error) {
      setActionError(errorMessageFrom(error, "Unable to save configuration."));
    } finally {
      setIsSavingConfig(false);
    }
  };

  const handleSaveSecrets = async (moduleId: string) => {
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

      patch.push({ op: "replace", path: "", value: desiredSecrets });
    }

    setIsSavingSecrets(true);
    try {
      await apiFetch(buildUrl(`/modules/${moduleId}/secrets`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });

      setSecretsDraft("{\n  \n}");
      await mutate(modulesUrl);
    } catch (error) {
      setActionError(errorMessageFrom(error, "Unable to save secrets."));
    } finally {
      setIsSavingSecrets(false);
    }
  };

  const hasDetailPanel = selectedModuleId !== null;

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-6 p-6">
      <header className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-xl font-semibold">Modules</h1>
            <p className="text-muted-foreground text-sm">
              Manage adapter and environment modules.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              className="gap-2"
              disabled={isReloading}
              onClick={() => void handleReloadModules()}
            >
              <RefreshCw />
              {isReloading ? "Reloading" : "Reload modules"}
            </Button>
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
          <div className="flex flex-wrap items-center gap-2">
            <Select
              onValueChange={(value) =>
                setTypeFilter(value as "all" | ModuleType)
              }
              value={typeFilter}
            >
              <SelectTrigger className="w-[160px]">
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
                setEnabledFilter(value as "all" | "enabled" | "disabled")
              }
              value={enabledFilter}
            >
              <SelectTrigger className="w-[160px]">
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
                setBuiltinFilter(value as "all" | "builtin" | "custom")
              }
              value={builtinFilter}
            >
              <SelectTrigger className="w-[160px]">
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
              className="gap-2"
              onClick={() => void mutate(modulesUrl)}
              aria-label="Refresh modules"
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
                {modules.map((module) => (
                  <button
                    key={module.id}
                    type="button"
                    onClick={() => setSelectedModuleId(module.id)}
                    className={cn(
                      "text-left border bg-card p-4 space-y-3 hover:bg-muted",
                      selectedModuleId === module.id
                        ? "border-primary"
                        : module.orphaned
                          ? "border-destructive/50"
                          : "border-border",
                    )}
                  >
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-sm font-semibold">{module.name}</h3>
                        <Badge variant="secondary">{module.type}</Badge>
                        {module.isBuiltin ? (
                          <Badge variant="outline">built-in</Badge>
                        ) : null}
                        {module.orphaned ? (
                          <Badge variant="destructive">orphaned</Badge>
                        ) : null}
                      </div>
                      <p className="text-muted-foreground text-xs font-mono">
                        {module.id}
                      </p>
                      <p className="text-muted-foreground text-xs">
                        {module.description || "No description"}
                      </p>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-muted-foreground">
                        {module.enabled ? "Enabled" : "Disabled"}
                      </span>
                      <span
                        className={cn(
                          "inline-flex h-6 w-11 items-center transition",
                          module.enabled ? "bg-primary" : "bg-muted",
                        )}
                      >
                        <span
                          className={cn(
                            "inline-block h-4 w-4 transform bg-background shadow transition",
                            module.enabled ? "translate-x-6" : "translate-x-1",
                          )}
                        />
                      </span>
                    </div>
                  </button>
                ))}
              </div>

              {modulesError ? (
                <p className="p-4 text-sm text-destructive">
                  Failed to load modules.
                </p>
              ) : null}
              {!isLoadingModules && modules.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">
                  No modules match the current filters.
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
                  {selectedModule ? (
                    <div className="space-y-6">
                      <div className="space-y-4">
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <h2 className="text-lg font-semibold">
                              {selectedModule.name}
                            </h2>
                            <Badge variant="secondary">
                              {selectedModule.type}
                            </Badge>
                            {selectedModule.isBuiltin ? (
                              <Badge variant="outline">built-in</Badge>
                            ) : null}
                            {selectedModule.orphaned ? (
                              <Badge variant="destructive">orphaned</Badge>
                            ) : null}
                          </div>
                          <p className="text-muted-foreground text-xs font-mono">
                            {selectedModule.id}
                          </p>
                          <p className="text-muted-foreground text-sm">
                            {selectedModule.description || "No description"}
                          </p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            type="button"
                            variant={
                              selectedModule.enabled ? "outline" : "default"
                            }
                            disabled={
                              togglingModuleId === selectedModule.id ||
                              (!selectedModule.enabled &&
                                selectedModule.orphaned)
                            }
                            onClick={() =>
                              void handleSetEnabled(
                                selectedModule,
                                !selectedModule.enabled,
                              )
                            }
                          >
                            {selectedModule.enabled ? "Disable" : "Enable"}
                          </Button>
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
                            disabled={isSavingConfig || !selectedModule}
                            onClick={() => {
                              if (!selectedModule) {
                                return;
                              }
                              void handleSaveConfiguration(selectedModule.id);
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
                          idPrefix="module-config"
                          config={currentConfigDisplay}
                          schema={JSON.stringify(
                            moduleConfigSchemaPayload?.configSchema ?? {},
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
                            disabled={isSavingSecrets || !selectedModule}
                            onClick={() => {
                              if (!selectedModule) {
                                return;
                              }
                              void handleSaveSecrets(selectedModule.id);
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
                          or JSON Patch array with the values to set.
                        </p>

                        <ConfigEditor
                          idPrefix="module-secrets"
                          labels={{
                            config: "Current Secrets",
                            schema: "Schema",
                            patch: "Edit Secrets (JSON or JSON Patch)",
                          }}
                          hideConfig
                          config={secretsDraft}
                          schema={JSON.stringify(
                            moduleSecretsSchemaPayload?.secretsSchema ?? {},
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
                      Select a module to view details.
                    </p>
                  )}
                </ScrollArea>
              </CardContent>
            </Card>
          </aside>
        ) : null}
      </div>
    </section>
  );
}
