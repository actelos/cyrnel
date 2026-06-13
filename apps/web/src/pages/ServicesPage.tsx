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
import { useNotification } from "@/hooks/use-notification";
import { apiFetch, apiFetchJson, buildUrl, errorMessageFrom } from "@/lib/api";
import { cn } from "@/lib/utils";

const serviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  adapter: z.string(),
  enabled: z.boolean(),
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
  orphaned: z.boolean(),
});

const moduleListSchema = z.object({
  modules: z.array(moduleSchema),
});

const installServiceSchema = z.object({
  id: z
    .string()
    .trim()
    .regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/, {
      message: "Id must be a valid TypeScript identifier.",
    }),
  source: z.url({ message: "Definition URL must be a valid URL." }),
  adapter: z.string().trim().min(1, { message: "Adapter is required." }),
});

type InstallServiceErrors = Partial<
  Record<"id" | "source" | "adapter" | "form", string>
>;

export default function ServicesPage() {
  const { mutate } = useSWRConfig();
  const [queryFilter, setQueryFilter] = useState("");
  const [enabledFilter, setEnabledFilter] = useState<
    "all" | "enabled" | "disabled"
  >("all");
  const [adapterFilter, setAdapterFilter] = useState("all");
  const [isInstallOpen, setIsInstallOpen] = useState(false);
  const [installId, setInstallId] = useState("");
  const [installSource, setInstallSource] = useState("");
  const [installAdapter, setInstallAdapter] = useState("");
  const [installErrors, setInstallErrors] = useState<InstallServiceErrors>({});
  const [isInstalling, setIsInstalling] = useState(false);
  const { addNotification } = useNotification();
  const normalizedQuery = queryFilter.trim();
  const enabledParam =
    enabledFilter === "all"
      ? undefined
      : enabledFilter === "enabled"
        ? "true"
        : "false";

  const servicesUrl = useMemo(() => {
    return buildUrl("/services", {
      query: normalizedQuery.length > 0 ? normalizedQuery : undefined,
      enabled: enabledParam,
      adapter: adapterFilter !== "all" ? adapterFilter : undefined,
    });
  }, [normalizedQuery, enabledParam, adapterFilter]);

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

  const handleInstallService = async () => {
    setInstallErrors({});

    const parsed = installServiceSchema.safeParse({
      id: installId,
      source: installSource,
      adapter: installAdapter,
    });

    if (!parsed.success) {
      const fieldErrors = z.flattenError(parsed.error).fieldErrors;
      setInstallErrors({
        id: fieldErrors.id?.[0],
        source: fieldErrors.source?.[0],
        adapter: fieldErrors.adapter?.[0],
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

      setInstallId("");
      setInstallSource("");
      setInstallAdapter("");
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
                      Provide a service id, definition URL, and adapter.
                    </p>
                  </div>
                  <div className="space-y-3">
                    <div className="space-y-2">
                      <Label htmlFor="service-id">ID</Label>
                      <Input
                        id="service-id"
                        onChange={(event) => setInstallId(event.target.value)}
                        placeholder="myService"
                        value={installId}
                      />
                      {installErrors.id ? (
                        <p className="text-xs text-destructive">
                          {installErrors.id}
                        </p>
                      ) : null}
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="service-source">Definition URL</Label>
                      <Input
                        id="service-source"
                        onChange={(event) =>
                          setInstallSource(event.target.value)
                        }
                        placeholder="https://example.com/manifest.json"
                        value={installSource}
                      />
                      {installErrors.source ? (
                        <p className="text-xs text-destructive">
                          {installErrors.source}
                        </p>
                      ) : null}
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="service-adapter">Adapter</Label>
                      {adapters.length > 0 ? (
                        <Select
                          onValueChange={setInstallAdapter}
                          value={installAdapter}
                        >
                          <SelectTrigger id="service-adapter">
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
                          id="service-adapter"
                          onChange={(event) =>
                            setInstallAdapter(event.target.value)
                          }
                          placeholder="openapi"
                          value={installAdapter}
                        />
                      )}
                      {installErrors.adapter ? (
                        <p className="text-xs text-destructive">
                          {installErrors.adapter}
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
                      onClick={() => void handleInstallService()}
                    >
                      {isInstalling ? "Installing" : "Install"}
                    </Button>
                  </div>
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
              onValueChange={setAdapterFilter}
              value={adapterFilter}
            >
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
