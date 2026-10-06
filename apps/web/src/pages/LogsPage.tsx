import { format } from "date-fns";
import {
  CalendarIcon,
  ChevronDown,
  Pause,
  Play,
  RotateCcw,
  ScrollText,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DateRange } from "react-day-picker";
import { useSearchParams } from "react-router";
import { z } from "zod";
import { DetailViewDialog } from "@/components/detail-view";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useNotification } from "@/hooks/use-notification";
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
  from: Date | undefined;
  to: Date | undefined;
}

const PAGE_LIMIT = 100;
const LIVE_CAP = 500;

const getDatePresets = (now = new Date()) =>
  [
    {
      label: "Last hour",
      value: { from: new Date(now.getTime() - 60 * 60 * 1000), to: now },
    },
    {
      label: "Last 24 hours",
      value: { from: new Date(now.getTime() - 24 * 60 * 60 * 1000), to: now },
    },
    {
      label: "Last 7 days",
      value: {
        from: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
        to: now,
      },
    },
    {
      label: "Last 30 days",
      value: {
        from: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
        to: now,
      },
    },
    {
      label: "This week",
      value: {
        from: new Date(
          now.getFullYear(),
          now.getMonth(),
          now.getDate() - now.getDay(),
        ),
        to: now,
      },
    },
    {
      label: "This month",
      value: { from: new Date(now.getFullYear(), now.getMonth(), 1), to: now },
    },
  ] as const;

const levelBadgeClassName = (level: LogLevel) => {
  if (level === "fatal") return "bg-destructive text-destructive-foreground";
  if (level === "error") return "bg-error text-error-foreground";
  if (level === "warn") return "bg-warning text-warning-foreground";
  if (level === "info") return "bg-info text-info-foreground";
  if (level === "trace") return "bg-secondary text-secondary-foreground";
  if (level === "debug") return "bg-foreground text-background";
  return "";
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
  from: filters.from ? filters.from.getTime() : undefined,
  to: filters.to ? filters.to.getTime() : undefined,
});

const LOG_LEVELS: ReadonlySet<string> = new Set([
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
  "all",
]);

const LOG_TYPES: ReadonlySet<string> = new Set([
  "app",
  "request",
  "module",
  "all",
]);

const LOG_MODULE_TYPES: ReadonlySet<string> = new Set([
  "adapter",
  "environment",
  "all",
]);

