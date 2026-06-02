import { RefreshCw, RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { z } from "zod";
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
  const [togglingModuleId, setTogglingModuleId] = useState<string | null>(null);
  const [isReloading, setIsReloading] = useState(false);

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

      <Card className="flex min-h-0 flex-1 flex-col">
        <CardContent className="min-h-0 flex-1">
          <ScrollArea className="h-full">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {modules.map((module) => (
                <div
                  key={module.id}
                  className={cn(
                    "border bg-card p-4 space-y-3",
                    module.orphaned ? "border-destructive/50" : "border-border",
                  )}
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
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
                    <button
                      type="button"
                      role="switch"
                      aria-checked={module.enabled}
                      disabled={
                        togglingModuleId === module.id ||
                        (!module.enabled && module.orphaned)
                      }
                      className={cn(
                        "relative inline-flex h-6 w-11 items-center transition",
                        module.enabled ? "bg-primary" : "bg-muted",
                        (togglingModuleId === module.id ||
                          (!module.enabled && module.orphaned)) &&
                          "opacity-50 cursor-not-allowed",
                      )}
                      onClick={() =>
                        void handleSetEnabled(module, !module.enabled)
                      }
                    >
                      <span
                        className={cn(
                          "inline-block h-4 w-4 transform bg-background shadow transition",
                          module.enabled ? "translate-x-6" : "translate-x-1",
                        )}
                      />
                    </button>
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
            {actionError ? (
              <p className="p-4 text-sm text-destructive">{actionError}</p>
            ) : null}
          </ScrollArea>
        </CardContent>
      </Card>
    </section>
  );
}
