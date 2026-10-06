import { ChevronDown, Plus, RotateCcw, Shield } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import useSWR, { useSWRConfig } from "swr";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useNotification } from "@/hooks/use-notification";
import { useUpdateSearchParams } from "@/hooks/use-update-search-params";
import { apiFetch, apiFetchJson, buildUrl, errorMessageFrom } from "@/lib/api";

const decisionSchema = z.enum(["allow", "block", "ask"]);

type Decision = z.infer<typeof decisionSchema>;

const toolSchema = z.object({
  serviceId: z.string(),
  id: z.string(),
  name: z.string().catch(""),
  summary: z.string().catch(""),
  description: z.string().catch(""),
  enabled: z.boolean().optional(),
  effectivelyEnabled: z.boolean().optional(),
  policy: z
    .object({
      decision: decisionSchema,
      updatedAt: z.number().nullable(),
    })
    .optional(),
});

const toolListSchema = z.object({
  items: z.array(toolSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});

type Tool = z.infer<typeof toolSchema>;

const POLICY_CONSEQUENCES: Record<Decision, string> = {
  allow: "Allow — invocation proceeds automatically.",
  ask: "Ask — invocation requires approval before it can run.",
  block: "Block — invocation is rejected.",
};

function decisionBadgeVariant(decision: Decision) {
  if (decision === "allow") return "default" as const;
  if (decision === "block") return "destructive" as const;
  return "secondary" as const;
}

function DecisionBadge({ decision }: { decision: Decision }) {
  return <Badge variant={decisionBadgeVariant(decision)}>{decision}</Badge>;
}

const formatUpdatedAt = (value: number | null) => {
  if (value === null) return null;
  return new Date(value).toLocaleString();
};

const parseDecisionFilter = (raw: string | null): Decision | "all" => {
  if (raw === "all") return "all";
  if (raw !== null && decisionSchema.safeParse(raw).success) {
    return raw as Decision;
  }
  return "all";
};

type CreateErrors = Partial<
  Record<"serviceId" | "toolId" | "decision" | "form", string>
>;

export default function ToolPermissionsPage() {
  const { mutate } = useSWRConfig();
  const { addNotification } = useNotification();
  const [searchParams] = useSearchParams();
  const updateSearchParams = useUpdateSearchParams();

  const serviceFilter = searchParams.get("serviceId") ?? "";
  const queryFilter = searchParams.get("q") ?? "";
  const decisionFilter = parseDecisionFilter(searchParams.get("decision"));

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [createServiceId, setCreateServiceId] = useState("");
  const [createToolId, setCreateToolId] = useState("");
  const [createDecision, setCreateDecision] = useState<Decision>("allow");
  const [createErrors, setCreateErrors] = useState<CreateErrors>({});
  const [isCreating, setIsCreating] = useState(false);

  const [updatingKey, setUpdatingKey] = useState<string | null>(null);

  const toolsUrl = useMemo(() => {
    return buildUrl("/tools", {
      serviceId:
        serviceFilter.trim().length > 0 ? serviceFilter.trim() : undefined,
      query: queryFilter.trim().length > 0 ? queryFilter.trim() : undefined,
      decision: decisionFilter === "all" ? undefined : decisionFilter,
      limit: "100",
    });
  }, [serviceFilter, queryFilter, decisionFilter]);

  const {
    data: toolList,
    error: toolsError,
    isLoading: isLoadingTools,
    isValidating: isToolsValidating,
  } = useSWR(toolsUrl, (url) => apiFetchJson(url, toolListSchema), {
    refreshInterval: 8000,
  });

  const [extraTools, setExtraTools] = useState<Tool[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const paginationVersionRef = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: toolsUrl triggers pagination reset
  useEffect(() => {
    paginationVersionRef.current += 1;
    setExtraTools([]);
    setNextCursor(null);
    setLoadMoreError(null);
  }, [toolsUrl]);

  useEffect(() => {
    if (
      extraTools.length === 0 &&
      toolList !== undefined &&
      !isToolsValidating
    ) {
      setNextCursor(toolList.nextCursor);
    }
  }, [toolList, extraTools.length, isToolsValidating]);

  const tools = useMemo(() => {
    const seen = new Set<string>();
    const merged: Tool[] = [];
    for (const tool of [...(toolList?.items ?? []), ...extraTools]) {
      const key = `${tool.serviceId}:${tool.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(tool);
    }
    return merged;
  }, [toolList, extraTools]);

  const refreshTools = async () => {
    paginationVersionRef.current += 1;
    setExtraTools([]);
    setNextCursor(null);
    setLoadMoreError(null);
    await mutate(toolsUrl);
  };

  const loadMoreTools = useCallback(async () => {
    if (nextCursor === null || isLoadingMore) return;
    const startedVersion = paginationVersionRef.current;
    setIsLoadingMore(true);
    setLoadMoreError(null);
    try {
      const separator = toolsUrl.includes("?") ? "&" : "?";
      const data = await apiFetchJson(
        `${toolsUrl}${separator}cursor=${encodeURIComponent(nextCursor)}`,
        toolListSchema,
      );
      if (paginationVersionRef.current !== startedVersion) return;
      setExtraTools((previous) => [...previous, ...data.items]);
      setNextCursor(data.nextCursor);
    } catch (error) {
      if (paginationVersionRef.current !== startedVersion) return;
      const message = errorMessageFrom(error, "Failed to load more tools.");
      setLoadMoreError(message);
      addNotification({
        type: "error",
        title: "Load more failed",
        message,
      });
    } finally {
      if (paginationVersionRef.current === startedVersion) {
        setIsLoadingMore(false);
      }
    }
  }, [nextCursor, isLoadingMore, toolsUrl, addNotification]);

  const handlePolicyChange = async (
    serviceId: string,
    toolId: string,
    decision: Decision,
  ) => {
    const key = `${serviceId}:${toolId}`;
    setUpdatingKey(key);
    try {
      await apiFetch(
        buildUrl(
          `/tools/${encodeURIComponent(serviceId)}/${encodeURIComponent(toolId)}/policy`,
        ),
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision }),
        },
      );
      await refreshTools();
      addNotification({
        type: "success",
        title: `Tool policy set to ${decision}`,
        message: POLICY_CONSEQUENCES[decision],
      });
    } catch (error) {
      addNotification({
        type: "error",
        title: "Tool policy update failed",
        message: errorMessageFrom(error, "Unable to update tool policy."),
      });
    } finally {
      setUpdatingKey((current) => (current === key ? null : current));
    }
  };

  const handleCreate = async () => {
    const errors: CreateErrors = {};
    const serviceId = createServiceId.trim();
    const toolId = createToolId.trim();
    if (serviceId.length === 0) errors.serviceId = "Service ID is required.";
    if (toolId.length === 0) errors.toolId = "Tool ID is required.";
    if (decisionSchema.safeParse(createDecision).success === false) {
      errors.decision = "Decision must be allow, block, or ask.";
    }
    setCreateErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setIsCreating(true);
    try {
      await apiFetch(
        buildUrl(
          `/tools/${encodeURIComponent(serviceId)}/${encodeURIComponent(toolId)}/policy`,
        ),
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision: createDecision }),
        },
      );
      setCreateServiceId("");
      setCreateToolId("");
      setCreateDecision("allow");
      setCreateErrors({});
      setIsCreateOpen(false);
      await refreshTools();
      addNotification({
        type: "success",
        title: `Tool policy set to ${createDecision}`,
        message: POLICY_CONSEQUENCES[createDecision],
      });
    } catch (error) {
      const message = errorMessageFrom(error, "Unable to create tool policy.");
      setCreateErrors({ form: message });
      addNotification({
        type: "error",
        title: "Tool policy creation failed",
        message,
      });
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <section className="flex h-svh flex-col px-6 pb-6">
      <header className="sticky top-0 z-10 -mx-6 mb-6 flex flex-col gap-4 border-b bg-background px-6 py-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-xl font-semibold">Tool Permissions</h1>
            <p className="text-muted-foreground text-sm">
              Manage per-tool allow, ask, and block policies. Tools without a
              saved policy default to ask.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Popover
              open={isCreateOpen}
              onOpenChange={(open) => {
                setIsCreateOpen(open);
                if (!open) setCreateErrors({});
              }}
            >
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  className="gap-2"
                  onClick={() => {
                    setCreateErrors({});
                  }}
                >
                  <Plus />
                  New policy
                </Button>
              </PopoverTrigger>

              <PopoverContent align="end" className="w-[26rem]">
                <div className="space-y-4">
                  <div className="space-y-1">
                    <h3 className="text-sm font-medium">New tool policy</h3>
                    <p className="text-muted-foreground text-xs">
                      Set the permission policy for a service tool. Saving
                      overwrites any existing policy for that tool.
                    </p>
                  </div>

                  <div className="space-y-3">
                    <div className="space-y-2">
                      <Label htmlFor="tool-policy-service-id">Service ID</Label>
                      <Input
                        id="tool-policy-service-id"
                        value={createServiceId}
                        onChange={(e) => setCreateServiceId(e.target.value)}
                        placeholder="myService"
                      />
                      {createErrors.serviceId ? (
                        <p className="text-xs text-destructive">
                          {createErrors.serviceId}
                        </p>
                      ) : null}
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="tool-policy-tool-id">Tool ID</Label>
                      <Input
                        id="tool-policy-tool-id"
                        value={createToolId}
                        onChange={(e) => setCreateToolId(e.target.value)}
                        placeholder="myTool"
                      />
                      {createErrors.toolId ? (
                        <p className="text-xs text-destructive">
                          {createErrors.toolId}
                        </p>
                      ) : null}
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="tool-policy-decision">Decision</Label>
                      <Select
                        value={createDecision}
                        onValueChange={(value) =>
                          setCreateDecision(value as Decision)
                        }
                      >
                        <SelectTrigger
                          id="tool-policy-decision"
                          className="w-full"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="allow">allow</SelectItem>
                          <SelectItem value="ask">ask</SelectItem>
                          <SelectItem value="block">block</SelectItem>
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">
                        {POLICY_CONSEQUENCES[createDecision]}
                      </p>
                      {createErrors.decision ? (
                        <p className="text-xs text-destructive">
                          {createErrors.decision}
                        </p>
                      ) : null}
                    </div>
                    {createErrors.form ? (
                      <p className="text-sm text-destructive">
                        {createErrors.form}
                      </p>
                    ) : null}
                  </div>

                  <div className="flex items-center justify-end gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setIsCreateOpen(false)}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      disabled={isCreating}
                      onClick={() => void handleCreate()}
                    >
                      {isCreating ? "Saving…" : "Save policy"}
                    </Button>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Input
            placeholder="Service ID"
            value={serviceFilter}
            onChange={(e) =>
              updateSearchParams({
                serviceId: e.target.value.trim() || undefined,
              })
            }
            className="min-w-40 flex-1"
          />
          <Input
            placeholder="Search tools"
            value={queryFilter}
            onChange={(e) =>
              updateSearchParams({ q: e.target.value || undefined })
            }
            className="min-w-40 flex-1"
          />
          <Select
            onValueChange={(value) =>
              updateSearchParams({
                decision: value === "all" ? undefined : value,
              })
            }
            value={decisionFilter}
          >
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="Decision" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All decisions</SelectItem>
              <SelectItem value="allow">Allow</SelectItem>
              <SelectItem value="ask">Ask</SelectItem>
              <SelectItem value="block">Block</SelectItem>
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="outline"
            className="gap-2"
            onClick={() => {
              refreshTools()
                .then(() => {
                  addNotification({
                    type: "success",
                    title: "Tool permissions refreshed",
                    message: "Tool permissions refreshed.",
                  });
                })
                .catch((error) => {
                  addNotification({
                    type: "error",
                    title: "Refresh tool permissions failed",
                    message: errorMessageFrom(
                      error,
                      "Failed to refresh tool permissions.",
                    ),
                  });
                });
            }}
            aria-label="Refresh tool permissions"
          >
            <RotateCcw />
          </Button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto [&_[data-slot='table-container']]:overflow-visible">
        {isLoadingTools && toolList === undefined ? (
          <div className="flex items-center justify-center h-full py-12">
            <p className="text-sm text-muted-foreground">
              Loading tool permissions…
            </p>
          </div>
        ) : toolsError ? (
          <p className="p-4 text-sm text-destructive">
            Failed to load tool permissions.
          </p>
        ) : tools.length === 0 ? (
          <div className="flex items-center justify-center h-full py-12">
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Shield aria-hidden />
                </EmptyMedia>
                <EmptyTitle>No tool permissions found</EmptyTitle>
                <EmptyDescription>
                  No tools match the current filters.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button
                  type="button"
                  size="sm"
                  className="gap-2"
                  onClick={() => {
                    setCreateErrors({});
                    setIsCreateOpen(true);
                  }}
                >
                  <Plus />
                  New policy
                </Button>
              </EmptyContent>
            </Empty>
          </div>
        ) : (
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow>
                <TableHead>Service / Tool</TableHead>
                <TableHead>Decision</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead className="w-40 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tools.map((tool) => {
                const key = `${tool.serviceId}:${tool.id}`;
                const decision = tool.policy?.decision ?? "ask";
                const updatedLabel = formatUpdatedAt(
                  tool.policy?.updatedAt ?? null,
                );
                return (
                  <TableRow key={key}>
                    <TableCell className="text-xs max-w-60">
                      <div title={tool.serviceId}>
                        <Link
                          to={`/services/${encodeURIComponent(tool.serviceId)}`}
                          className="font-mono underline-offset-2 hover:underline"
                        >
                          <span className="block truncate">
                            {tool.serviceId}
                          </span>
                        </Link>
                      </div>
                      <div
                        className="font-mono text-muted-foreground"
                        title={tool.id}
                      >
                        <span className="block truncate">{tool.id}</span>
                      </div>
                      {tool.name ? (
                        <div
                          className="truncate text-muted-foreground"
                          title={tool.name}
                        >
                          {tool.name}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <DecisionBadge decision={decision} />
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {updatedLabel ?? "Default"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Select
                        value={decision}
                        disabled={updatingKey === key}
                        onValueChange={(value) =>
                          void handlePolicyChange(
                            tool.serviceId,
                            tool.id,
                            value as Decision,
                          )
                        }
                      >
                        <SelectTrigger
                          className="w-32"
                          aria-label={`Policy for ${tool.serviceId} ${tool.id}`}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="allow">allow</SelectItem>
                          <SelectItem value="ask">ask</SelectItem>
                          <SelectItem value="block">block</SelectItem>
                        </SelectContent>
                      </Select>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        {nextCursor !== null ? (
          <div className="flex justify-center p-4">
            <Button
              type="button"
              variant="outline"
              className="gap-2"
              disabled={isLoadingMore}
              onClick={() => void loadMoreTools()}
            >
              <ChevronDown />
              {isLoadingMore ? "Loading more…" : "Load more"}
            </Button>
          </div>
        ) : null}
        {loadMoreError ? (
          <p className="p-4 text-sm text-destructive">{loadMoreError}</p>
        ) : null}
      </div>
    </section>
  );
}
