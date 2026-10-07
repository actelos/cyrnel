import { ArrowLeft, Copy, MousePointerClick } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Link } from "react-router";
import remarkGfm from "remark-gfm";
import useSWR from "swr";
import { z } from "zod";
import { DataState } from "@/components/data-state";
import { type JSONSchema, RjsfForm } from "@/components/rjsf-form";
import { SchemaViewer } from "@/components/schema-viewer";
import { type ToolNode, ToolTree } from "@/components/tool-tree";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { useNotification } from "@/hooks/use-notification";
import { apiFetch, apiFetchJson, buildUrl, errorMessageFrom } from "@/lib/api";

const policySourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("rule"),
    ruleId: z.string(),
    servicePattern: z.string(),
    toolPattern: z.string(),
    position: z.number(),
  }),
  z.object({ type: z.literal("default") }),
]);

const policySchema = z.object({
  decision: z.enum(["allow", "block", "ask"]),
  updatedAt: z.number().nullable(),
  source: policySourceSchema,
});

const toolListItemSchema = z.object({
  serviceId: z.string(),
  id: z.string(),
  name: z.string().catch(""),
  summary: z.string().catch(""),
  description: z.string().catch(""),
  enabled: z.boolean().optional(),
  effectivelyEnabled: z.boolean(),
  policy: policySchema.optional(),
});

const toolListSchema = z.object({
  items: z.array(toolListItemSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});

const toolDetailSchema = z.object({
  id: z.string(),
  name: z.string(),
  summary: z.string().optional().default(""),
  description: z.string(),
  enabled: z.boolean().optional(),
  effectivelyEnabled: z.boolean(),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()),
  security: z.unknown().optional(),
  policy: policySchema.optional(),
});

type ToolListItem = z.infer<typeof toolListItemSchema>;

const decisionSchema = z.enum(["allow", "block", "ask"]);

type Decision = z.infer<typeof decisionSchema>;

const ruleListItemSchema = z.object({
  id: z.string(),
  servicePattern: z.string(),
  toolPattern: z.string(),
  decision: decisionSchema,
  position: z.number(),
});

const ruleListSchema = z.array(ruleListItemSchema);

function buildToolNodes(tools: ToolListItem[]): ToolNode[] {
  return tools.map((tool) => ({
    id: tool.id,
    label: tool.name || tool.id,
  }));
}

