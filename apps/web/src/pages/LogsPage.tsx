import { ChevronDown, Pause, Play } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { apiFetchJson, buildUrl, errorMessageFrom } from "@/lib/api";
import {
  type LogEntry,
  type LogLevel,
  type LogType,
  logEntrySchema,
} from "@/lib/log-schema";
import { cn } from "@/lib/utils";

const logPageSchema = z.object({
  items: z.array(logEntrySchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});

interface LogFilters {
  query: string;
  level: LogLevel | "all";
  type: LogType | "all";
  moduleType: "adapter" | "environment" | "all";
  moduleId: string;
  executionId: string;
  dispatchId: string;
  toolId: string;
  phase: string;
}

const PAGE_LIMIT = 100;
const LIVE_CAP = 500;

const levelBadgeVariant = (level: LogLevel) => {
  if (level === "error" || level === "fatal") return "destructive" as const;
  if (level === "warn") return "secondary" as const;
  if (level === "info") return "default" as const;
  return "outline" as const;
};

const entryId = (entry: LogEntry) => `${entry.timestamp}:${entry.seq}`;

const formatTime = (timestamp: number) =>
  new Date(timestamp).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

const formatDate = (timestamp: number) =>
  new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });

const filterParams = (filters: LogFilters) => ({
  query: filters.query.trim().length > 0 ? filters.query.trim() : undefined,
  level: filters.level === "all" ? undefined : filters.level,
  type: filters.type === "all" ? undefined : filters.type,
  moduleId:
    filters.moduleId.trim().length > 0 ? filters.moduleId.trim() : undefined,
  executionId:
    filters.executionId.trim().length > 0
      ? filters.executionId.trim()
      : undefined,
  toolId: filters.toolId.trim().length > 0 ? filters.toolId.trim() : undefined,
  dispatchId:
    filters.dispatchId.trim().length > 0
      ? filters.dispatchId.trim()
      : undefined,
  phase: filters.phase.trim().length > 0 ? filters.phase.trim() : undefined,
});

