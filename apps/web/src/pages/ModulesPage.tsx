import { Plus, RefreshCw, RotateCcw } from "lucide-react";
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

const moduleTypeSchema = z.enum(["adapter", "environment"]);

const moduleSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: moduleTypeSchema,
  description: z.string(),
  isBuiltin: z.boolean(),
  enabled: z.boolean(),
  missing: z.boolean(),
});

const moduleListSchema = z.object({
  modules: z.array(moduleSchema),
});

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
  const { addNotification } = useNotification();
  const [isReloading, setIsReloading] = useState(false);
  const [isInstallOpen, setIsInstallOpen] = useState(false);
  const [installTab, setInstallTab] = useState<"manual" | "registry">(
    "registry",
  );
  const [manualUrl, setManualUrl] = useState("");
  const [registrySource, setRegistrySource] = useState("");
  const [isInstalling, setIsInstalling] = useState(false);

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

  const handleReloadModules = async () => {
    setIsReloading(true);
    try {
      await apiFetch(buildUrl("/modules/reload"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      await mutate(modulesUrl);
      addNotification({
        type: "success",
        title: "Success",
        message: "Modules reloaded.",
      });
    } catch (error) {
      addNotification({
        type: "error",
        title: "Error",
        message: errorMessageFrom(error, "Unable to reload modules."),
      });
    } finally {
      setIsReloading(false);
    }
  };

  const handleManualInstall = async () => {
    const trimmed = manualUrl.trim();
    if (!trimmed) {
      addNotification({
        type: "error",
        title: "Error",
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
      await mutate(modulesUrl);
      addNotification({
        type: "success",
        title: "Success",
        message: "Module installed.",
      });
    } catch (error) {
      addNotification({
        type: "error",
        title: "Error",
        message: errorMessageFrom(error, "Unable to install module."),
      });
    } finally {
      setIsInstalling(false);
    }
  };

  const handleRegistryInstall = async () => {
    const trimmed = registrySource.trim();
    if (!trimmed) {
      addNotification({
        type: "error",
        title: "Error",
        message: "Source URL is required.",
      });
      return;
    }
    setIsInstalling(true);
    try {
      await apiFetch(buildUrl("/modules/install"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: trimmed }),
      });
      setRegistrySource("");
      setIsInstallOpen(false);
      await mutate(modulesUrl);
      addNotification({
        type: "success",
        title: "Success",
        message: "Module installed.",
      });
    } catch (error) {
      addNotification({
        type: "error",
        title: "Error",
        message: errorMessageFrom(error, "Unable to install module."),
      });
    } finally {
      setIsInstalling(false);
    }
  };

  const handleToggleModule = async (moduleId: string, enabled: boolean) => {
    try {
      await apiFetch(buildUrl(`/modules/${moduleId}/enabled`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !enabled }),
      });
      await mutate(modulesUrl);
      addNotification({
        type: "success",
        title: "Success",
        message: `Module ${enabled ? "disabled" : "enabled"}.`,
      });
    } catch (error) {
      addNotification({
        type: "error",
        title: "Error",
        message: errorMessageFrom(error, "Failed to toggle module."),
      });
    }
  };

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
            <Popover open={isInstallOpen} onOpenChange={setIsInstallOpen}>
              <PopoverTrigger asChild>
                <Button className="gap-2" type="button">
                  <Plus />
                  Install module
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-md">
                <div className="space-y-4">
                  <div className="space-y-1">
                    <h3 className="text-sm font-medium">Install module</h3>
                    <p className="text-muted-foreground text-xs">
                      Install from a registry or provide a direct URL.
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
                          <Label htmlFor="module-registry-source">
                            Source URL
                          </Label>
                          <Input
                            id="module-registry-source"
                            onChange={(event) =>
                              setRegistrySource(event.target.value)
                            }
                            placeholder="https://registry.example.com/module"
                            value={registrySource}
                          />
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
                            disabled={isInstalling || !registrySource.trim()}
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
                    </TabsContent>
                  </Tabs>
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
              onClick={() => {
                mutate(modulesUrl)
                  .then(() => {
                    addNotification({
                      type: "success",
                      title: "Success",
                      message: "Modules refreshed.",
                    });
                  })
                  .catch((error) => {
                    addNotification({
                      type: "error",
                      title: "Error",
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
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-6">
        <Card className="flex min-h-0 flex-1 flex-col">
          <CardContent className="min-h-0 flex-1">
            <ScrollArea className="h-full">
              <div className="grid gap-4 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
                {modules.map((module) => (
                  <div
                    key={module.id}
                    className={cn(
                      "flex flex-col justify-between border bg-card p-4",
                      module.missing
                        ? "border-destructive/50"
                        : "border-border",
                    )}
                  >
                    <Link
                      to={`/modules/${module.id}`}
                      className="block -mx-4 -mt-4 -mr-4 mb-3 p-4"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="space-y-2 min-w-0">
                          <div className="flex items-center justify-between flex-wrap gap-2">
                            <h3 className="text-sm font-semibold">
                              {module.name}
                            </h3>
                            <div className="flex items-center gap-1">
                              <Badge variant="secondary">{module.type}</Badge>
                              {module.isBuiltin ? (
                                <Badge variant="outline">built-in</Badge>
                              ) : null}
                              {module.missing ? (
                                <Badge variant="destructive">missing</Badge>
                              ) : null}
                            </div>
                          </div>
                          <p className="text-muted-foreground text-xs font-mono truncate max-w-full">
                            {module.id}
                          </p>
                          <div className="text-muted-foreground text-xs line-clamp-3">
                            {module.description ? (
                              <Markdown
                                components={{
                                  p: ({ children }) => <>{children}</>,
                                }}
                                remarkPlugins={[remarkGfm]}
                              >
                                {module.description}
                              </Markdown>
                            ) : (
                              "No description"
                            )}
                          </div>
                        </div>
                      </div>
                    </Link>
                    <div
                      className="flex cursor-pointer items-center justify-between gap-2"
                      onClick={() => {
                        if (module.missing) return;
                        void handleToggleModule(module.id, module.enabled);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          void handleToggleModule(module.id, module.enabled);
                        }
                      }}
                      role="switch"
                      aria-checked={module.enabled}
                      tabIndex={0}
                    >
                      <span className="text-xs text-muted-foreground">
                        {module.enabled ? "Enabled" : "Disabled"}
                      </span>
                      <span
                        className={cn(
                          "inline-flex h-6 w-11 items-center transition",
                          module.enabled ? "bg-primary" : "bg-secondary",
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
                  </div>
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
            </ScrollArea>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