export function ServiceToolWorkbench({ serviceId }: { serviceId: string }) {
  const { addNotification } = useNotification();
  const [selectedToolId, setSelectedToolId] = useState<string | null>(null);
  const [isSavingOverride, setIsSavingOverride] = useState(false);

  const toolsUrl = useMemo(
    () => buildUrl("/tools", { serviceId, limit: "100" }),
    [serviceId],
  );

  const {
    data: toolList,
    error: toolsError,
    isLoading: isLoadingTools,
    mutate: mutateTools,
  } = useSWR(toolsUrl, (url) => apiFetchJson(url, toolListSchema), {
    refreshInterval: 15000,
  });

  const tools = useMemo(
    () =>
      (toolList?.items ?? [])
        .slice()
        .sort((a, b) =>
          (a.name ?? a.id ?? "").localeCompare(b.name ?? b.id ?? ""),
        ),
    [toolList],
  );

  const toolNodes = useMemo(() => buildToolNodes(tools), [tools]);

  const handleSelect = (toolId: string) => {
    setSelectedToolId(toolId);
  };

  const detailUrl = selectedToolId
    ? buildUrl(
        `/tools/${encodeURIComponent(serviceId)}/${encodeURIComponent(selectedToolId)}`,
      )
    : null;

  const {
    data: toolDetail,
    error: detailError,
    isLoading: isLoadingDetail,
    mutate: mutateDetail,
  } = useSWR(detailUrl, (url) => apiFetchJson(url, toolDetailSchema));

  const rulesUrl = useMemo(() => buildUrl("/tool-policies"), []);
  const { data: rulesData, mutate: mutateRules } = useSWR(rulesUrl, (url) =>
    apiFetchJson(url, ruleListSchema),
  );

  const exactRule = useMemo(
    () =>
      selectedToolId === null
        ? undefined
        : rulesData?.find(
            (rule) =>
              rule.servicePattern === serviceId &&
              rule.toolPattern === selectedToolId,
          ),
    [rulesData, serviceId, selectedToolId],
  );

  const handleCopyReference = useCallback(async () => {
    if (!toolDetail) return;
    try {
      await navigator.clipboard.writeText(`${serviceId}.${toolDetail.id}`);
      addNotification({
        type: "success",
        title: "Copied",
        message: "Tool reference copied to clipboard.",
      });
    } catch (error) {
      addNotification({
        type: "error",
        title: "Copy failed",
        message: errorMessageFrom(error, "Unable to copy tool reference."),
      });
    }
  }, [addNotification, serviceId, toolDetail]);

  const handleQuickSetPermission = async (decision: Decision) => {
    if (!selectedToolId) return;
    if (exactRule?.decision === decision) return;
    setIsSavingOverride(true);
    try {
      if (exactRule) {
        await apiFetch(
          buildUrl(`/tool-policies/${encodeURIComponent(exactRule.id)}`),
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ decision }),
          },
        );
      } else {
        await apiFetch(buildUrl("/tool-policies"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            servicePattern: serviceId,
            toolPattern: selectedToolId,
            decision,
          }),
        });
      }
      await Promise.all([mutateTools(), mutateDetail(), mutateRules()]);
      addNotification({
        type: "success",
        title: `Tool permission set to ${decision}`,
        message: `Exact rule ${serviceId}.${selectedToolId} → ${decision}. It is evaluated last; reorder it in Permissions if a broader rule shadows it.`,
      });
    } catch (error) {
      addNotification({
        type: "error",
        title: "Update failed",
        message: errorMessageFrom(error, "Unable to update tool permission."),
      });
    } finally {
      setIsSavingOverride(false);
    }
  };

  useEffect(() => {
    setSelectedToolId(null);
    void serviceId;
  }, [serviceId]);

  const inputSchema = useMemo(
    () => (toolDetail?.inputSchema ?? {}) as JSONSchema,
    [toolDetail],
  );
  const outputSchema = useMemo(
    () => (toolDetail?.outputSchema ?? {}) as JSONSchema,
    [toolDetail],
  );

  const listState = isLoadingTools
    ? "loading"
    : toolsError
      ? "error"
      : tools.length === 0
        ? "empty"
        : "content";

  const detailContent = isLoadingDetail ? (
    <div className="space-y-2">
      <Skeleton className="h-6 w-1/2" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  ) : detailError || !toolDetail ? (
    selectedToolId ? (
      <Alert variant="destructive">
        <AlertTitle>Tool not found</AlertTitle>
        <AlertDescription>
          The selected tool could not be loaded. It may have been removed by a
          service update.
        </AlertDescription>
      </Alert>
    ) : (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MousePointerClick aria-hidden />
          </EmptyMedia>
          <EmptyTitle>Select a tool</EmptyTitle>
          <EmptyDescription>
            Choose a tool from the list to view its schemas and policy.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  ) : (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="inline-flex items-center gap-1 font-mono hover:text-foreground cursor-pointer"
            title={`${serviceId}.${toolDetail.id}`}
            onClick={() => void handleCopyReference()}
          >
            {serviceId}.{toolDetail.id}
            <Copy className="size-3" />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge
            variant={
              (toolDetail.policy?.decision ?? "ask") === "allow"
                ? "default"
                : (toolDetail.policy?.decision ?? "ask") === "block"
                  ? "destructive"
                  : "secondary"
            }
          >
            {toolDetail.policy?.decision ?? "ask"}
          </Badge>
          {toolDetail.policy?.source.type === "rule" ? (
            <span className="text-xs text-muted-foreground">
              <Link
                to="/permissions"
                className="underline underline-offset-2 hover:text-foreground"
              >
                Permission rule #{toolDetail.policy.source.position}
              </Link>
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">
              <Link
                to="/permissions"
                className="underline underline-offset-2 hover:text-foreground"
              >
                default rule
              </Link>
            </span>
          )}
          <Select
            value={exactRule?.decision ?? ""}
            disabled={isSavingOverride}
            onValueChange={(value) =>
              void handleQuickSetPermission(value as Decision)
            }
          >
            <SelectTrigger
              className="w-38"
              aria-label={`Override permission for ${serviceId}.${toolDetail.id}`}
            >
              <SelectValue placeholder="Override permission" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="allow">allow</SelectItem>
              <SelectItem value="ask">ask</SelectItem>
              <SelectItem value="block">block</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {toolDetail.description ? (
          <div className="text-sm text-muted-foreground">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{ p: ({ children }) => <p>{children}</p> }}
            >
              {toolDetail.description}
            </ReactMarkdown>
          </div>
        ) : null}
      </div>

      <Separator />

      <div className="space-y-4">
        <div className="space-y-2">
          <h3 className="text-sm font-medium">Input schema</h3>
          <div className="w-full bg-background space-y-2 p-2 overflow-auto">
            <SchemaViewer schema={inputSchema} />
            <details className="rounded-md border p-3">
              <summary className="cursor-pointer text-xs text-muted-foreground">
                Form preview (readonly)
              </summary>
              <div className="mt-2">
                <RjsfForm
                  schema={inputSchema}
                  readonly
                  autoPasswordWidgets={false}
                  idPrefix={`preview-in-${serviceId}-${selectedToolId ?? "none"}`}
                />
              </div>
            </details>
          </div>
        </div>
        <Separator />
        <div className="space-y-2">
          <h3 className="text-sm font-medium">Output schema</h3>
          <div className="w-full bg-background space-y-2 p-2 overflow-auto">
            <SchemaViewer schema={outputSchema} />
            <details className="rounded-md border p-3">
              <summary className="cursor-pointer text-xs text-muted-foreground">
                Form preview (readonly)
              </summary>
              <div className="mt-2">
                <RjsfForm
                  schema={outputSchema}
                  readonly
                  autoPasswordWidgets={false}
                  idPrefix={`preview-out-${serviceId}-${selectedToolId ?? "none"}`}
                />
              </div>
            </details>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <DataState
      state={listState}
      title="Tools"
      description={
        listState === "error"
          ? "Failed to load tools."
          : "No tools registered for this service."
      }
      onRetry={listState === "error" ? () => void mutateTools() : undefined}
    >
      <div className="flex h-full min-h-0 flex-1 flex-col">
        {selectedToolId ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="shrink-0 pb-2">
              <Button
                type="button"
                variant="link"
                className="gap-2 px-0"
                onClick={() => setSelectedToolId(null)}
              >
                <ArrowLeft />
                Back to tools
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto pr-1">
              {detailContent}
            </div>
          </div>
        ) : (
          <ToolTree
            data={toolNodes}
            selectedId={selectedToolId}
            onSelect={handleSelect}
            className="w-full"
          />
        )}
      </div>
    </DataState>
  );
}
