import { Check, ChevronDown, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import useSWR, { useSWRConfig } from "swr";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
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

const approvalStateSchema = z.enum([
  "pending",
  "approved",
  "denied",
  "expired",
]);

const approvalSchema = z.object({
  id: z.string(),
  serviceId: z.string(),
  toolId: z.string(),
  processId: z.number().nullable(),
  parameters: z.unknown(),
  state: approvalStateSchema,
  createdAt: z.string(),
  expiresAt: z.number(),
  decidedAt: z.number().nullable(),
});

const approvalListSchema = z.object({
  items: z.array(approvalSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});

type Approval = z.infer<typeof approvalSchema>;
type ApprovalState = z.infer<typeof approvalStateSchema>;

const stateBadgeVariant = (state: ApprovalState) => {
  if (state === "pending") return "secondary" as const;
  if (state === "approved") return "default" as const;
  if (state === "denied") return "destructive" as const;
  return "outline" as const;
};

const formatTime = (value: string | number) => {
  const d = typeof value === "number" ? new Date(value) : new Date(value);
  return d.toLocaleString();
};

const parseStateFilter = (raw: string | null): ApprovalState | "all" => {
  if (raw === "all") return "all";
  if (raw !== null && approvalStateSchema.safeParse(raw).success) {
    return raw as ApprovalState;
  }
  return "pending";
};

const parsePage = (raw: string | null): number => {
  if (raw === null) return 1;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
};

export default function ApprovalsPage() {
  const { mutate } = useSWRConfig();
  const { addNotification } = useNotification();
  const [searchParams] = useSearchParams();
  const updateSearchParams = useUpdateSearchParams();

  const stateFilter = parseStateFilter(searchParams.get("state"));
  const serviceFilter = searchParams.get("serviceId") ?? "";
  const toolFilter = searchParams.get("toolId") ?? "";
  const processFilter = searchParams.get("processId") ?? "";
  const page = parsePage(searchParams.get("page"));
  const selectedApprovalId = searchParams.get("approval");

  const parsedFilters = useMemo(() => {
    const out: Record<string, string | undefined> = {};
    if (stateFilter !== "all") out.state = stateFilter;
    if (serviceFilter.trim()) out.serviceId = serviceFilter.trim();
    if (toolFilter.trim()) out.toolId = toolFilter.trim();
    if (processFilter.trim()) out.processId = processFilter.trim();
    return out;
  }, [stateFilter, serviceFilter, toolFilter, processFilter]);

  const approvalsUrl = useMemo(() => {
    return buildUrl("/approvals", {
      ...parsedFilters,
      limit: "100",
    });
  }, [parsedFilters]);

  const {
    data: approvalList,
    error: approvalsError,
    isValidating: isApprovalsValidating,
  } = useSWR(approvalsUrl, (url) => apiFetchJson(url, approvalListSchema), {
    refreshInterval: 8000,
  });

  const [extraApprovals, setExtraApprovals] = useState<Approval[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [loadedChunks, setLoadedChunks] = useState(1);
  const paginationVersionRef = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: approvalsUrl triggers pagination reset
  useEffect(() => {
    paginationVersionRef.current += 1;
    setExtraApprovals([]);
    setNextCursor(null);
    setLoadMoreError(null);
    setLoadedChunks(1);
  }, [approvalsUrl]);

  useEffect(() => {
    if (
      extraApprovals.length === 0 &&
      approvalList !== undefined &&
      !isApprovalsValidating
    ) {
      setNextCursor(approvalList.nextCursor);
    }
  }, [approvalList, extraApprovals.length, isApprovalsValidating]);

  const approvals = useMemo(() => {
    const seen = new Set<string>();
    const merged: Approval[] = [];
    for (const a of [...(approvalList?.items ?? []), ...extraApprovals]) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      merged.push(a);
    }
    return merged;
  }, [approvalList, extraApprovals]);

  const refreshApprovals = async () => {
    paginationVersionRef.current += 1;
    setExtraApprovals([]);
    setNextCursor(null);
    setLoadMoreError(null);
    setLoadedChunks(1);
    await mutate(approvalsUrl);
  };

  const loadMore = useCallback(async () => {
    if (nextCursor === null || isLoadingMore) return;
    const startedVersion = paginationVersionRef.current;
    setIsLoadingMore(true);
    setLoadMoreError(null);
    try {
      const data = await apiFetchJson(
        buildUrl("/approvals", {
          ...parsedFilters,
          limit: "100",
          cursor: nextCursor,
        }),
        approvalListSchema,
      );
      if (paginationVersionRef.current !== startedVersion) return;
      setExtraApprovals((prev) => [...prev, ...data.items]);
      setNextCursor(data.nextCursor);
      setLoadedChunks((prev) => prev + 1);
    } catch (error) {
      if (paginationVersionRef.current !== startedVersion) return;
      setLoadMoreError(
        errorMessageFrom(error, "Failed to load more approvals."),
      );
    } finally {
      setIsLoadingMore(false);
    }
  }, [nextCursor, isLoadingMore, parsedFilters]);

  useEffect(() => {
    if (loadedChunks >= page) return;
    if (isLoadingMore || nextCursor === null) return;
    void loadMore();
  }, [loadedChunks, page, isLoadingMore, nextCursor, loadMore]);

  const selectedApproval = useMemo(
    () => approvals.find((a) => a.id === selectedApprovalId) ?? null,
    [approvals, selectedApprovalId],
  );

  const handleDecision = async (id: string, action: "approve" | "deny") => {
    try {
      await apiFetch(
        buildUrl(`/approvals/${encodeURIComponent(id)}/${action}`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      await refreshApprovals();
      addNotification({
        type: "success",
        title: "Success",
        message: `Approval ${action}d.`,
      });
    } catch (error) {
      addNotification({
        type: "error",
        title: "Error",
        message: errorMessageFrom(error, `Unable to ${action} approval.`),
      });
    }
  };

  return (
    <>
      <section className="flex h-svh flex-col px-6 pb-6">
        <header className="sticky top-0 z-10 -mx-6 flex flex-col gap-4 border-b bg-background px-6 py-4 mb-6">
          <div className="space-y-1">
            <h1 className="text-xl font-semibold">Approvals</h1>
            <p className="text-muted-foreground text-sm">
              Review and decide pending tool invocations gated by policy
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Input
              placeholder="Service ID"
              value={serviceFilter}
              onChange={(e) =>
                updateSearchParams({
                  serviceId: e.target.value.trim() || undefined,
                  page: undefined,
                })
              }
              className="min-w-40 flex-1"
            />
            <Input
              placeholder="Tool ID"
              value={toolFilter}
              onChange={(e) =>
                updateSearchParams({
                  toolId: e.target.value.trim() || undefined,
                  page: undefined,
                })
              }
              className="min-w-40 flex-1"
            />
            <Input
              placeholder="Process ID"
              value={processFilter}
              onChange={(e) =>
                updateSearchParams({
                  processId: e.target.value.trim() || undefined,
                  page: undefined,
                })
              }
              className="min-w-40 flex-1"
            />
            <Select
              onValueChange={(value) =>
                updateSearchParams({
                  state: value === "all" ? "all" : value,
                  page: undefined,
                })
              }
              value={stateFilter}
            >
              <SelectTrigger className="w-[160px]">
                <SelectValue placeholder="State" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All states</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="approved">Approved</SelectItem>
                <SelectItem value="denied">Denied</SelectItem>
                <SelectItem value="expired">Expired</SelectItem>
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="outline"
              className="gap-2"
              onClick={() => void refreshApprovals()}
            >
              <RotateCcw />
            </Button>
          </div>
        </header>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto [&_[data-slot='table-container']]:overflow-visible">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead>Service / Tool</TableHead>
                <TableHead>Process</TableHead>
                <TableHead>State</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {approvals.map((a) => (
                <TableRow
                  key={a.id}
                  className="cursor-pointer"
                  tabIndex={0}
                  onClick={() => updateSearchParams({ approval: a.id })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      updateSearchParams({ approval: a.id });
                    }
                  }}
                >
                  <TableCell
                    className="font-mono text-xs max-w-14 truncate"
                    title={a.id}
                  >
                    {a.id.slice(0, 12)}
                  </TableCell>
                  <TableCell className="text-xs max-w-30">
                    <div className="" title={a.serviceId}>
                      <span className="block truncate">{a.serviceId}</span>
                    </div>
                    <div className="text-muted-foreground" title={a.toolId}>
                      <span className="block truncate">{a.toolId}</span>
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {a.processId ?? "-"}
                  </TableCell>
                  <TableCell>
                    <Badge variant={stateBadgeVariant(a.state)}>
                      {a.state}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 gap-1"
                        disabled={a.state !== "pending"}
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleDecision(a.id, "approve");
                        }}
                      >
                        <Check />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 gap-1 text-destructive"
                        disabled={a.state !== "pending"}
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleDecision(a.id, "deny");
                        }}
                      >
                        <X />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {approvalsError ? (
            <p className="p-4 text-sm text-destructive">
              Failed to load approvals.
            </p>
          ) : null}
          {nextCursor !== null ? (
            <div className="flex justify-center p-4">
              <Button
                type="button"
                variant="outline"
                className="gap-2"
                disabled={isLoadingMore}
                onClick={() => updateSearchParams({ page: String(page + 1) })}
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

      <Sheet
        open={selectedApprovalId !== null}
        onOpenChange={(open) => {
          if (!open) updateSearchParams({ approval: undefined });
        }}
      >
        <SheetContent
          side="right"
          className="data-[side=right]:w-full data-[side=right]:sm:max-w-xl"
        >
          <SheetHeader>
            <SheetTitle className="font-mono text-sm">
              {selectedApproval?.id}
            </SheetTitle>
            <SheetDescription>
              Review and decide this tool invocation.
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
            <div className="space-y-3">
              <div className="text-xs text-muted-foreground">
                <div>
                  Service:{" "}
                  <span className="font-mono">
                    {selectedApproval?.serviceId}
                  </span>{" "}
                  · Tool:{" "}
                  <span className="font-mono">{selectedApproval?.toolId}</span>{" "}
                  · Process:{" "}
                  {selectedApproval?.processId ? (
                    <a
                      href={`/processes?processId=${selectedApproval.processId}`}
                      className="font-mono underline hover:no-underline"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {selectedApproval.processId}
                    </a>
                  ) : (
                    "-"
                  )}
                </div>
                <div>
                  State: {selectedApproval?.state} · Created:{" "}
                  {selectedApproval
                    ? formatTime(selectedApproval.createdAt)
                    : ""}{" "}
                  · Expires:{" "}
                  {selectedApproval
                    ? formatTime(selectedApproval.expiresAt)
                    : ""}{" "}
                  {selectedApproval?.decidedAt
                    ? `· Decided: ${formatTime(selectedApproval.decidedAt)}`
                    : ""}
                </div>
              </div>
              <div className="rounded border bg-muted/30 overflow-hidden">
                <div className="p-2 text-xs font-semibold">Parameters</div>
                <div className="max-h-[40vh] overflow-auto p-4">
                  <pre className="whitespace-pre text-xs font-mono">
                    {selectedApproval
                      ? JSON.stringify(selectedApproval.parameters, null, 2)
                      : ""}
                  </pre>
                </div>
              </div>
            </div>
          </div>
          {selectedApproval?.state === "pending" ? (
            <SheetFooter className="border-t">
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="flex-1"
                  onClick={() =>
                    void handleDecision(selectedApproval.id, "deny")
                  }
                >
                  <X /> Deny
                </Button>
                <Button
                  type="button"
                  className="flex-1"
                  onClick={() =>
                    void handleDecision(selectedApproval.id, "approve")
                  }
                >
                  <Check /> Approve
                </Button>
              </div>
            </SheetFooter>
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  );
}
