import { ArrowLeft, MousePointerClick } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import useSWR from "swr";
import { z } from "zod";
import { DataState } from "@/components/data-state";
import { type JSONSchema, RjsfForm } from "@/components/rjsf-form";
import { SchemaViewer } from "@/components/schema-viewer";
import { type ToolNode, ToolTree } from "@/components/tool-tree";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Label } from "@/components/ui/label";
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
import { apiFetch, apiFetchJson, buildUrl } from "@/lib/api";
import { userFacingErrorFrom } from "@/lib/errors";

const toolListItemSchema = z.object({
  serviceId: z.string(),
  id: z.string(),
  name: z.string().catch(""),
  summary: z.string().catch(""),
  description: z.string().catch(""),
  enabled: z.boolean().optional(),
  effectivelyEnabled: z.boolean(),
  policy: z
    .object({
      decision: z.enum(["allow", "block", "ask"]),
      updatedAt: z.number().nullable(),
    })
    .optional(),
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
  policy: z
    .object({
      decision: z.enum(["allow", "block", "ask"]),
      updatedAt: z.number().nullable(),
    })
    .optional(),
});

type PolicyDecision = "allow" | "block" | "ask";

const POLICY_CONSEQUENCES: Record<PolicyDecision, string> = {
  allow: "Invocation proceeds automatically.",
  ask: "Invocation requires approval. Direct invocations report approval-required; run through a process for suspend/resume.",
  block: "Invocation is rejected.",
};

type ToolListItem = z.infer<typeof toolListItemSchema>;

function buildToolNodes(tools: ToolListItem[]): ToolNode[] {
  return tools.map((tool) => ({
    id: tool.id,
    label: tool.name || tool.id,
  }));
}

export function ServiceToolWorkbench({ serviceId }: { serviceId: string }) {
  const { addNotification } = useNotification();

  const [selectedToolId, setSelectedToolId] = useState<string | null>(null);

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

  const handlePolicyChange = async (decision: PolicyDecision) => {
    if (!selectedToolId) return;
    try {
      await apiFetch(
        buildUrl(
          `/tools/${encodeURIComponent(serviceId)}/${encodeURIComponent(selectedToolId)}/policy`,
        ),
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision }),
        },
      );
      await mutateTools();
      if (detailUrl) await mutateDetail();
      addNotification({
        type: "success",
        title: `Tool policy set to ${decision}`,
        message: POLICY_CONSEQUENCES[decision],
      });
    } catch (error) {
      const friendly = userFacingErrorFrom(
        error,
        "Unable to update tool policy.",
      );
      addNotification({
        type: "error",
        title: friendly.title,
        message: friendly.description,
      });
    }
  };

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
        <p className="font-mono">
          {serviceId}.{toolDetail.id}
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor={`tool-policy-${serviceId}`}>Permission Policy</Label>
          <Select
            value={toolDetail.policy?.decision ?? "ask"}
            onValueChange={(value) =>
              void handlePolicyChange(value as PolicyDecision)
            }
          >
            <SelectTrigger id={`tool-policy-${serviceId}`} className="w-36">
              <SelectValue />
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
