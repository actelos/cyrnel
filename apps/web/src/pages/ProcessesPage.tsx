import {
  Archive,
  ChevronDown,
  Maximize2,
  Play,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import useSWR, { useSWRConfig } from "swr";
import { z } from "zod";
import { CopyButton } from "@/components/copy-button";
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
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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

const stateBadgeVariant = (state: ProcessState) => {
  if (state === "running") return "default";
  if (state === "queued") return "secondary";
  if (state === "suspended") return "secondary";
  if (state === "terminating") return "destructive";
  if (state === "terminated") return "outline";
  return "outline";
};

const exitStateBadgeVariant = (exitState: ProcessExitState) => {
  if (exitState === "failed") return "destructive";
  if (exitState === "success") return "default";
  if (exitState === "timeout") return "secondary";
  if (exitState === "canceled") return "outline";
  return "outline";
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
  const [createErrors, setCreateErrors] = useState<CreateProcessErrors>({});
  const { addNotification } = useNotification();
  const [isCreating, setIsCreating] = useState(false);
  const [restartCandidate, setRestartCandidate] = useState<Process | null>(
    null,
  );
  const [isRestartDialogOpen, setIsRestartDialogOpen] = useState(false);
  const [deleteCandidate, setDeleteCandidate] = useState<Process | null>(null);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [detailView, setDetailView] = useState<{
    title: string;
    content: string;
  } | null>(null);

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
      setLoadMoreError(
        errorMessageFrom(error, "Failed to load more processes."),
      );
    } finally {
      setIsLoadingMore(false);
    }
  }, [nextCursor, isLoadingMore, parsedFilters]);

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
            ? { options: { timeout: parsed.data.timeout } }
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
        title: "Success",
        message: "Process created.",
      });
    } catch (error) {
      addNotification({
        type: "error",
        title: "Error",
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
        title: "Success",
        message: "Process started.",
      });
    } catch (error) {
      addNotification({
        type: "error",
        title: "Error",
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
        title: "Success",
        message: "Process terminated.",
      });
    } catch (error) {
      addNotification({
        type: "error",
        title: "Error",
        message: errorMessageFrom(error, "Unable to kill process."),
      });
    }
  };

  const handleDeleteProcess = async (process: Process) => {
    try {
      await apiFetch(buildUrl(`/processes/${process.id}`), {
        method: "DELETE",
      });
      await refreshProcesses();
      addNotification({
        type: "success",
        title: "Success",
        message: "Process deleted.",
      });
    } catch (error) {
      addNotification({
        type: "error",
        title: "Error",
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
        title: "Success",
        message: "Process unloaded from memory.",
      });
    } catch (error) {
      addNotification({
        type: "error",
        title: "Error",
        message: errorMessageFrom(error, "Unable to unload process."),
      });
    }
  };

  return (
    <>
      <section className="flex h-svh flex-col px-6 pb-6">
        <header className="sticky top-0 z-10 -mx-6 flex flex-col gap-4 border-b bg-background px-6 py-4 mb-6">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="space-y-1 pt-4">
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
                    <div className="space-y-1">
                      <h3 className="text-sm font-medium">New process</h3>
                      <p className="text-muted-foreground text-xs">
                        Provide information to initialize a new process.
                      </p>
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
                            title: "Success",
                            message: "Processes refreshed.",
                          });
                        })
                        .catch((error) => {
                          addNotification({
                            type: "error",
                            title: "Error",
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
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow>
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
                  <TableCell className="font-medium">{process.id}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {process.pid ?? ": "}
                  </TableCell>
                  <TableCell>{process.ref ?? "-"}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Badge variant={stateBadgeVariant(process.state)}>
                        {process.state}
                      </Badge>
                      {process.state === "suspended" &&
                      process.pendingApprovalIds ? (
                        <Badge variant="outline" className="text-xs">
                          {process.pendingApprovalIds.length} pending
                        </Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={exitStateBadgeVariant(process.exitState)}>
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
              {processes.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="py-8 text-center text-muted-foreground"
                  >
                    {isLoadingProcesses
                      ? "Loading processes…"
                      : "No processes found."}
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
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
              if (!open) updateSearchParams({ process: undefined });
            }}
          >
            <SheetContent
              side="right"
              className="data-[side=right]:w-full data-[side=right]:sm:max-w-xl"
            >
              <SheetHeader>
                <SheetTitle>Process details</SheetTitle>
                <SheetDescription>
                  Output and code for the selected process.
                </SheetDescription>
              </SheetHeader>
              <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
                <Accordion
                  type="multiple"
                  defaultValue={
                    selectedProcess?.error ? ["error", "stdout"] : ["stdout"]
                  }
                  className="w-full"
                >
                  {selectedProcess?.error ? (
                    <AccordionItem value="error">
                      <AccordionTrigger className="text-destructive">
                        Error
                      </AccordionTrigger>
                      <AccordionContent>
                        <div className="relative">
                          <div className="absolute right-2 top-2 z-10 flex gap-1">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-8 w-8 p-0"
                              onClick={() =>
                                setDetailView({
                                  title: "Error",
                                  content: selectedProcess.error ?? "",
                                })
                              }
                            >
                              <Maximize2 />
                            </Button>
                            <CopyButton
                              value={selectedProcess.error ?? ""}
                              variant="ghost"
                              iconOnly
                            />
                          </div>
                          <div className="h-24 w-full overflow-auto border border-destructive/40 bg-destructive/5 p-3 pr-12 text-xs font-mono text-destructive whitespace-pre">
                            {selectedProcess.error}
                          </div>
                        </div>
                      </AccordionContent>
                    </AccordionItem>
                  ) : null}
                  <AccordionItem value="code">
                    <AccordionTrigger>Code</AccordionTrigger>
                    <AccordionContent>
                      <div className="relative">
                        <div className="absolute right-2 top-2 z-10 flex gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0"
                            onClick={() =>
                              setDetailView({
                                title: "Code",
                                content: codeContent,
                              })
                            }
                          >
                            <Maximize2 />
                          </Button>
                          <CopyButton
                            value={codeContent}
                            variant="ghost"
                            iconOnly
                          />
                        </div>
                        <div className="h-24 w-full overflow-auto border bg-muted/30 p-3 pr-12 text-xs font-mono whitespace-pre">
                          {codeContent}
                        </div>
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                  <AccordionItem value="output">
                    <AccordionTrigger>Output</AccordionTrigger>
                    <AccordionContent>
                      <div className="relative">
                        <div className="absolute right-2 top-2 z-10 flex gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0"
                            onClick={() =>
                              setDetailView({
                                title: "Output",
                                content: outputContent,
                              })
                            }
                          >
                            <Maximize2 />
                          </Button>
                          <CopyButton
                            value={outputContent}
                            variant="ghost"
                            iconOnly
                          />
                        </div>
                        <div className="h-24 w-full overflow-auto border bg-muted/30 p-3 pr-12 text-xs font-mono whitespace-pre">
                          {outputContent}
                        </div>
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                  <AccordionItem value="stdout">
                    <AccordionTrigger>Stdout</AccordionTrigger>
                    <AccordionContent>
                      <div className="relative">
                        <div className="absolute right-2 top-2 z-10 flex gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0"
                            onClick={() =>
                              setDetailView({
                                title: "Stdout",
                                content: stdoutContent,
                              })
                            }
                          >
                            <Maximize2 />
                          </Button>
                          <CopyButton
                            value={stdoutContent}
                            variant="ghost"
                            iconOnly
                          />
                        </div>
                        <div className="h-24 w-full overflow-auto border bg-muted/30 p-3 pr-12 text-xs font-mono whitespace-pre">
                          {stdoutContent}
                        </div>
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                  <AccordionItem value="stderr">
                    <AccordionTrigger>Stderr</AccordionTrigger>
                    <AccordionContent>
                      <div className="relative">
                        <div className="absolute right-2 top-2 z-10 flex gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0"
                            onClick={() =>
                              setDetailView({
                                title: "Stderr",
                                content: stderrContent,
                              })
                            }
                          >
                            <Maximize2 />
                          </Button>
                          <CopyButton
                            value={stderrContent}
                            variant="ghost"
                            iconOnly
                          />
                        </div>
                        <div className="h-24 w-full overflow-auto border bg-muted/30 p-3 pr-12 text-xs font-mono whitespace-pre">
                          {stderrContent}
                        </div>
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </section>

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

      <Dialog
        open={detailView !== null}
        onOpenChange={(open) => {
          if (!open) setDetailView(null);
        }}
      >
        <DialogContent className="w-10/12 w-max-h-[85vh] max-w-3xl space-y-4">
          <DialogHeader>
            <DialogTitle>{detailView?.title}</DialogTitle>
          </DialogHeader>
          <div className="relative min-h-0 flex-1 mb-0">
            <CopyButton
              value={detailView?.content ?? ""}
              variant="ghost"
              iconOnly
              className="absolute right-0 top-0 z-10"
            />
            <div className="border bg-muted/30 overflow-hidden">
              <div className="h-full min-h-[200px] overflow-auto p-4 pr-8">
                <div className="whitespace-pre text-xs font-mono">
                  {detailView?.content}
                </div>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
