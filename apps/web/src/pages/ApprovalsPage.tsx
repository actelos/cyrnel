import {
  Check,
  ChevronDown,
  Copy,
  RotateCcw,
  ShieldCheck,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import useSWR, { useSWRConfig } from "swr";
import { z } from "zod";
import { DetailView } from "@/components/detail-view";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
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
import { cn } from "@/lib/utils";

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

const STATE_CONFIG: Record<
  ApprovalState,
  {
    label: string;
    badgeClassName: string;
  }
> = {
  pending: {
    label: "Pending",
    badgeClassName: "bg-info text-info-foreground",
  },
  approved: {
    label: "Approved",
    badgeClassName: "bg-success text-success-foreground",
  },
  denied: {
    label: "Denied",
    badgeClassName: "bg-error text-error-foreground",
  },
  expired: {
    label: "Expired",
    badgeClassName: "bg-destructive text-destructive-foreground",
  },
};

function StatusBadge({ state }: { state: ApprovalState }) {
  const { label, badgeClassName } = STATE_CONFIG[state];
  return <Badge className={badgeClassName}>{label}</Badge>;
}

const formatTime = (value: string | number) => {
  const d = typeof value === "number" ? new Date(value) : new Date(value);
  return d.toLocaleString();
};

const RELATIVE_TIME_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 1000 * 60 * 60 * 24 * 365],
  ["month", 1000 * 60 * 60 * 24 * 30],
  ["day", 1000 * 60 * 60 * 24],
  ["hour", 1000 * 60 * 60],
  ["minute", 1000 * 60],
];

const relativeTimeFormatter = new Intl.RelativeTimeFormat("en", {
  numeric: "auto",
});