export default function LogsPage() {
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState<LogLevel | "all">("all");
  const [type, setType] = useState<LogType | "all">("all");
  const [moduleId, setModuleId] = useState("");
  const [executionId, setExecutionId] = useState("");
  const [dispatchId, setDispatchId] = useState("");
  const [toolId, setToolId] = useState("");
  const [phase, setPhase] = useState("");
  const [moduleType, setModuleType] = useState<
    "adapter" | "environment" | "all"
  >("all");
  const [history, setHistory] = useState<LogEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rawLive, setRawLive] = useState<LogEntry[]>([]);
  const [follow, setFollow] = useState(true);
  const [isLive, setIsLive] = useState(false);
  const [selected, setSelected] = useState<LogEntry | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const loadAbortRef = useRef<AbortController | null>(null);
  const paginationVersionRef = useRef(0);

  const filters = useMemo<LogFilters>(
    () => ({
      query,
      level,
      type,
      moduleType,
      moduleId,
      executionId,
      dispatchId,
      toolId,
      phase,
    }),
    [
      query,
      level,
      type,
      moduleType,
      moduleId,
      executionId,
      dispatchId,
      toolId,
      phase,
    ],
  );

  const matches = useCallback(
    (entry: LogEntry) => {
      if (filters.level !== "all" && entry.level !== filters.level)
        return false;
      if (filters.type !== "all" && entry.type !== filters.type) return false;
      const needle = filters.query.trim().toLowerCase();
      if (needle.length > 0 && !entry.message.toLowerCase().includes(needle)) {
        return false;
      }
      const moduleNeedle = filters.moduleId.trim().toLowerCase();
      if (moduleNeedle.length > 0) {
        if (
          entry.moduleId === undefined ||
          !entry.moduleId.toLowerCase().includes(moduleNeedle)
        )
          return false;
      }
      const execNeedle = filters.executionId.trim();
      if (execNeedle.length > 0) {
        if (
          entry.executionId === undefined ||
          String(entry.executionId) !== execNeedle
        )
          return false;
      }
      const toolNeedle = filters.toolId.trim().toLowerCase();
      if (toolNeedle.length > 0) {
        if (
          entry.toolId === undefined ||
          !entry.toolId.toLowerCase().includes(toolNeedle)
        )
          return false;
      }
      if (filters.moduleType !== "all") {
        if (entry.moduleType !== filters.moduleType) return false;
      }
      const dispatchNeedle = filters.dispatchId.trim().toLowerCase();
      if (dispatchNeedle.length > 0) {
        if (
          entry.dispatchId === undefined ||
          !entry.dispatchId.toLowerCase().includes(dispatchNeedle)
        )
          return false;
      }
      const phaseNeedle = filters.phase.trim().toLowerCase();
      if (phaseNeedle.length > 0) {
        if (
          entry.phase === undefined ||
          !entry.phase.toLowerCase().includes(phaseNeedle)
        )
          return false;
      }
      return true;
    },
    [filters],
  );

  const loadFirstPage = useCallback(async () => {
    loadAbortRef.current?.abort();
    paginationVersionRef.current += 1;
    const controller = new AbortController();
    loadAbortRef.current = controller;
    setHistory([]);
    setNextCursor(null);
    try {
      const data = await apiFetchJson(
        buildUrl("/logs", {
          ...filterParams(filters),
          limit: String(PAGE_LIMIT),
        }),
        logPageSchema,
        { signal: controller.signal },
      );
      setHistory(data.items);
      setNextCursor(data.nextCursor);
      setLoadError(null);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setLoadError(errorMessageFrom(error, "Failed to load logs."));
    }
  }, [filters]);

  useEffect(() => {
    const timeout = setTimeout(() => {
      void loadFirstPage();
    }, 300);
    return () => {
      clearTimeout(timeout);
      loadAbortRef.current?.abort();
    };
  }, [loadFirstPage]);

  useEffect(() => {
    const source = new EventSource(buildUrl("/logs/stream"));
    source.onopen = () => setIsLive(true);
    source.onerror = () => setIsLive(false);
    source.addEventListener("log", (event) => {
      try {
        const parsed = logEntrySchema.parse(
          JSON.parse((event as MessageEvent<string>).data),
        );
        setRawLive((previous) => [parsed, ...previous].slice(0, LIVE_CAP));
      } catch {
        // Malformed frames are ignored; the API query remains the source of truth.
      }
    });
    return () => {
      setIsLive(false);
      source.close();
    };
  }, []);

  const live = useMemo(() => rawLive.filter(matches), [rawLive, matches]);

  const entries = useMemo(() => {
    const seen = new Set<string>();
    const merged: LogEntry[] = [];
    for (const entry of [...live, ...history]) {
      const id = entryId(entry);
      if (seen.has(id)) continue;
      seen.add(id);
      merged.push(entry);
    }
    return merged;
  }, [live, history]);

  const lastLiveRef = useRef(0);

  useEffect(() => {
    if (live.length === lastLiveRef.current) return;
    lastLiveRef.current = live.length;
    if (follow && scrollRef.current !== null) {
      scrollRef.current.scrollTop = 0;
    }
  }, [live, follow]);

  const loadOlder = async () => {
    if (nextCursor === null || isLoadingMore) return;
    const startedVersion = paginationVersionRef.current;
    setIsLoadingMore(true);
    try {
      const data = await apiFetchJson(
        buildUrl("/logs", {
          ...filterParams(filters),
          cursor: nextCursor,
          limit: String(PAGE_LIMIT),
        }),
        logPageSchema,
      );
      if (paginationVersionRef.current !== startedVersion) return;
      setHistory((previous) => [...previous, ...data.items]);
      setNextCursor(data.nextCursor);
      setLoadError(null);
    } catch (error) {
      if (paginationVersionRef.current !== startedVersion) return;
      setLoadError(errorMessageFrom(error, "Failed to load older logs."));
    } finally {
      setIsLoadingMore(false);
    }
  };

  return (
    <>
      <section className="flex min-h-0 flex-1 flex-col gap-6 p-6">
        <header className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-1">
              <h1 className="text-xl font-semibold">Logs</h1>
              <p className="text-muted-foreground text-sm">
                Live and historical log entries from the API.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "flex items-center gap-2 text-sm",
                  isLive ? "text-emerald-500" : "text-muted-foreground",
                )}
                aria-live="polite"
              >
                <span
                  className={cn(
                    "size-2 rounded-full",
                    isLive ? "bg-emerald-500" : "bg-muted",
                  )}
                />
                {isLive ? "Live" : "Offline"}
              </span>
              <Button
                type="button"
                variant="outline"
                className="gap-2"
                onClick={() => setFollow((current) => !current)}
                aria-label={follow ? "Pause following" : "Resume following"}
              >
                {follow ? <Pause /> : <Play />}
                {follow ? "Pause" : "Follow"}
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex flex-1 items-center gap-2">
              <Input
                placeholder="Filter by message"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <Select
              onValueChange={(value) => setLevel(value as LogLevel | "all")}
              value={level}
            >
              <SelectTrigger className="w-[140px]">
                <SelectValue placeholder="Level" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All levels</SelectItem>
                {(
                  ["trace", "debug", "info", "warn", "error", "fatal"] as const
                ).map((item) => (
                  <SelectItem key={item} value={item}>
                    {item}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              onValueChange={(value) => setType(value as LogType | "all")}
              value={type}
            >
              <SelectTrigger className="w-[130px]">
                <SelectValue placeholder="Type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                <SelectItem value="app">App</SelectItem>
                <SelectItem value="request">Request</SelectItem>
                <SelectItem value="module">Module</SelectItem>
              </SelectContent>
            </Select>
            <Select
              onValueChange={(value) =>
                setModuleType(value as "adapter" | "environment" | "all")
              }
              value={moduleType}
            >
              <SelectTrigger className="w-[150px]">
                <SelectValue placeholder="Module type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All module types</SelectItem>
                <SelectItem value="adapter">Adapter</SelectItem>
                <SelectItem value="environment">Environment</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Input
              placeholder="Module ID"
              value={moduleId}
              onChange={(event) => setModuleId(event.target.value)}
              className="min-w-[10rem] flex-1"
            />
            <Input
              placeholder="Execution ID"
              value={executionId}
              onChange={(event) => setExecutionId(event.target.value)}
              className="w-[10rem]"
            />
            <Input
              placeholder="Tool ID"
              value={toolId}
              onChange={(event) => setToolId(event.target.value)}
              className="w-[10rem]"
            />
            <Input
              placeholder="Dispatch ID"
              value={dispatchId}
              onChange={(event) => setDispatchId(event.target.value)}
              className="w-[10rem]"
            />
            <Input
              placeholder="Phase"
              value={phase}
              onChange={(event) => setPhase(event.target.value)}
              className="w-[10rem]"
            />
          </div>
        </header>
        <Card className="flex min-h-0 flex-1 flex-col">
          <CardHeader className="flex w-full flex-row items-center justify-between">
            <CardTitle>Entries</CardTitle>
            <div className="w-max px-2 bg-muted border-1 border-border">
              {entries.length} shown
            </div>
          </CardHeader>
          <CardContent className="min-h-0 flex-1">
            <div ref={scrollRef} className="h-full overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead>
                    <TableHead>Level</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Message</TableHead>
                    <TableHead>Request / Process</TableHead>
                    <TableHead className="text-right">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.map((entry) => (
                    <TableRow
                      key={entryId(entry)}
                      className="cursor-pointer"
                      tabIndex={0}
                      aria-label={`Open entry ${entryId(entry)}`}
                      onClick={() => setSelected(entry)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setSelected(entry);
                        }
                      }}
                    >
                      <TableCell className="font-mono text-xs whitespace-nowrap">
                        <span className="text-muted-foreground">
                          {formatDate(entry.timestamp)}{" "}
                        </span>
                        {formatTime(entry.timestamp)}
                      </TableCell>
                      <TableCell>
                        <Badge variant={levelBadgeVariant(entry.level)}>
                          {entry.level}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs">{entry.type}</TableCell>
                      <TableCell className="max-w-[28rem]">
                        <div className="truncate font-mono text-xs">
                          {entry.event ? (
                            <span className="text-muted-foreground">
                              [{entry.event}]{" "}
                            </span>
                          ) : null}
                          {entry.message}
                        </div>
                      </TableCell>
                      <TableCell className="max-w-[14rem] font-mono text-xs">
                        {entry.requestId ? (
                          <span title={entry.requestId}>
                            {entry.requestId.slice(0, 8)}
                          </span>
                        ) : entry.processId !== undefined ? (
                          <span>proc {String(entry.processId)}</span>
                        ) : entry.dispatchId !== undefined ? (
                          <span title={entry.dispatchId}>
                            dispatch {entry.dispatchId.slice(0, 8)}
                          </span>
                        ) : entry.executionId !== undefined ? (
                          <span>exec {String(entry.executionId)}</span>
                        ) : entry.moduleId !== undefined ? (
                          <span
                            className="flex flex-wrap items-center gap-1"
                            title={entry.moduleId}
                          >
                            {entry.moduleType ? (
                              <Badge
                                variant="outline"
                                className="px-1 py-0 text-[10px]"
                              >
                                {entry.moduleType}
                              </Badge>
                            ) : null}
                            <span>module {entry.moduleId.slice(0, 8)}</span>
                            {entry.phase ? (
                              <span className="text-muted-foreground">
                                · {entry.phase}
                              </span>
                            ) : null}
                          </span>
                        ) : entry.statusCode !== undefined ? (
                          <span>{entry.method ?? ""}</span>
                        ) : (
                          <span className="text-muted-foreground">: </span>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {entry.statusCode !== undefined ? (
                          <span
                            className={cn(
                              entry.statusCode >= 500 && "text-destructive",
                              entry.statusCode >= 400 &&
                                entry.statusCode < 500 &&
                                "text-amber-500",
                            )}
                          >
                            {entry.statusCode}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">: </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {entries.length === 0 && loadError === null ? (
                <p className="p-4 text-sm text-muted-foreground">
                  No log entries match the current filters.
                </p>
              ) : null}
              {loadError !== null ? (
                <p className="p-4 text-sm text-destructive">{loadError}</p>
              ) : null}
              {nextCursor !== null ? (
                <div className="flex justify-center p-4">
                  <Button
                    type="button"
                    variant="outline"
                    className="gap-2"
                    disabled={isLoadingMore}
                    onClick={() => void loadOlder()}
                  >
                    <ChevronDown />
                    {isLoadingMore ? "Loading older…" : "Load older"}
                  </Button>
                </div>
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
              {selected ? `${entryId(selected)} · ${selected.level}` : ""}
            </DialogTitle>
          </DialogHeader>
          <div className="rounded border bg-muted/30 overflow-hidden">
            <div className="max-h-[60vh] min-h-[200px] overflow-auto p-4">
              <div className="whitespace-pre text-xs font-mono">
                {selected !== null ? JSON.stringify(selected, null, 2) : ""}
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
