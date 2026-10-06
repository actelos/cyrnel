import {
  Archive,
  BookOpen,
  Braces,
  ChevronDown,
  Play,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Link, useSearchParams } from "react-router";
import remarkGfm from "remark-gfm";
import useSWR, { useSWRConfig } from "swr";
import { z } from "zod";
import { DetailView } from "@/components/detail-view";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
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
  Sheet,
  SheetContent,
  SheetDescription,
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
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useNotification } from "@/hooks/use-notification";
import { useUpdateSearchParams } from "@/hooks/use-update-search-params";
import {
  apiFetch,
  apiFetchJson,
  apiFetchText,
  buildUrl,
  errorMessageFrom,
} from "@/lib/api";
import { cn } from "@/lib/utils";

const processStateSchema = z.enum([
  "idle",
  "queued",
  "running",
  "suspended",
  "terminating",
  "terminated",
]);

const processExitStateSchema = z.union([
  z.null(),
  z.literal("failed"),
  z.literal("success"),
  z.literal("timeout"),
  z.literal("canceled"),
]);

const processSchema = z.object({
  id: z.number().int().positive(),
  pid: z.number().int().positive().nullable(),
  ref: z.string().optional(),
  state: processStateSchema,
  exitState: processExitStateSchema,
  error: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  pendingApprovalIds: z.array(z.string()).optional(),
});

const processListSchema = z.object({
  items: z.array(processSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});

const refInputSchema = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}, z.string().min(1).optional());

const timeoutInputSchema = z.preprocess(
  (value) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    if (trimmed.length === 0) return undefined;
    if (trimmed === "null") return null;
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isNaN(parsed) ? trimmed : parsed;
  },
  z.union([z.number().int().positive(), z.null(), z.undefined()]),
);

const createProcessSchema = z.object({
  code: z
    .string()
    .min(1, "Code is required.")
    .max(100 * 1024, "Code must not exceed 100 KB."),
  ref: refInputSchema,
  timeout: timeoutInputSchema,
  autorun: z.boolean().default(true),
});

const filterSchema = z.object({
  ref: refInputSchema,
  state: processStateSchema.optional(),
  status: z
    .union([
      z.literal("null"),
      z.literal("failed"),
      z.literal("success"),
      z.literal("timeout"),
      z.literal("canceled"),
    ])
    .optional(),
});

type ProcessState = z.infer<typeof processStateSchema>;
type ProcessExitState = z.infer<typeof processExitStateSchema>;
type Process = z.infer<typeof processSchema>;

type StatusFilter =
  | "all"
  | "null"
  | "success"
  | "failed"
  | "timeout"
  | "canceled";

const parseStateFilter = (raw: string | null): ProcessState | "all" => {
  if (raw !== null && processStateSchema.safeParse(raw).success) {
    return raw as ProcessState;
  }

  return "all";
};

const parseStatusFilter = (raw: string | null): StatusFilter =>
  raw !== null &&
  (raw === "null" ||
    raw === "success" ||
    raw === "failed" ||
    raw === "timeout" ||
    raw === "canceled")
    ? raw
    : "all";

const parsePage = (raw: string | null): number => {
  if (raw === null) return 1;

  const parsed = Number.parseInt(raw, 10);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
};