const formatRelativeTime = (value: string | number, now: number) => {
  const target = typeof value === "number" ? value : new Date(value).getTime();
  const diffMs = target - now;
  for (const [unit, unitMs] of RELATIVE_TIME_UNITS) {
    if (Math.abs(diffMs) >= unitMs) {
      return relativeTimeFormatter.format(Math.round(diffMs / unitMs), unit);
    }
  }
  return relativeTimeFormatter.format(Math.round(diffMs / 1000), "second");
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

const EXPIRING_SOON_MS = 5 * 60 * 1000;

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
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isBulkWorking, setIsBulkWorking] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: approvalsUrl triggers pagination reset
  useEffect(() => {
    paginationVersionRef.current += 1;
    setExtraApprovals([]);
    setNextCursor(null);
    setLoadMoreError(null);
    setLoadedChunks(1);
    setSelectedIds(new Set());
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
      const message = errorMessageFrom(error, "Failed to load more approvals.");
      setLoadMoreError(message);
      addNotification({
        type: "error",
        title: "Load more failed",
        message,
      });
    } finally {
      setIsLoadingMore(false);
    }
  }, [nextCursor, isLoadingMore, parsedFilters, addNotification]);

  useEffect(() => {
    if (loadedChunks >= page) return;
    if (isLoadingMore || nextCursor === null) return;
    void loadMore();
  }, [loadedChunks, page, isLoadingMore, nextCursor, loadMore]);

  const selectedApproval = useMemo(
    () => approvals.find((a) => a.id === selectedApprovalId) ?? null,
    [approvals, selectedApprovalId],
  );

  const [displayedApproval, setDisplayedApproval] = useState<Approval | null>(
    null,
  );
  useEffect(() => {
    if (selectedApproval) setDisplayedApproval(selectedApproval);
  }, [selectedApproval]);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (selectedApprovalId === null) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(interval);
  }, [selectedApprovalId]);

  const isExpiringSoon =
    displayedApproval?.state === "pending" &&
    displayedApproval.expiresAt - now < EXPIRING_SOON_MS;

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

      const nextState: ApprovalState =
        action === "approve" ? "approved" : "denied";

      const decidedAt = Date.now();

      setDisplayedApproval((current) =>
        current?.id === id
          ? {
              ...current,
              state: nextState,
              decidedAt,
            }
          : current,
      );

      setSelectedIds((previous) => {
        if (!previous.has(id)) return previous;
        const next = new Set(previous);
        next.delete(id);
        return next;
      });

      await refreshApprovals();

      addNotification({
        type: "success",
        title: `Approval ${action}d`,
        message: `Approval ${action}d.`,
      });
    } catch (error) {
      addNotification({
        type: "error",
        title: "Approval decision failed",
        message: errorMessageFrom(error, `Unable to ${action} approval.`),
      });
    }
  };

  const toggleSelectApproval = (id: string, checked: boolean) => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  };

  const toggleSelectAll = (checked: boolean) => {
    setSelectedIds(() =>
      checked ? new Set(approvals.map((a) => a.id)) : new Set(),
    );
  };

  const selectedApprovals = useMemo(
    () => approvals.filter((a) => selectedIds.has(a.id)),
    [approvals, selectedIds],
  );

  const pendingSelected = useMemo(
    () => selectedApprovals.filter((a) => a.state === "pending"),
    [selectedApprovals],
  );

  const allSelected =
    approvals.length > 0 && selectedIds.size >= approvals.length;
  const someSelected =
    selectedIds.size > 0 && selectedIds.size < approvals.length;

  const handleBulkDecision = async (action: "approve" | "deny") => {
    if (pendingSelected.length === 0 || isBulkWorking) return;
    setIsBulkWorking(true);
    const targets = [...pendingSelected];
    try {
      const results = await Promise.allSettled(
        targets.map((a) =>
          apiFetch(
            buildUrl(`/approvals/${encodeURIComponent(a.id)}/${action}`),
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({}),
            },
          ),
        ),
      );
      const succeededIds: string[] = [];
      let failed = 0;
      results.forEach((result, index) => {
        if (result.status === "fulfilled") {
          succeededIds.push(targets[index].id);
        } else {
          failed += 1;
        }
      });

      if (succeededIds.length > 0) {
        const succeededSet = new Set(succeededIds);
        setDisplayedApproval((current) =>
          current && succeededSet.has(current.id)
            ? {
                ...current,
                state: action === "approve" ? "approved" : "denied",
                decidedAt: Date.now(),
              }
            : current,
        );
      }

      setSelectedIds((previous) => {
        if (previous.size === 0) return previous;
        const next = new Set(previous);
        for (const id of succeededIds) next.delete(id);
        return next;
      });

      await refreshApprovals();

      if (failed === 0) {
        addNotification({
          type: "success",
          title:
            action === "approve" ? "Approvals approved" : "Approvals denied",
          message:
            succeededIds.length === 1
              ? `1 approval ${action}d.`
              : `${succeededIds.length} approvals ${action}d.`,
        });
      } else {
        addNotification({
          type: succeededIds.length > 0 ? "success" : "error",
          title: "Bulk decision incomplete",
          message: `${succeededIds.length} ${action}d, ${failed} failed. Non-pending approvals were skipped.`,
        });
      }
    } catch (error) {
      addNotification({
        type: "error",
        title: "Bulk decision failed",
        message: errorMessageFrom(error, `Unable to ${action} approvals.`),
      });
    } finally {
      setIsBulkWorking(false);
    }
  };

  const handleCopy = useCallback(
    async (value: string, label: string) => {
      try {
        await navigator.clipboard.writeText(value);
        addNotification({
          type: "success",
          title: "Copied",
          message: `${label} copied to clipboard.`,
        });
      } catch (error) {
        addNotification({
          type: "error",
          title: "Copy failed",
          message: errorMessageFrom(
            error,
            `Unable to copy ${label.toLowerCase()}.`,
          ),
        });
      }
    },
    [addNotification],
  );

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
              onClick={() => {
                refreshApprovals()
                  .then(() => {
                    addNotification({
                      type: "success",
                      title: "Approvals refreshed",
                      message: "Approvals refreshed.",
                    });
                  })
                  .catch((error) => {
                    addNotification({
                      type: "error",
                      title: "Refresh approvals failed",
                      message: errorMessageFrom(
                        error,
                        "Failed to refresh approvals.",
                      ),
                    });
                  });
              }}
              aria-label="Refresh approvals"
            >
              <RotateCcw />
            </Button>
          </div>
        </header>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto [&_[data-slot='table-container']]:overflow-visible">
          {selectedIds.size > 0 ? (
            <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b bg-background px-1 py-2">
              <span className="text-sm text-muted-foreground">
                {selectedIds.size === 1
                  ? "1 selected"
                  : `${selectedIds.size} selected`}
                {selectedApprovals.length !== selectedIds.size
                  ? ` (${selectedApprovals.length} visible)`
                  : null}
              </span>

              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  className="gap-2"
                  disabled={pendingSelected.length === 0 || isBulkWorking}
                  onClick={() => void handleBulkDecision("approve")}
                  title={
                    pendingSelected.length === 0
                      ? "No selected approvals can be approved (only pending)"
                      : "Approve selected approvals"
                  }
                >
                  <Check />
                  Approve
                  {pendingSelected.length > 0
                    ? ` (${pendingSelected.length})`
                    : null}
                </Button>

                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-2 text-destructive hover:text-destructive"
                  disabled={pendingSelected.length === 0 || isBulkWorking}
                  onClick={() => void handleBulkDecision("deny")}
                  title={
                    pendingSelected.length === 0
                      ? "No selected approvals can be denied (only pending)"
                      : "Deny selected approvals"
                  }
                >
                  <X />
                  Deny
                </Button>

                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-2"
                  disabled={isBulkWorking}
                  onClick={() => setSelectedIds(new Set())}
                >
                  <X />
                  Clear
                </Button>
              </div>
            </div>
          ) : null}
          {approvalList === undefined ? (
            <div className="flex items-center justify-center h-full py-12">
              <p className="text-sm text-muted-foreground">
                Loading approvals…
              </p>
            </div>
          ) : approvalsError ? (
            <p className="p-4 text-sm text-destructive">
              Failed to load approvals.
            </p>
          ) : approvals.length === 0 ? (
            <div className="flex items-center justify-center h-full py-12">
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <ShieldCheck aria-hidden />
                  </EmptyMedia>
                  <EmptyTitle>No approvals found</EmptyTitle>
                  <EmptyDescription>
                    No approvals match the current filters. Tool invocations
                    with an ask policy will appear here.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            </div>
          ) : (
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-background">
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      aria-label="Select all approvals"
                      checked={
                        allSelected
                          ? true
                          : someSelected
                            ? "indeterminate"
                            : false
                      }
                      onCheckedChange={(checked) =>
                        toggleSelectAll(checked === true)
                      }
                      onClick={(event) => event.stopPropagation()}
                    />
                  </TableHead>
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
                    className={cn(
                      "cursor-pointer",
                      selectedIds.has(a.id) ? "bg-primary/10" : "",
                    )}
                    tabIndex={0}
                    onClick={() => updateSearchParams({ approval: a.id })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        updateSearchParams({ approval: a.id });
                      }
                    }}
                  >
                    <TableCell onClick={(event) => event.stopPropagation()}>
                      <Checkbox
                        aria-label={`Select approval ${a.id}`}
                        checked={selectedIds.has(a.id)}
                        onCheckedChange={(checked) =>
                          toggleSelectApproval(a.id, checked === true)
                        }
                      />
                    </TableCell>
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
                      <StatusBadge state={a.state} />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          type="button"
                          variant="ghost"
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
          )}
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
          className="flex flex-col gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-lg"
        >
          <SheetHeader className="gap-3 border-b px-4 py-4">
            <div className="flex items-start gap-3">
              <div className="min-w-0 max-w-60 space-y-0.5">
                <SheetTitle className="truncate text-base">
                  {displayedApproval?.toolId}
                </SheetTitle>
                <p className="truncate text-sm text-muted-foreground">
                  {displayedApproval?.serviceId}
                </p>
              </div>
              {displayedApproval ? (
                <StatusBadge state={displayedApproval.state} />
              ) : null}
            </div>

            {displayedApproval ? (
              <SheetDescription asChild>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                  <span title={formatTime(displayedApproval.createdAt)}>
                    Requested{" "}
                    {formatRelativeTime(displayedApproval.createdAt, now)}
                  </span>
                  {displayedApproval.state === "pending" ? (
                    <span
                      title={formatTime(displayedApproval.expiresAt)}
                      className={
                        isExpiringSoon
                          ? "font-medium text-destructive"
                          : undefined
                      }
                    >
                      Expires{" "}
                      {formatRelativeTime(displayedApproval.expiresAt, now)}
                    </span>
                  ) : null}
                  {displayedApproval.decidedAt ? (
                    <span title={formatTime(displayedApproval.decidedAt)}>
                      Decided{" "}
                      {formatRelativeTime(displayedApproval.decidedAt, now)}
                    </span>
                  ) : null}
                </div>
              </SheetDescription>
            ) : null}

            {displayedApproval ? (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <button
                  type="button"
                  className="inline-flex items-center gap-1 font-mono hover:text-foreground"
                  title={displayedApproval.id}
                  onClick={() =>
                    void handleCopy(displayedApproval.id, "Approval ID")
                  }
                >
                  {displayedApproval.id.slice(0, 18)}
                  <Copy className="size-3" />
                </button>
                {displayedApproval.processId ? (
                  <Link
                    to={`/processes?process=${displayedApproval.processId}`}
                    className="font-mono underline-offset-2 hover:underline"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Process #{displayedApproval.processId}
                  </Link>
                ) : null}
              </div>
            ) : null}
          </SheetHeader>

          <div className="flex min-h-0 flex-1 flex-col px-4 py-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium">Parameters</span>
            </div>
            <DetailView
              title="Parameters"
              content={
                displayedApproval
                  ? JSON.stringify(displayedApproval.parameters, null, 2)
                  : ""
              }
              variant="code"
              language="json"
              boxClassName="flex-1 min-h-0"
            />
          </div>

          {displayedApproval?.state === "pending" ? (
            <SheetFooter className="gap-2 border-t px-4 py-4 sm:flex-row">
              <Button
                type="button"
                variant="outline"
                className="flex-1"
                onClick={() =>
                  void handleDecision(displayedApproval.id, "deny")
                }
              >
                <X /> Deny
              </Button>
              <Button
                type="button"
                className="flex-1"
                onClick={() =>
                  void handleDecision(displayedApproval.id, "approve")
                }
              >
                <Check /> Approve
              </Button>
            </SheetFooter>
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  );
}