function parseDateParam(raw: string | null): Date | undefined {
  if (raw === null || raw.trim().length === 0) return undefined;
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return undefined;
  const date = new Date(numeric);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function getInitialFilters(searchParams: URLSearchParams): LogFilters {
  const levelRaw = searchParams.get("level");
  const typeRaw = searchParams.get("type");
  const moduleTypeRaw = searchParams.get("moduleType");
  return {
    query: searchParams.get("q") ?? "",
    level: (levelRaw !== null && LOG_LEVELS.has(levelRaw) ? levelRaw : "all") as
      | LogLevel
      | "all",
    type: (typeRaw !== null && LOG_TYPES.has(typeRaw) ? typeRaw : "all") as
      | LogType
      | "all",
    moduleType: (moduleTypeRaw !== null && LOG_MODULE_TYPES.has(moduleTypeRaw)
      ? moduleTypeRaw
      : "all") as "adapter" | "environment" | "all",
    moduleId: searchParams.get("moduleId") ?? "",
    executionId: searchParams.get("executionId") ?? "",
    dispatchId: searchParams.get("dispatchId") ?? "",
    toolId: searchParams.get("toolId") ?? "",
    phase: searchParams.get("phase") ?? "",
    from: parseDateParam(searchParams.get("from")),
    to: parseDateParam(searchParams.get("to")),
  };
}

function getInitialFollow(searchParams: URLSearchParams): boolean {
  const follow = searchParams.get("follow");
  return follow !== "false";
}

export default function LogsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { addNotification } = useNotification();

  const initialFilters = useMemo(
    () => getInitialFilters(searchParams),
    [searchParams],
  );
  const initialFollow = useMemo(
    () => getInitialFollow(searchParams),
    [searchParams],
  );

  const [query, setQuery] = useState(initialFilters.query);
  const [level, setLevel] = useState<LogLevel | "all">(initialFilters.level);
  const [type, setType] = useState<LogType | "all">(initialFilters.type);
  const [moduleId, setModuleId] = useState(initialFilters.moduleId);
  const [executionId, setExecutionId] = useState(initialFilters.executionId);
  const [dispatchId, setDispatchId] = useState(initialFilters.dispatchId);
  const [toolId, setToolId] = useState(initialFilters.toolId);
  const [phase, setPhase] = useState(initialFilters.phase);
  const [moduleType, setModuleType] = useState<
    "adapter" | "environment" | "all"
  >(initialFilters.moduleType);
  const [from, setFrom] = useState(initialFilters.from);
  const [to, setTo] = useState(initialFilters.to);
  const [showAdvanced, setShowAdvanced] = useState(
    () =>
      initialFilters.moduleType !== "all" ||
      initialFilters.moduleId.trim().length > 0 ||
      initialFilters.executionId.trim().length > 0 ||
      initialFilters.dispatchId.trim().length > 0 ||
      initialFilters.toolId.trim().length > 0 ||
      initialFilters.phase.trim().length > 0,
  );
  const [history, setHistory] = useState<LogEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [rawLive, setRawLive] = useState<LogEntry[]>([]);
  const [follow, setFollow] = useState(initialFollow);
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
      from,
      to,
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
      from,
      to,
    ],
  );

  const activeAdvancedCount = useMemo(() => {
    let count = 0;
    if (moduleType !== "all") count += 1;
    if (moduleId.trim()) count += 1;
    if (executionId.trim()) count += 1;
    if (dispatchId.trim()) count += 1;
    if (toolId.trim()) count += 1;
    if (phase.trim()) count += 1;
    return count;
  }, [moduleType, moduleId, executionId, dispatchId, toolId, phase]);

  const clearAdvanced = useCallback(() => {
    setModuleType("all");
    setModuleId("");
    setExecutionId("");
    setDispatchId("");
    setToolId("");
    setPhase("");
  }, []);

  const updateUrl = useCallback(() => {
    const params = new URLSearchParams();
    if (query.trim()) params.set("q", query.trim());
    if (level !== "all") params.set("level", level);
    if (type !== "all") params.set("type", type);
    if (moduleType !== "all") params.set("moduleType", moduleType);
    if (moduleId.trim()) params.set("moduleId", moduleId.trim());
    if (executionId.trim()) params.set("executionId", executionId.trim());
    if (dispatchId.trim()) params.set("dispatchId", dispatchId.trim());
    if (toolId.trim()) params.set("toolId", toolId.trim());
    if (phase.trim()) params.set("phase", phase.trim());
    if (from) params.set("from", String(from.getTime()));
    if (to) params.set("to", String(to.getTime()));
    if (!follow) params.set("follow", "false");
    setSearchParams(params, { replace: true });
  }, [
    query,
    level,
    type,
    moduleType,
    moduleId,
    executionId,
    dispatchId,
    toolId,
    phase,
    from,
    to,
    follow,
    setSearchParams,
  ]);

  useEffect(() => {
    updateUrl();
  }, [updateUrl]);

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

  const loadFirstPage = useCallback(async (): Promise<boolean> => {
    loadAbortRef.current?.abort();
    paginationVersionRef.current += 1;
    const controller = new AbortController();
    loadAbortRef.current = controller;
    setHistory([]);
    setNextCursor(null);
    setIsLoading(true);
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
      return true;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError")
        return false;
      setLoadError(errorMessageFrom(error, "Failed to load logs."));
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [filters]);

  const handleManualRefresh = useCallback(async () => {
    const ok = await loadFirstPage();
    if (ok) {
      addNotification({
        type: "success",
        title: "Logs refreshed",
        message: "Logs refreshed.",
      });
    } else {
      addNotification({
        type: "error",
        title: "Refresh logs failed",
        message: "Failed to refresh logs.",
      });
    }
  }, [loadFirstPage, addNotification]);

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
    source.addEventListener("log", (event) => {
      try {
        const parsed = logEntrySchema.parse(
          JSON.parse((event as MessageEvent<string>).data),
        );
        setRawLive((previous) => [parsed, ...previous].slice(0, LIVE_CAP));
      } catch {}
    });
    return () => {
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
      const message = errorMessageFrom(error, "Failed to load older logs.");
      setLoadError(message);
      addNotification({
        type: "error",
        title: "Load older logs failed",
        message,
      });
    } finally {
      setIsLoadingMore(false);
    }
  };

  return (
    <>
      <section className="flex h-svh flex-col px-6 pb-6">
        <header className="sticky top-0 z-20 -mx-6 flex flex-col gap-4 border-b bg-background px-6 py-4 mb-6">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="space-y-1">
              <h1 className="text-xl font-semibold">Logs</h1>
              <p className="text-muted-foreground text-sm">
                Live and historical log entries from the API.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                className="gap-2"
                onClick={() => void handleManualRefresh()}
                aria-label="Refresh logs"
              >
                <RotateCcw />
              </Button>
              <Button
                type="button"
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
            <div className="flex min-w-[12rem] flex-1 items-center gap-2">
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
            <Field className="w-60">
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    id="date-picker-range"
                    className="justify-start px-2.5 font-normal w-full"
                  >
                    <CalendarIcon data-icon="inline-start" />
                    {from || to ? (
                      <>
                        {from ? format(from, "LLL dd, y") : ""}{" "}
                        {from && to && "- "} {to ? format(to, "LLL dd, y") : ""}
                      </>
                    ) : (
                      <span>Pick a date</span>
                    )}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="end">
                  <div className="flex p-2">
                    <div className="border-r pr-2 max-w-60">
                      {getDatePresets().map((preset) => (
                        <Button
                          key={preset.label}
                          variant="ghost"
                          className="w-full justify-start gap-2 px-3 py-1.5 text-sm"
                          onClick={() => {
                            const fresh = getDatePresets().find(
                              (item) => item.label === preset.label,
                            );
                            setFrom(fresh?.value.from ?? preset.value.from);
                            setTo(fresh?.value.to ?? preset.value.to);
                          }}
                        >
                          {preset.label}
                        </Button>
                      ))}
                      {(from || to) && (
                        <Button
                          variant="ghost"
                          className="w-full justify-start gap-2 px-3 py-1.5 text-sm text-destructive"
                          onClick={() => {
                            setFrom(undefined);
                            setTo(undefined);
                          }}
                        >
                          Clear
                        </Button>
                      )}
                    </div>
                    <div className="pl-2">
                      <Calendar
                        mode="range"
                        defaultMonth={from}
                        selected={{ from, to } as DateRange}
                        onSelect={(range) => {
                          setFrom(range.from ?? undefined);
                          setTo(range.to ?? undefined);
                        }}
                        numberOfMonths={2}
                      />
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
            </Field>
            <Button
              type="button"
              variant="outline"
              className="gap-2"
              aria-expanded={showAdvanced}
              aria-controls="advanced-log-filters"
              onClick={() => setShowAdvanced((current) => !current)}
            >
              Advanced
              {activeAdvancedCount > 0 ? (
                <Badge variant="secondary">{activeAdvancedCount}</Badge>
              ) : null}
              <ChevronDown
                className={cn(
                  "size-4 transition-transform",
                  showAdvanced && "rotate-180",
                )}
              />
            </Button>
          </div>
          {showAdvanced ? (
            <div
              id="advanced-log-filters"
              className="flex flex-wrap items-center gap-3"
            >
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
              {activeAdvancedCount > 0 ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="text-destructive"
                  onClick={clearAdvanced}
                >
                  Clear advanced
                </Button>
              ) : null}
            </div>
          ) : null}
        </header>

        <div
          ref={scrollRef}
          className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden [&_[data-slot='table-container']]:overflow-visible"
        >
          {isLoading ? (
            <div className="flex items-center justify-center h-full py-12">
              <p className="text-sm text-muted-foreground">Loading logs…</p>
            </div>
          ) : entries.length === 0 && loadError === null ? (
            <div className="flex items-center justify-center h-full py-12">
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <ScrollText aria-hidden />
                  </EmptyMedia>
                  <EmptyTitle>No log entries found</EmptyTitle>
                  <EmptyDescription>
                    No log entries match the current filters.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            </div>
          ) : (
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-background">
                <TableRow>
                  <TableHead className="w-[150px]">Time</TableHead>
                  <TableHead className="w-[70px]">Level</TableHead>
                  <TableHead className="w-[70px]">Type</TableHead>
                  <TableHead>Message</TableHead>
                  <TableHead className="w-[40px] text-right">Status</TableHead>
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
                    <TableCell className="whitespace-nowrap font-mono text-xs">
                      <span className="text-muted-foreground">
                        {formatDate(entry.timestamp)}{" "}
                      </span>
                      {formatTime(entry.timestamp)}
                    </TableCell>

                    <TableCell>
                      <Badge className={levelBadgeClassName(entry.level)}>
                        {entry.level}
                      </Badge>
                    </TableCell>

                    <TableCell className="text-xs">{entry.type}</TableCell>

                    <TableCell className="min-w-0">
                      <div className="min-w-0 truncate font-mono text-xs">
                        {entry.event ? (
                          <span className="text-muted-foreground">
                            [{entry.event}]{" "}
                          </span>
                        ) : null}
                        {entry.message}
                      </div>
                    </TableCell>

                    <TableCell className="text-right font-mono text-xs">
                      {entry.statusCode !== undefined ? (
                        <span
                          className={cn(
                            entry.statusCode >= 500 && "text-destructive",
                            entry.statusCode >= 400 &&
                              entry.statusCode < 500 &&
                              "text-warning",
                          )}
                        >
                          {entry.statusCode}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
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
      </section>

      <DetailViewDialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        title={selected ? entryId(selected) : ""}
        content={selected !== null ? JSON.stringify(selected, null, 2) : ""}
        variant="code"
        language="json"
      />
    </>
  );
}
