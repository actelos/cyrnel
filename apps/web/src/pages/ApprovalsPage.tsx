import { Check, ChevronDown, RotateCcw, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
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

export default function ApprovalsPage() {
  const { mutate } = useSWRConfig();
  const { addNotification } = useNotification();

  const [stateFilter, setStateFilter] = useState<ApprovalState | "all">(
    "pending",
  );
  const [serviceFilter, setServiceFilter] = useState("");
  const [toolFilter, setToolFilter] = useState("");
  const [processFilter, setProcessFilter] = useState("");
  const [selected, setSelected] = useState<Approval | null>(null);

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
    isLoading: isLoadingApprovals,
    isValidating: isApprovalsValidating,
  } = useSWR(approvalsUrl, (url) => apiFetchJson(url, approvalListSchema), {
    refreshInterval: 4000,
  });

  const [extraApprovals, setExtraApprovals] = useState<Approval[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const paginationVersionRef = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: approvalsUrl triggers pagination reset
  useEffect(() => {
    paginationVersionRef.current += 1;
    setExtraApprovals([]);
    setNextCursor(null);
    setLoadMoreError(null);
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
    await mutate(approvalsUrl);
  };

  const loadMore = async () => {
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
    } catch (error) {
      if (paginationVersionRef.current !== startedVersion) return;
      setLoadMoreError(
        errorMessageFrom(error, "Failed to load more approvals."),
      );
    } finally {
      setIsLoadingMore(false);
    }
  };

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
      <section className="flex min-h-0 flex-1 flex-col gap-6 p-6">
        <header className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-1">
              <h1 className="text-xl font-semibold">Approvals</h1>
              <p className="text-muted-foreground text-sm">
                Review and decide pending tool invocations gated by policy
                (allow | block | ask).
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              className="gap-2"
              onClick={() => void refreshApprovals()}
            >
              <RotateCcw />
              Refresh
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Select
              onValueChange={(v) => setStateFilter(v as ApprovalState | "all")}
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
            <Input
              placeholder="Service ID"
              value={serviceFilter}
              onChange={(e) => setServiceFilter(e.target.value)}
              className="w-[160px]"
            />
            <Input
              placeholder="Tool ID"
              value={toolFilter}
              onChange={(e) => setToolFilter(e.target.value)}
              className="w-[160px]"
            />
            <Input
              placeholder="Process ID"
              value={processFilter}
              onChange={(e) => setProcessFilter(e.target.value)}
              className="w-[120px]"
            />
          </div>
        </header>

        <Card className="flex min-h-0 flex-1 flex-col">
          <CardHeader className="flex w-full flex-row items-center justify-between">
            <CardTitle>Approval requests</CardTitle>
            <div className="w-max px-2 bg-muted border-1 border-border">
              {isLoadingApprovals
                ? "Loading..."
                : nextCursor !== null
                  ? `${approvals.length}+ total`
                  : `${approvals.length} total`}
            </div>
          </CardHeader>
          <CardContent className="min-h-0 flex-1 overflow-hidden">
            <div className="h-full overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>ID</TableHead>
                    <TableHead>Service / Tool</TableHead>
                    <TableHead>Process</TableHead>
                    <TableHead>State</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {approvals.map((a) => (
                    <TableRow
                      key={a.id}
                      className="cursor-pointer"
                      tabIndex={0}
                      onClick={() => setSelected(a)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setSelected(a);
                        }
                      }}
                    >
                      <TableCell
                        className="font-mono text-xs max-w-[12rem] truncate"
                        title={a.id}
                      >
                        {a.id.slice(0, 12)}…
                      </TableCell>
                      <TableCell className="text-xs">
                        <div className="font-mono">{a.serviceId}</div>
                        <div className="text-muted-foreground">{a.toolId}</div>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {a.processId ?? "-"}
                      </TableCell>
                      <TableCell>
                        <Badge variant={stateBadgeVariant(a.state)}>
                          {a.state}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs whitespace-nowrap">
                        {formatTime(a.createdAt)}
                      </TableCell>
                      <TableCell className="text-xs whitespace-nowrap">
                        {formatTime(a.expiresAt)}
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
                            <Check className="size-3" /> Approve
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
                            <X className="size-3" /> Deny
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
                    onClick={() => void loadMore()}
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
          </CardContent>
        </Card>
      </section>

      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <DialogContent className="max-h-[85vh] max-w-4xl space-y-4">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">
              {selected?.id}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="text-xs text-muted-foreground">
              <div>
                Service: {selected?.serviceId} · Tool: {selected?.toolId} ·
                Process:{" "}
                {selected?.processId ? (
                  <a
                    href={`/processes/${selected.processId}`}
                    className="font-mono underline hover:no-underline"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {selected.processId}
                  </a>
                ) : (
                  "-"
                )}
              </div>
              <div>
                State: {selected?.state} · Created:{" "}
                {selected ? formatTime(selected.createdAt) : ""} · Expires:{" "}
                {selected ? formatTime(selected.expiresAt) : ""}{" "}
                {selected?.decidedAt
                  ? `· Decided: ${formatTime(selected.decidedAt)}`
                  : ""}
              </div>
            </div>
            <div className="rounded border bg-muted/30 overflow-hidden">
              <div className="p-2 text-xs font-semibold">
                Parameters (decrypted)
              </div>
              <div className="max-h-[40vh] overflow-auto p-4">
                <pre className="whitespace-pre text-xs font-mono">
                  {selected ? JSON.stringify(selected.parameters, null, 2) : ""}
                </pre>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
