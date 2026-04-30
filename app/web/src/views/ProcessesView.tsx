import { Copy, Play, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { z } from "zod";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "@/utils/copy.util";

const processStateSchema = z.enum([
  "idle",
  "queued",
  "running",
  "terminating",
]);

const processStatusSchema = z.union([
  z.literal("failed"),
  z.literal("success"),
  z.literal("timeout"),
  z.literal("canceled"),
  z.null(),
]);

const processSchema = z.object({
  pid: z.number().int().positive(),
  ref: z.string().optional(),
  state: processStateSchema,
  status: processStatusSchema,
});

const processListSchema = z.object({
  processes: z.array(processSchema),
});

const refInputSchema = z.preprocess(
  (value) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  },
  z.string().min(1).optional(),
);

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
  code: z.string().min(1, "Code is required."),
  ref: refInputSchema,
  timeout: timeoutInputSchema,
});

const filterSchema = z.object({
  ref: refInputSchema,
  state: processStateSchema.optional(),
  status: z
    .union([
      z.literal("failed"),
      z.literal("success"),
      z.literal("timeout"),
      z.literal("canceled"),
      z.literal("null"),
    ])
    .optional(),
});

type ProcessState = z.infer<typeof processStateSchema>;
type ProcessStatus = z.infer<typeof processStatusSchema>;
type Process = z.infer<typeof processSchema>;

type CreateProcessErrors = Partial<
  Record<"code" | "ref" | "timeout" | "form", string>
>;

const apiBase = import.meta.env.VITE_MCI_API_URL ?? "";

const buildUrl = (
  path: string,
  params?: Record<string, string | undefined>,
) => {
  const base = apiBase.length > 0 ? apiBase : window.location.origin;
  const url = new URL(path, base);
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined) {
        url.searchParams.set(key, value);
      }
    });
  }
  return url.toString();
};

const fetchJson = async <T,>(url: string, schema: z.ZodType<T>) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  const data = await response.json();
  return schema.parse(data);
};

const fetchText = async (url: string) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  const data = await response.text();
  return z.string().parse(data);
};

const stateBadgeVariant = (state: ProcessState) => {
  if (state === "running") return "default";
  if (state === "queued") return "secondary";
  if (state === "terminating") return "destructive";
  return "outline";
};

const statusBadgeVariant = (status: ProcessStatus) => {
  if (status === "failed") return "destructive";
  if (status === "success") return "default";
  if (status === "timeout") return "secondary";
  if (status === "canceled") return "outline";
  return "outline";
};

