import { Copy, Play, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { z } from "zod";
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
import {
  apiFetch,
  apiFetchJson,
  apiFetchText,
  buildUrl,
  errorMessageFrom,
} from "@/lib/api";
import { copyToClipboard } from "@/lib/copy";
import { cn } from "@/lib/utils";

const processStateSchema = z.enum(["idle", "queued", "running", "terminating"]);

const processExitStateSchema = z.union([
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
  exitState: processExitStateSchema,
  error: z.string().nullable(),
});

const processListSchema = z.object({
  processes: z.array(processSchema),
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
type ProcessExitState = z.infer<typeof processExitStateSchema>;
type Process = z.infer<typeof processSchema>;

type CreateProcessErrors = Partial<
  Record<"code" | "ref" | "timeout" | "form", string>
>;

const stateBadgeVariant = (state: ProcessState) => {
  if (state === "running") return "default";
  if (state === "queued") return "secondary";
  if (state === "terminating") return "destructive";
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
  } = useSWR(processesUrl, (url) => apiFetchJson(url, processListSchema), {
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
    (url) => apiFetchJson(url, z.record(z.string(), z.unknown())),
    {
      refreshInterval: 2000,
    },
  );
  const { data: stdoutData, error: stdoutError } = useSWR(
    stdoutKey,
    apiFetchText,
    {
      refreshInterval: 2000,
    },
  );
  const { data: stderrData, error: stderrError } = useSWR(
    stderrKey,
    apiFetchText,
    {
      refreshInterval: 2000,
    },
  );
  const { data: codeData } = useSWR(codeKey, apiFetchText, {
    refreshInterval: 4000,
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
    return process.state === "queued" || process.state === "running";
  };

  const canRun = (process: Process) => {
    return process.state === "idle";
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
        }),
      });

      setCreateCode("");
      setCreateRef("");
      setCreateTimeout("");
      setIsCreateOpen(false);
      await mutate(processesUrl);
    } catch (error) {
      setCreateErrors({
        form: errorMessageFrom(error, "Unable to create process."),
      });
    } finally {
      setIsCreating(false);
    }
  };

  const handleRunProcess = async (process: Process, force: boolean) => {
    setActionError(null);
    try {
      await apiFetch(buildUrl(`/processes/${process.pid}/signals/run`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force }),
      });
      await mutate(processesUrl);
    } catch (error) {
      setActionError(errorMessageFrom(error, "Unable to restart process."));
    }
  };

  const handleKillProcess = async (process: Process) => {
    setActionError(null);
    try {
      await apiFetch(buildUrl(`/processes/${process.pid}/signals/kill`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      await mutate(processesUrl);
    } catch (error) {
      setActionError(errorMessageFrom(error, "Unable to kill process."));
    }
  };

  const handleCopyText = async (value: string) => {
    await copyToClipboard(value);
  };

  return (
    <>
      <section className="min-h-0 flex flex-col flex-1 gap-6 p-6">
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
              <Select
                onValueChange={(value) =>
                  setStatusFilter(
                    value as
                      | "all"
                      | "failed"
                      | "success"
                      | "timeout"
                      | "canceled"
                      | "null",
                  )
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
              <Button
                type="button"
                variant="outline"
                className="gap-2"
                onClick={() => void mutate(processesUrl)}
                aria-label="Refresh processes"
              >
                <RotateCcw />
              </Button>
            </div>
          </div>
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-6 lg:flex-row">
          <Card className="flex min-h-0 flex-1 flex-col">
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>Processes</CardTitle>
              <div className="w-max px-2 bg-muted border-1 border-border">
                {isLoadingProcesses
                  ? "Loading..."
                  : `${processes.length} total`}
              </div>
            </CardHeader>
            <CardContent className="min-h-0 flex-1">
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
                          <div className="flex items-center gap-1.5">
                            <Badge
                              variant={exitStateBadgeVariant(process.exitState)}
                            >
                              {process.exitState ?? "none"}
                            </Badge>
                            {process.error ? (
                              <span
                                role="img"
                                aria-label="Process has an error"
                                className="h-1.5 w-1.5 rounded-full bg-destructive"
                                title={process.error}
                              />
                            ) : null}
                          </div>
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
                  <p className="p-4 text-sm text-destructive">{actionError}</p>
                ) : null}
              </ScrollArea>
            </CardContent>
          </Card>
          <aside className="flex w-full min-h-0 flex-col gap-4 lg:w-[22rem]">
            <Card className="flex min-h-0 flex-1 flex-col">
              <CardHeader>
                <CardTitle>Process details</CardTitle>
                <CardDescription>
                  Output and code for the selected process.
                </CardDescription>
              </CardHeader>
              <CardContent className="min-h-0 flex-1">
                <ScrollArea className="h-full">
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
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="absolute right-2 top-2 z-10 h-8 w-8 p-0"
                              onClick={() =>
                                void handleCopyText(selectedProcess.error ?? "")
                              }
                            >
                              <Copy />
                            </Button>
                            <ScrollArea className="h-[160px] border border-destructive/40 bg-destructive/5 p-3 pr-12">
                              <pre className="whitespace-pre-wrap text-xs font-mono text-destructive">
                                {selectedProcess.error}
                              </pre>
                            </ScrollArea>
                          </div>
                        </AccordionContent>
                      </AccordionItem>
                    ) : null}
                    <AccordionItem value="code">
                      <AccordionTrigger>Code</AccordionTrigger>
                      <AccordionContent>
                        <div className="relative">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="absolute right-2 top-2 z-10 h-8 w-8 p-0"
                            onClick={() => void handleCopyText(codeContent)}
                          >
                            <Copy />
                          </Button>
                          <ScrollArea className="h-[160px] border bg-muted/30 p-3 pr-12">
                            <pre className="whitespace-pre-wrap text-xs font-mono">
                              {codeContent}
                            </pre>
                          </ScrollArea>
                        </div>
                      </AccordionContent>
                    </AccordionItem>
                    <AccordionItem value="output">
                      <AccordionTrigger>Output</AccordionTrigger>
                      <AccordionContent>
                        <div className="relative">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="absolute right-2 top-2 z-10 h-8 w-8 p-0"
                            onClick={() => void handleCopyText(outputContent)}
                          >
                            <Copy />
                          </Button>
                          <ScrollArea className="h-[160px] border bg-muted/30 p-3 pr-12">
                            <pre className="whitespace-pre-wrap text-xs font-mono">
                              {outputContent}
                            </pre>
                          </ScrollArea>
                        </div>
                      </AccordionContent>
                    </AccordionItem>
                    <AccordionItem value="stdout">
                      <AccordionTrigger>Stdout</AccordionTrigger>
                      <AccordionContent>
                        <div className="relative">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="absolute right-2 top-2 z-10 h-8 w-8 p-0"
                            onClick={() => void handleCopyText(stdoutContent)}
                          >
                            <Copy />
                          </Button>
                          <ScrollArea className="h-[160px] border bg-muted/30 p-3 pr-12">
                            <pre className="whitespace-pre-wrap text-xs font-mono">
                              {stdoutContent}
                            </pre>
                          </ScrollArea>
                        </div>
                      </AccordionContent>
                    </AccordionItem>
                    <AccordionItem value="stderr">
                      <AccordionTrigger>Stderr</AccordionTrigger>
                      <AccordionContent>
                        <div className="relative">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="absolute right-2 top-2 z-10 h-8 w-8 p-0"
                            onClick={() => void handleCopyText(stderrContent)}
                          >
                            <Copy />
                          </Button>
                          <ScrollArea className="h-[160px] border bg-muted/30 p-3 pr-12">
                            <pre className="whitespace-pre-wrap text-xs font-mono">
                              {stderrContent}
                            </pre>
                          </ScrollArea>
                        </div>
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
              This process has existing outputs. Restarting will overwrite prior
              stdout, stderr, and output unless you cancel.
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