const parseProcessId = (raw: string | null): number | null => {
  if (raw === null) return null;

  const parsed = Number.parseInt(raw, 10);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

type CreateProcessErrors = Partial<
  Record<"code" | "ref" | "timeout" | "form", string>
>;

const exitStateBadgeClassName = (exitState: ProcessExitState) => {
  if (exitState === "failed") return "bg-error text-error-foreground";
  if (exitState === "success") return "bg-success text-success-foreground";
  if (exitState === "timeout") return "bg-warning text-warning-foreground";
  if (exitState === "canceled") return "bg-muted text-muted-foreground";
  return "";
};

export default function ProcessesPage() {
  const { mutate } = useSWRConfig();
  const [searchParams] = useSearchParams();
  const updateSearchParams = useUpdateSearchParams();

  const refFilter = searchParams.get("ref") ?? "";
  const stateFilter = parseStateFilter(searchParams.get("state"));
  const statusFilter = parseStatusFilter(searchParams.get("status"));
  const page = parsePage(searchParams.get("page"));
  const selectedProcessId = parseProcessId(searchParams.get("process"));

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [createCode, setCreateCode] = useState("");
  const [createRef, setCreateRef] = useState("");
  const [createTimeout, setCreateTimeout] = useState("");
  const [createAutorun, setCreateAutorun] = useState(true);
  const [isEnvDocsOpen, setIsEnvDocsOpen] = useState(false);
  const [createErrors, setCreateErrors] = useState<CreateProcessErrors>({});
  const { addNotification } = useNotification();
  const [isCreating, setIsCreating] = useState(false);

  const [restartCandidate, setRestartCandidate] = useState<Process | null>(
    null,
  );
  const [isRestartDialogOpen, setIsRestartDialogOpen] = useState(false);

  const [deleteCandidate, setDeleteCandidate] = useState<Process | null>(null);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);

  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [isBulkDeleteOpen, setIsBulkDeleteOpen] = useState(false);
  const [isBulkWorking, setIsBulkWorking] = useState(false);

  const parsedFilters = useMemo(() => {
    const raw = {
      ref: refFilter,
      state: stateFilter === "all" ? undefined : stateFilter,
      status: statusFilter === "all" ? undefined : statusFilter,
    };

    const parsed = filterSchema.safeParse(raw);

    if (!parsed.success) {
      return { ref: undefined, state: undefined, status: undefined };
    }

    return parsed.data;
  }, [refFilter, stateFilter, statusFilter]);

  const processesUrl = useMemo(() => {
    return buildUrl("/processes", {
      ref: parsedFilters.ref,
      state: parsedFilters.state,
      status: parsedFilters.status,
      limit: "100",
    });
  }, [parsedFilters]);

  const {
    data: processList,
    isLoading: isLoadingProcesses,
    error: processError,
    isValidating: isProcessListValidating,
  } = useSWR(processesUrl, (url) => apiFetchJson(url, processListSchema), {
    refreshInterval: 5000,
  });

  const [extraProcesses, setExtraProcesses] = useState<Process[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [loadedChunks, setLoadedChunks] = useState(1);
  const paginationVersionRef = useRef(0);

  useEffect(() => {
    if (processesUrl === "") return;

    paginationVersionRef.current += 1;
    setExtraProcesses([]);
    setNextCursor(null);
    setLoadMoreError(null);
    setLoadedChunks(1);
    setSelectedIds(new Set());
  }, [processesUrl]);

  useEffect(() => {
    if (
      extraProcesses.length === 0 &&
      processList !== undefined &&
      !isProcessListValidating
    ) {
      setNextCursor(processList.nextCursor);
    }
  }, [processList, extraProcesses.length, isProcessListValidating]);

  const processes = useMemo(() => {
    const seen = new Set<number>();
    const merged: Process[] = [];

    for (const process of [...(processList?.items ?? []), ...extraProcesses]) {
      if (seen.has(process.id)) continue;

      seen.add(process.id);
      merged.push(process);
    }

    return merged;
  }, [processList, extraProcesses]);

  const refreshProcesses = async () => {
    paginationVersionRef.current += 1;
    setExtraProcesses([]);
    setNextCursor(null);
    setLoadMoreError(null);
    setLoadedChunks(1);

    await mutate(processesUrl);
  };

  const loadMoreProcesses = useCallback(async () => {
    if (nextCursor === null || isLoadingMore) return;

    const startedVersion = paginationVersionRef.current;

    setIsLoadingMore(true);
    setLoadMoreError(null);

    try {
      const data = await apiFetchJson(
        buildUrl("/processes", {
          ref: parsedFilters.ref,
          state: parsedFilters.state,
          status: parsedFilters.status,
          limit: "100",
          cursor: nextCursor,
        }),
        processListSchema,
      );

      if (paginationVersionRef.current !== startedVersion) return;

      setExtraProcesses((previous) => [...previous, ...data.items]);
      setNextCursor(data.nextCursor);
      setLoadedChunks((previous) => previous + 1);
    } catch (error) {
      if (paginationVersionRef.current !== startedVersion) return;

      const message = errorMessageFrom(error, "Failed to load more processes.");
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

    void loadMoreProcesses();
  }, [loadedChunks, page, isLoadingMore, nextCursor, loadMoreProcesses]);

  const selectedProcess = useMemo(() => {
    return (
      processes.find((process) => process.id === selectedProcessId) ?? null
    );
  }, [processes, selectedProcessId]);

  const outputKey =
    selectedProcess && selectedProcess.state === "idle"
      ? buildUrl(`/processes/${selectedProcess.id}/output`)
      : null;

  const stdoutKey =
    selectedProcess && selectedProcess.state === "idle"
      ? buildUrl(`/processes/${selectedProcess.id}/stdout`)
      : null;

  const stderrKey =
    selectedProcess && selectedProcess.state === "idle"
      ? buildUrl(`/processes/${selectedProcess.id}/stderr`)
      : null;

  const codeKey = selectedProcess
    ? buildUrl(`/processes/${selectedProcess.id}/code`)
    : null;

  const { data: outputData, error: outputError } = useSWR(
    outputKey,
    (url) => apiFetchJson(url, z.record(z.string(), z.unknown())),
    {
      refreshInterval: 5000,
    },
  );

  const { data: stdoutData, error: stdoutError } = useSWR(
    stdoutKey,
    apiFetchText,
    {
      refreshInterval: 5000,
    },
  );

  const { data: stderrData, error: stderrError } = useSWR(
    stderrKey,
    apiFetchText,
    {
      refreshInterval: 5000,
    },
  );

  const { data: codeData } = useSWR(codeKey, apiFetchText, {
    refreshInterval: 5000,
  });

  const envDocsUrl = isEnvDocsOpen ? buildUrl("/environment/docs") : null;
  const { data: envDocs, error: envDocsError } = useSWR(
    envDocsUrl,
    apiFetchText,
  );

  const stdoutContent =
    stdoutData ??
    (stdoutError && selectedProcess?.state !== "idle"
      ? "Stdout is available once the process is idle."
      : "No stdout yet.");

  const stderrContent =
    stderrData ??
    (stderrError && selectedProcess?.state !== "idle"
      ? "Stderr is available once the process is idle."
      : "No stderr yet.");

  const outputContent = outputData
    ? JSON.stringify(outputData, null, 2)
    : outputError && selectedProcess?.state !== "idle"
      ? "Output is available once the process is idle."
      : "No output yet.";

  const codeContent = codeData ?? "No code available.";

  const canKill = (process: Process) => {
    return (
      process.state === "queued" ||
      process.state === "running" ||
      process.state === "suspended"
    );
  };

  const canRun = (process: Process) => {
    return process.state === "idle" || process.state === "terminated";
  };

  const canDelete = (process: Process) => {
    return process.state === "idle" || process.state === "terminated";
  };

  const canUnload = (process: Process) => {
    return (
      (process.state === "idle" || process.state === "terminated") &&
      process.pid !== null
    );
  };

  const needsRestartConfirmation = (process: Process) => {
    return process.state === "idle" && process.exitState !== null;
  };

  const handleCreateProcess = async () => {
    setCreateErrors({});

    const parsed = createProcessSchema.safeParse({
      code: createCode,
      ref: createRef,
      timeout: createTimeout,
      autorun: createAutorun,
    });

    if (!parsed.success) {
      const flattened = parsed.error.flatten((err) => err.message);

      setCreateErrors({
        code: flattened.fieldErrors.code?.[0],
        ref: flattened.fieldErrors.ref?.[0],
        timeout: flattened.fieldErrors.timeout?.[0],
      });

      return;
    }

    setIsCreating(true);

    try {
      await apiFetch(buildUrl("/processes"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: parsed.data.code,
          ...(parsed.data.ref ? { ref: parsed.data.ref } : {}),
          ...(parsed.data.timeout !== undefined
            ? { timeoutMs: parsed.data.timeout }
            : {}),
          autorun: parsed.data.autorun,
        }),
      });

      setCreateCode("");
      setCreateRef("");
      setCreateTimeout("");
      setCreateAutorun(true);
      setIsCreateOpen(false);

      await refreshProcesses();

      addNotification({
        type: "success",
        title: "Process created",
        message: "Process created.",
      });
    } catch (error) {
      addNotification({
        type: "error",
        title: "Process creation failed",
        message: errorMessageFrom(error, "Unable to create process."),
      });
    } finally {
      setIsCreating(false);
    }
  };

  const handleRunProcess = async (process: Process, force: boolean) => {
    try {
      await apiFetch(buildUrl(`/processes/${process.id}/signals/run`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force }),
      });

      await refreshProcesses();

      addNotification({
        type: "success",
        title: "Process started",
        message: "Process started.",
      });
    } catch (error) {
      addNotification({
        type: "error",
        title: "Process start failed",
        message: errorMessageFrom(error, "Unable to start process."),
      });
    }
  };

  const handleKillProcess = async (process: Process) => {
    try {
      await apiFetch(buildUrl(`/processes/${process.id}/signals/kill`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      await refreshProcesses();

      addNotification({
        type: "success",
        title: "Process terminated",
        message: "Process terminated.",
      });
    } catch (error) {
      addNotification({
        type: "error",
        title: "Process termination failed",
        message: errorMessageFrom(error, "Unable to kill process."),
      });
    }
  };

  const handleDeleteProcess = async (process: Process) => {
    try {
      await apiFetch(buildUrl(`/processes/${process.id}`), {
        method: "DELETE",
      });

      setSelectedIds((previous) => {
        if (!previous.has(process.id)) return previous;
        const next = new Set(previous);
        next.delete(process.id);
        return next;
      });
      if (selectedProcessId === process.id) {
        updateSearchParams({ process: undefined });
      }

      await refreshProcesses();

      addNotification({
        type: "success",
        title: "Process deleted",
        message: "Process deleted.",
      });
    } catch (error) {
      addNotification({
        type: "error",
        title: "Process deletion failed",
        message: errorMessageFrom(error, "Unable to delete process."),
      });
    }
  };

  const handleUnloadProcess = async (process: Process) => {
    try {
      await apiFetch(buildUrl(`/processes/${process.id}/signals/unload`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      await refreshProcesses();

      addNotification({
        type: "success",
        title: "Process unloaded",
        message: "Process unloaded from memory.",
      });
    } catch (error) {
      addNotification({
        type: "error",
        title: "Process unload failed",
        message: errorMessageFrom(error, "Unable to unload process."),
      });
    }
  };

  const handleDrawerRun = (process: Process) => {
    if (!canRun(process)) return;

    if (needsRestartConfirmation(process)) {
      setRestartCandidate(process);
      setIsRestartDialogOpen(true);
      return;
    }

    void handleRunProcess(process, false);
  };

  const toggleSelectProcess = (id: number, checked: boolean) => {
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
      checked ? new Set(processes.map((process) => process.id)) : new Set(),
    );
  };

  const selectedProcesses = useMemo(
    () => processes.filter((process) => selectedIds.has(process.id)),
    [processes, selectedIds],
  );

  const deletableSelected = useMemo(
    () =>
      selectedProcesses.filter(
        (process) => process.state === "idle" || process.state === "terminated",
      ),
    [selectedProcesses],
  );

  const unloadableSelected = useMemo(
    () =>
      selectedProcesses.filter(
        (process) =>
          (process.state === "idle" || process.state === "terminated") &&
          process.pid !== null,
      ),
    [selectedProcesses],
  );

  const allSelected =
    processes.length > 0 && selectedIds.size >= processes.length;
  const someSelected =
    selectedIds.size > 0 && selectedIds.size < processes.length;

  const pruneSelection = (ids: number[]) => {
    if (ids.length === 0) return;
    setSelectedIds((previous) => {
      if (previous.size === 0) return previous;
      const removed = new Set(ids);
      const next = new Set([...previous].filter((id) => !removed.has(id)));
      return next.size === previous.size ? previous : next;
    });
  };

  const handleBulkDelete = async () => {
    if (deletableSelected.length === 0 || isBulkWorking) return;

    setIsBulkWorking(true);
    const targets = [...deletableSelected];

    try {
      const results = await Promise.allSettled(
        targets.map((process) =>
          apiFetch(buildUrl(`/processes/${process.id}`), {
            method: "DELETE",
          }),
        ),
      );

      const succeededIds: number[] = [];
      let failed = 0;
      results.forEach((result, index) => {
        if (result.status === "fulfilled") {
          succeededIds.push(targets[index].id);
        } else {
          failed += 1;
        }
      });

      pruneSelection(succeededIds);
      if (
        selectedProcessId !== null &&
        succeededIds.includes(selectedProcessId)
      ) {
        updateSearchParams({ process: undefined });
      }

      await refreshProcesses();

      if (failed === 0) {
        addNotification({
          type: "success",
          title: "Processes deleted",
          message:
            succeededIds.length === 1
              ? "1 process deleted."
              : `${succeededIds.length} processes deleted.`,
        });
      } else {
        addNotification({
          type: succeededIds.length > 0 ? "success" : "error",
          title: "Bulk delete incomplete",
          message: `${succeededIds.length} deleted, ${failed} failed. Ineligible processes were skipped.`,
        });
      }
    } catch (error) {
      addNotification({
        type: "error",
        title: "Bulk delete failed",
        message: errorMessageFrom(error, "Unable to delete processes."),
      });
    } finally {
      setIsBulkWorking(false);
      setIsBulkDeleteOpen(false);
    }
  };

  const handleBulkUnload = async () => {
    if (unloadableSelected.length === 0 || isBulkWorking) return;

    setIsBulkWorking(true);
    const targets = [...unloadableSelected];

    try {
      const results = await Promise.allSettled(
        targets.map((process) =>
          apiFetch(buildUrl(`/processes/${process.id}/signals/unload`), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          }),
        ),
      );

      const succeeded = results.filter(
        (result) => result.status === "fulfilled",
      ).length;
      const failed = results.length - succeeded;

      await refreshProcesses();

      if (failed === 0) {
        addNotification({
          type: "success",
          title: "Processes unloaded",
          message:
            succeeded === 1
              ? "1 process unloaded from memory."
              : `${succeeded} processes unloaded from memory.`,
        });
      } else {
        addNotification({
          type: succeeded > 0 ? "success" : "error",
          title: "Bulk unload incomplete",
          message: `${succeeded} unloaded, ${failed} failed. Ineligible processes were skipped.`,
        });
      }
    } catch (error) {
      addNotification({
        type: "error",
        title: "Bulk unload failed",
        message: errorMessageFrom(error, "Unable to unload processes."),
      });
    } finally {
      setIsBulkWorking(false);
    }
  };

  return (
    <>
      <section className="flex h-svh flex-col px-6 pb-6">
        <header className="sticky top-0 z-10 -mx-6 mb-6 flex flex-col gap-4 border-b bg-background px-6 py-4">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="space-y-1">
              <h1 className="text-xl font-semibold">Processes</h1>
              <p className="text-muted-foreground text-sm">
                Monitor, inspect and interact with processes.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Popover open={isCreateOpen} onOpenChange={setIsCreateOpen}>
                <PopoverTrigger asChild>
                  <Button className="gap-2" type="button">
                    <Plus />
                    Create process
                  </Button>
                </PopoverTrigger>

                <PopoverContent align="end" className="w-[26rem]">
                  <div className="space-y-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="space-y-1">
                        <h3 className="text-sm font-medium">New process</h3>
                        <p className="text-muted-foreground text-xs">
                          Provide information to initialize a new process.
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="gap-1 text-xs"
                        onClick={() => setIsEnvDocsOpen(true)}
                      >
                        <BookOpen />
                        Environment docs
                      </Button>
                    </div>

                    <div className="space-y-3">
                      <div className="space-y-2">
                        <Label htmlFor="process-code">Code</Label>
                        <Textarea
                          id="process-code"
                          className="max-h-40"
                          onChange={(event) =>
                            setCreateCode(event.target.value)
                          }
                          placeholder="export default async () => { /* ... */ }"
                          rows={4}
                          value={createCode}
                        />

                        {createErrors.code ? (
                          <p className="text-xs text-destructive">
                            {createErrors.code}
                          </p>
                        ) : null}
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="process-ref">Ref (optional)</Label>
                        <Input
                          id="process-ref"
                          onChange={(event) => setCreateRef(event.target.value)}
                          placeholder="deploy-2026-04-30"
                          value={createRef}
                        />

                        {createErrors.ref ? (
                          <p className="text-xs text-destructive">
                            {createErrors.ref}
                          </p>
                        ) : null}
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="process-timeout">
                          Timeout in ms (optional)
                        </Label>
                        <Input
                          id="process-timeout"
                          inputMode="numeric"
                          onChange={(event) =>
                            setCreateTimeout(event.target.value)
                          }
                          placeholder="30000"
                          value={createTimeout}
                        />

                        {createErrors.timeout ? (
                          <p className="text-xs text-destructive">
                            {createErrors.timeout}
                          </p>
                        ) : null}
                      </div>

                      <div className="flex items-center gap-2">
                        <Checkbox
                          id="process-autorun"
                          checked={createAutorun}
                          onCheckedChange={(checked) =>
                            setCreateAutorun(checked === true)
                          }
                        />
                        <Label htmlFor="process-autorun">
                          Start immediately
                        </Label>
                      </div>
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
                        onClick={() => void handleCreateProcess()}
                      >
                        <Play />
                        {isCreating ? "Creating" : "Create"}
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
                placeholder="Filter by ref"
                value={refFilter}
                onChange={(event) =>
                  updateSearchParams({
                    ref: event.target.value.trim() || undefined,
                    page: undefined,
                  })
                }
              />
            </div>

            <div className="flex items-center gap-2">
              <Select
                onValueChange={(value) =>
                  updateSearchParams({
                    state: value === "all" ? undefined : value,
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
                  <SelectItem value="idle">Idle</SelectItem>
                  <SelectItem value="queued">Queued</SelectItem>
                  <SelectItem value="running">Running</SelectItem>
                  <SelectItem value="suspended">Suspended</SelectItem>
                  <SelectItem value="terminating">Terminating</SelectItem>
                  <SelectItem value="terminated">Terminated</SelectItem>
                </SelectContent>
              </Select>

              <Select
                onValueChange={(value) =>
                  updateSearchParams({
                    status: value === "all" ? undefined : value,
                    page: undefined,
                  })
                }
                value={statusFilter}
              >
                <SelectTrigger className="w-[170px]">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>

                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="null">None</SelectItem>
                  <SelectItem value="success">Success</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                  <SelectItem value="timeout">Timeout</SelectItem>
                  <SelectItem value="canceled">Canceled</SelectItem>
                </SelectContent>
              </Select>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    className="gap-2"
                    onClick={() => {
                      refreshProcesses()
                        .then(() => {
                          addNotification({
                            type: "success",
                            title: "Processes refreshed",
                            message: "Processes refreshed.",
                          });
                        })
                        .catch((error) => {
                          addNotification({
                            type: "error",
                            title: "Refresh processes failed",
                            message: errorMessageFrom(
                              error,
                              "Failed to refresh processes.",
                            ),
                          });
                        });
                    }}
                    aria-label="Refresh processes"
                  >
                    <RotateCcw />
                  </Button>
                </TooltipTrigger>

                <TooltipContent>Refresh processes</TooltipContent>
              </Tooltip>
            </div>
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto [&_[data-slot='table-container']]:overflow-visible">
          {selectedIds.size > 0 ? (
            <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b bg-background px-1 py-2">
              <span className="text-sm text-muted-foreground">
                {selectedIds.size === 1
                  ? "1 selected"
                  : `${selectedIds.size} selected`}
                {selectedProcesses.length !== selectedIds.size
                  ? ` (${selectedProcesses.length} visible)`
                  : null}
              </span>

              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-2"
                  disabled={unloadableSelected.length === 0 || isBulkWorking}
                  onClick={() => void handleBulkUnload()}
                  title={
                    unloadableSelected.length === 0
                      ? "No selected processes can be unloaded (idle or terminated with a live runtime)"
                      : "Unload selected processes"
                  }
                >
                  <Archive />
                  Unload
                  {unloadableSelected.length > 0
                    ? ` (${unloadableSelected.length})`
                    : null}
                </Button>

                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-2 text-destructive hover:text-destructive"
                  disabled={deletableSelected.length === 0 || isBulkWorking}
                  onClick={() => setIsBulkDeleteOpen(true)}
                  title={
                    deletableSelected.length === 0
                      ? "No selected processes can be deleted (idle or terminated)"
                      : "Delete selected processes"
                  }
                >
                  <Trash2 />
                  Delete
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

          {isLoadingProcesses ? (
            <div className="flex items-center justify-center h-full py-12">
              <p className="text-sm text-muted-foreground">
                Loading processes…
              </p>
            </div>
          ) : processes.length === 0 ? (
            <div className="flex items-center justify-center h-full py-12">
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Braces aria-hidden />
                  </EmptyMedia>
                  <EmptyTitle>No processes found</EmptyTitle>
                  <EmptyDescription>
                    No processes match the current filters. Create one to get
                    started.
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
                      aria-label="Select all processes"
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
                  <TableHead>PID</TableHead>
                  <TableHead>Ref</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>

              <TableBody>
                {processes.map((process) => (
                  <TableRow
                    key={process.id}
                    className={cn(
                      "cursor-pointer",
                      process.id === selectedProcessId ? "bg-primary/10" : "",
                    )}
                    onClick={() =>
                      updateSearchParams({ process: String(process.id) })
                    }
                  >
                    <TableCell onClick={(event) => event.stopPropagation()}>
                      <Checkbox
                        aria-label={`Select process ${process.id}`}
                        checked={selectedIds.has(process.id)}
                        onCheckedChange={(checked) =>
                          toggleSelectProcess(process.id, checked === true)
                        }
                      />
                    </TableCell>
                    <TableCell className="font-medium">{process.id}</TableCell>

                    <TableCell className="font-mono text-xs">
                      {process.pid ?? ": "}
                    </TableCell>

                    <TableCell>{process.ref ?? "-"}</TableCell>

                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Badge variant="secondary">{process.state}</Badge>

                        {process.state === "suspended" &&
                        process.pendingApprovalIds ? (
                          <Link
                            to={`/approvals?processId=${process.id}`}
                            className="underline-offset-2 hover:underline"
                          >
                            <Badge className="text-xs bg-info text-info-foreground">
                              {process.pendingApprovalIds.length} pending
                            </Badge>
                          </Link>
                        ) : null}
                      </div>
                    </TableCell>

                    <TableCell>
                      <Badge
                        className={exitStateBadgeClassName(process.exitState)}
                      >
                        {process.exitState ?? "none"}
                      </Badge>
                    </TableCell>

                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              className="h-8 w-8 p-0"
                              aria-label="Run process"
                              disabled={!canRun(process)}
                              onClick={(event) => {
                                event.stopPropagation();

                                if (!canRun(process)) {
                                  return;
                                }

                                if (needsRestartConfirmation(process)) {
                                  setRestartCandidate(process);
                                  setIsRestartDialogOpen(true);
                                  return;
                                }

                                void handleRunProcess(process, false);
                              }}
                            >
                              <RotateCcw />
                            </Button>
                          </TooltipTrigger>

                          <TooltipContent>Run process</TooltipContent>
                        </Tooltip>

                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              className="h-8 w-8 p-0"
                              aria-label="Unload process"
                              disabled={!canUnload(process)}
                              onClick={(event) => {
                                event.stopPropagation();

                                if (!canUnload(process)) {
                                  return;
                                }

                                void handleUnloadProcess(process);
                              }}
                            >
                              <Archive />
                            </Button>
                          </TooltipTrigger>

                          <TooltipContent>Unload process</TooltipContent>
                        </Tooltip>

                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              className="h-8 w-8 p-0 text-destructive"
                              aria-label="Kill process"
                              disabled={!canKill(process)}
                              onClick={(event) => {
                                event.stopPropagation();

                                if (!canKill(process)) {
                                  return;
                                }

                                void handleKillProcess(process);
                              }}
                            >
                              <X />
                            </Button>
                          </TooltipTrigger>

                          <TooltipContent>Kill process</TooltipContent>
                        </Tooltip>

                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              className="h-8 w-8 p-0 text-destructive"
                              aria-label="Delete process"
                              disabled={!canDelete(process)}
                              onClick={(event) => {
                                event.stopPropagation();

                                if (!canDelete(process)) {
                                  return;
                                }

                                setDeleteCandidate(process);
                                setIsDeleteDialogOpen(true);
                              }}
                            >
                              <Trash2 />
                            </Button>
                          </TooltipTrigger>

                          <TooltipContent>Delete process</TooltipContent>
                        </Tooltip>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          {processError ? (
            <p className="p-4 text-sm text-destructive">
              Failed to load processes.
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

          {loadMoreError !== null ? (
            <p className="p-4 text-sm text-destructive">{loadMoreError}</p>
          ) : null}

          <Sheet
            open={selectedProcessId !== null}
            onOpenChange={(open) => {
              if (!open) {
                updateSearchParams({ process: undefined });
              }
            }}
          >
            <SheetContent
              side="right"
              className="data-[side=right]:w-full data-[side=right]:sm:max-w-lg"
            >
              <SheetHeader>
                <SheetTitle>Process details</SheetTitle>
                <SheetDescription>
                  Output and code for the selected process.
                </SheetDescription>
              </SheetHeader>

              <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
                {selectedProcess ? (
                  <div className="mb-4 rounded-md border bg-muted/30 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs text-muted-foreground">
                        Process #{selectedProcess.id}
                      </span>

                      <Badge variant="secondary">{selectedProcess.state}</Badge>

                      <Badge
                        className={exitStateBadgeClassName(
                          selectedProcess.exitState,
                        )}
                      >
                        {selectedProcess.exitState ?? "none"}
                      </Badge>

                      {selectedProcess.state === "suspended" &&
                      selectedProcess.pendingApprovalIds ? (
                        <Link
                          to={`/approvals?processId=${selectedProcess.id}`}
                          className="underline-offset-2 hover:underline"
                        >
                          <Badge className="text-xs bg-info text-info-foreground">
                            {selectedProcess.pendingApprovalIds.length} pending
                          </Badge>
                        </Link>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                <Accordion
                  type="multiple"
                  defaultValue={
                    selectedProcess?.error ? ["error", "output"] : ["output"]
                  }
                  className="w-full"
                >
                  {selectedProcess?.error ? (
                    <AccordionItem value="error">
                      <AccordionTrigger className="text-destructive">
                        Error
                      </AccordionTrigger>

                      <AccordionContent className="h-max">
                        <DetailView
                          title="Error"
                          content={selectedProcess.error ?? ""}
                          variant="error"
                        />
                      </AccordionContent>
                    </AccordionItem>
                  ) : null}

                  <AccordionItem value="code">
                    <AccordionTrigger>Code</AccordionTrigger>

                    <AccordionContent className="h-max">
                      <DetailView title="Code" content={codeContent} />
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem value="output">
                    <AccordionTrigger>Output</AccordionTrigger>

                    <AccordionContent className="h-max">
                      <DetailView
                        title="Output"
                        content={outputContent}
                        language="json"
                      />
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem value="stdout">
                    <AccordionTrigger>Stdout</AccordionTrigger>

                    <AccordionContent className="h-max">
                      <DetailView title="Stdout" content={stdoutContent} />
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem value="stderr">
                    <AccordionTrigger>Stderr</AccordionTrigger>

                    <AccordionContent className="h-max">
                      <DetailView title="Stderr" content={stderrContent} />
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              </div>

              {selectedProcess ? (
                <div className="border-t bg-background px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-medium">Actions</span>

                    <div className="flex items-center gap-1">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="outline"
                            className="gap-2"
                            disabled={!canRun(selectedProcess)}
                            onClick={() => handleDrawerRun(selectedProcess)}
                          >
                            <RotateCcw />
                            Run
                          </Button>
                        </TooltipTrigger>

                        <TooltipContent>
                          {needsRestartConfirmation(selectedProcess)
                            ? "Restart process"
                            : "Run process"}
                        </TooltipContent>
                      </Tooltip>

                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="outline"
                            className="gap-2"
                            disabled={!canUnload(selectedProcess)}
                            onClick={() =>
                              void handleUnloadProcess(selectedProcess)
                            }
                          >
                            <Archive />
                            Unload
                          </Button>
                        </TooltipTrigger>

                        <TooltipContent>Unload process</TooltipContent>
                      </Tooltip>

                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="outline"
                            className="gap-2 text-destructive hover:text-destructive"
                            disabled={!canKill(selectedProcess)}
                            onClick={() =>
                              void handleKillProcess(selectedProcess)
                            }
                          >
                            <X />
                            Kill
                          </Button>
                        </TooltipTrigger>

                        <TooltipContent>Kill process</TooltipContent>
                      </Tooltip>

                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="outline"
                            className="gap-2 text-destructive hover:text-destructive"
                            disabled={!canDelete(selectedProcess)}
                            onClick={() => {
                              setDeleteCandidate(selectedProcess);
                              setIsDeleteDialogOpen(true);
                            }}
                          >
                            <Trash2 />
                            Delete
                          </Button>
                        </TooltipTrigger>

                        <TooltipContent>Delete process</TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                </div>
              ) : null}
            </SheetContent>
          </Sheet>
        </div>
      </section>

      <Dialog open={isEnvDocsOpen} onOpenChange={setIsEnvDocsOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Environment docs</DialogTitle>
            <DialogDescription>
              Globals and bindings available to process code.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto text-sm">
            {envDocsError ? (
              <p className="text-sm text-destructive">
                Failed to load environment docs.
              </p>
            ) : envDocs === undefined ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : (
              <div className="prose prose-sm dark:prose-invert max-w-none">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {envDocs}
                </ReactMarkdown>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={isRestartDialogOpen}
        onOpenChange={(open) => {
          setIsRestartDialogOpen(open);

          if (!open) {
            setRestartCandidate(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restart process?</AlertDialogTitle>
            <AlertDialogDescription>
              This process has existing outputs. Restarting will overwrite prior
              outputs unless you cancel.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>

            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (!restartCandidate) {
                  return;
                }

                void handleRunProcess(restartCandidate, true);
                setIsRestartDialogOpen(false);
                setRestartCandidate(null);
              }}
            >
              Restart
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={isDeleteDialogOpen}
        onOpenChange={(open) => {
          setIsDeleteDialogOpen(open);

          if (!open) {
            setDeleteCandidate(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete process?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. The process record and its outputs
              will be permanently removed.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>

            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (!deleteCandidate) {
                  return;
                }

                void handleDeleteProcess(deleteCandidate);
                setIsDeleteDialogOpen(false);
                setDeleteCandidate(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={isBulkDeleteOpen}
        onOpenChange={(open) => {
          if (!isBulkWorking) {
            setIsBulkDeleteOpen(open);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {deletableSelected.length}{" "}
              {deletableSelected.length === 1 ? "process" : "processes"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. The process records and their
              outputs will be permanently removed.
              {selectedIds.size !== deletableSelected.length
                ? ` ${selectedIds.size - deletableSelected.length} selected ${selectedIds.size - deletableSelected.length === 1 ? "process is" : "processes are"} ineligible (only idle or terminated can be deleted) and will be skipped.`
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={isBulkWorking}>
              Cancel
            </AlertDialogCancel>

            <AlertDialogAction
              variant="destructive"
              disabled={deletableSelected.length === 0 || isBulkWorking}
              onClick={() => {
                void handleBulkDelete();
              }}
            >
              {isBulkWorking ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