export default function ProcessesView() {
  const { mutate } = useSWRConfig();
  const [refFilter, setRefFilter] = useState("");
  const [stateFilter, setStateFilter] = useState<ProcessState | "all">("all");
  const [statusFilter, setStatusFilter] = useState<
    "all" | "failed" | "success" | "timeout" | "canceled" | "null"
  >("all");
  const [selectedPid, setSelectedPid] = useState<number | null>(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [createCode, setCreateCode] = useState("");
  const [createRef, setCreateRef] = useState("");
  const [createTimeout, setCreateTimeout] = useState("");
  const [createErrors, setCreateErrors] = useState<CreateProcessErrors>({});
  const [isCreating, setIsCreating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [restartCandidate, setRestartCandidate] = useState<Process | null>(
    null,
  );
  const [isRestartDialogOpen, setIsRestartDialogOpen] = useState(false);

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
    });
  }, [parsedFilters]);

  const {
    data: processList,
    isLoading: isLoadingProcesses,
    error: processError,
  } = useSWR(processesUrl, (url) => fetchJson(url, processListSchema), {
    refreshInterval: 2000,
  });

  const processes = processList?.processes ?? [];

  useEffect(() => {
    if (processes.length === 0) {
      setSelectedPid(null);
      return;
    }

    if (selectedPid === null || !processes.some((p) => p.pid === selectedPid)) {
      setSelectedPid(processes[0]?.pid ?? null);
    }
  }, [processes, selectedPid]);

  const selectedProcess = useMemo(() => {
    return processes.find((process) => process.pid === selectedPid) ?? null;
  }, [processes, selectedPid]);

  const outputKey =
    selectedProcess && selectedProcess.state === "idle"
      ? buildUrl(`/processes/${selectedProcess.pid}/output`)
      : null;
  const stdoutKey =
    selectedProcess && selectedProcess.state === "idle"
      ? buildUrl(`/processes/${selectedProcess.pid}/stdout`)
      : null;
  const stderrKey =
    selectedProcess && selectedProcess.state === "idle"
      ? buildUrl(`/processes/${selectedProcess.pid}/stderr`)
      : null;
  const codeKey = selectedProcess
    ? buildUrl(`/processes/${selectedProcess.pid}/code`)
    : null;

  const { data: outputData, error: outputError } = useSWR(
    outputKey,
    (url) => fetchJson(url, z.record(z.unknown())),
    {
      refreshInterval: 2000,
    },
  );
  const { data: stdoutData, error: stdoutError } = useSWR(
    stdoutKey,
    fetchText,
    {
      refreshInterval: 2000,
    },
  );
  const { data: stderrData, error: stderrError } = useSWR(
    stderrKey,
    fetchText,
    {
      refreshInterval: 2000,
    },
  );
  const { data: codeData } = useSWR(codeKey, fetchText, {
    refreshInterval: 4000,
  });

  const stdoutContent = stdoutData ??
    (stdoutError && selectedProcess?.state !== "idle"
      ? "Stdout is available once the process is idle."
      : "No stdout yet.");
  const stderrContent = stderrData ??
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
    return process.state === "queued" || process.state === "running";
  };

  const canRun = (process: Process) => {
    return process.state === "idle";
  };

  const needsRestartConfirmation = (process: Process) => {
    return process.state === "idle" && process.status !== null;
  };

  const handleCreateProcess = async () => {
    setCreateErrors({});

    const parsed = createProcessSchema.safeParse({
      code: createCode,
      ref: createRef,
      timeout: createTimeout,
    });

    if (!parsed.success) {
      const flattened = parsed.error.flatten();
      setCreateErrors({
        code: flattened.fieldErrors.code?.[0],
        ref: flattened.fieldErrors.ref?.[0],
        timeout: flattened.fieldErrors.timeout?.[0],
      });
      return;
    }

    setIsCreating(true);
    try {
      const response = await fetch(buildUrl("/processes"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: parsed.data.code,
          ...(parsed.data.ref ? { ref: parsed.data.ref } : {}),
          ...(parsed.data.timeout !== undefined
            ? { timeout: parsed.data.timeout }
            : {}),
        }),
      });

      if (!response.ok) {
        throw new Error(`Request failed: ${response.status}`);
      }

      setCreateCode("");
      setCreateRef("");
      setCreateTimeout("");
      setIsCreateOpen(false);
      await mutate(processesUrl);
    } catch (error) {
      setCreateErrors({
        form:
          error instanceof Error
            ? error.message
            : "Unable to create process.",
      });
    } finally {
      setIsCreating(false);
    }
  };

  const handleRunProcess = async (process: Process, force: boolean) => {
    setActionError(null);
    try {
      const response = await fetch(
        buildUrl(`/processes/${process.pid}/signals/run`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ force }),
        },
      );

      if (!response.ok) {
        throw new Error(`Request failed: ${response.status}`);
      }

      await mutate(processesUrl);
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : "Unable to restart process.",
      );
    }
  };

  const handleKillProcess = async (process: Process) => {
    setActionError(null);
    try {
      const response = await fetch(
        buildUrl(`/processes/${process.pid}/signals/kill`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );

      if (!response.ok) {
        throw new Error(`Request failed: ${response.status}`);
      }

      await mutate(processesUrl);
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Unable to kill process.",
      );
    }
  };

  const handleCopyText = async (value: string) => {
    await copyToClipboard(value);
  };

  return (
    <>
      <section className="flex min-h-0 flex-1 flex-col gap-6 overflow-hidden p-6">
        <header className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="space-y-1">
                <h1 className="text-xl font-semibold">Processes</h1>
                <p className="text-muted-foreground text-sm">
                  Monitor and inspect processes and their outputs.
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
                            onChange={(event) =>
                              setCreateRef(event.target.value)
                            }
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
                        {createErrors.form ? (
                          <p className="text-xs text-destructive">
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
                  onChange={(event) => setRefFilter(event.target.value)}
                />
              </div>
              <div className="flex items-center gap-2">
                <Select
                  onValueChange={(value) =>
                    setStateFilter(value as ProcessState | "all")
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
                    <SelectItem value="terminating">Terminating</SelectItem>
                  </SelectContent>
                </Select>
                <Select onValueChange={setStatusFilter} value={statusFilter}>
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
              </div>
            </div>
          </header>

          <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-hidden lg:flex-row">
            <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <CardHeader className="flex flex-row items-center justify-between">
                <div>
                  <CardTitle>Processes</CardTitle>
                  <CardDescription>
                    {isLoadingProcesses
                      ? "Loading..."
                      : `${processes.length} total`}
                  </CardDescription>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  className="gap-2"
                  onClick={() => void mutate(processesUrl)}
                  aria-label="Refresh processes"
                >
                  <RotateCcw />
                </Button>
              </CardHeader>
              <CardContent className="min-h-0 flex-1 overflow-hidden">
                <ScrollArea className="h-full">
                  <Table>
                    <TableHeader>
                      <TableRow>
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
                          key={process.pid}
                          className={cn(
                            "cursor-pointer",
                            process.pid === selectedPid ? "bg-muted/50" : "",
                          )}
                          onClick={() => setSelectedPid(process.pid)}
                        >
                          <TableCell className="font-medium">
                            {process.pid}
                          </TableCell>
                          <TableCell>{process.ref ?? "-"}</TableCell>
                          <TableCell>
                            <Badge variant={stateBadgeVariant(process.state)}>
                              {process.state}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant={statusBadgeVariant(process.status)}
                            >
                              {process.status ?? "none"}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-1">
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
                                <Trash2 />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  {processError ? (
                    <p className="p-4 text-sm text-destructive">
                      Failed to load processes.
                    </p>
                  ) : null}
                  {actionError ? (
                    <p className="p-4 text-sm text-destructive">
                      {actionError}
                    </p>
                  ) : null}
                </ScrollArea>
              </CardContent>
            </Card>

            <aside className="flex w-full min-h-0 flex-col gap-4 overflow-hidden lg:w-[22rem]">
              <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <CardHeader>
                  <CardTitle>Process details</CardTitle>
                  <CardDescription>
                    Output and code for the selected process.
                  </CardDescription>
                </CardHeader>
                <CardContent className="min-h-0 flex-1 overflow-hidden">
                  <ScrollArea className="h-full">
                    <Accordion
                      type="multiple"
                      defaultValue={["stdout"]}
                      className="w-full"
                    >
                      <AccordionItem value="code">
                        <AccordionTrigger>Code</AccordionTrigger>
                        <AccordionContent>
                          <div className="flex items-center justify-end pb-2">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="gap-2"
                              onClick={() => void handleCopyText(codeContent)}
                            >
                              <Copy />
                            </Button>
                          </div>
                          <ScrollArea className="h-[160px] rounded-md border bg-muted/30 p-3">
                            <pre className="whitespace-pre-wrap text-xs font-mono">
                              {codeContent}
                            </pre>
                          </ScrollArea>
                        </AccordionContent>
                      </AccordionItem>
                      <AccordionItem value="output">
                        <AccordionTrigger>Output</AccordionTrigger>
                        <AccordionContent>
                          <div className="flex items-center justify-end pb-2">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="gap-2"
                              onClick={() => void handleCopyText(outputContent)}
                            >
                              <Copy />
                            </Button>
                          </div>
                          <ScrollArea className="h-[160px] rounded-md border bg-muted/30 p-3">
                            <pre className="whitespace-pre-wrap text-xs font-mono">
                              {outputContent}
                            </pre>
                          </ScrollArea>
                        </AccordionContent>
                      </AccordionItem>
                      <AccordionItem value="stdout">
                        <AccordionTrigger>Stdout</AccordionTrigger>
                        <AccordionContent>
                          <div className="flex items-center justify-end pb-2">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="gap-2"
                              onClick={() => void handleCopyText(stdoutContent)}
                            >
                              <Copy />
                            </Button>
                          </div>
                          <ScrollArea className="h-[160px] rounded-md border bg-muted/30 p-3">
                            <pre className="whitespace-pre-wrap text-xs font-mono">
                              {stdoutContent}
                            </pre>
                          </ScrollArea>
                        </AccordionContent>
                      </AccordionItem>
                      <AccordionItem value="stderr">
                        <AccordionTrigger>Stderr</AccordionTrigger>
                        <AccordionContent>
                          <div className="flex items-center justify-end pb-2">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="gap-2"
                              onClick={() => void handleCopyText(stderrContent)}
                            >
                              <Copy />
                            </Button>
                          </div>
                          <ScrollArea className="h-[160px] rounded-md border bg-muted/30 p-3">
                            <pre className="whitespace-pre-wrap text-xs font-mono">
                              {stderrContent}
                            </pre>
                          </ScrollArea>
                        </AccordionContent>
                      </AccordionItem>
                    </Accordion>
                  </ScrollArea>
                </CardContent>
              </Card>
            </aside>
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
              This process has existing outputs. Restarting will overwrite
              prior stdout, stderr, and output unless you cancel.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!restartCandidate) {
                  return;
                }
                void handleRunProcess(restartCandidate, true);
                setIsRestartDialogOpen(false);
                setRestartCandidate(null);
              }}
            >
              Restart with force
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
