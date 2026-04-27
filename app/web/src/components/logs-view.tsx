import { format } from "date-fns";
import {
  Calendar as CalendarIcon,
  Clock3,
  LoaderCircle,
  Play,
  Search,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

type LogSeverity = "trace" | "debug" | "info" | "warn" | "error" | "fatal";
type LogAction = "get" | "delete";

type StoredLog = {
  id: number;
  timestampMs: number;
  severity: LogSeverity;
  level: number;
  message: string;
  requestMethod: string | null;
  requestPath: string | null;
  statusCode: number | null;
};

type LogListResponse = {
  logs?: StoredLog[];
};

type DeleteResponse = {
  deleted?: number;
};

type LogsViewProps = {
  apiBaseUrl: string;
  apiKey: string;
};

const SEVERITY_OPTIONS: Array<{ label: string; value: "all" | LogSeverity }> = [
  { label: "All severities", value: "all" },
  { label: "Trace", value: "trace" },
  { label: "Debug", value: "debug" },
  { label: "Info", value: "info" },
  { label: "Warn", value: "warn" },
  { label: "Error", value: "error" },
  { label: "Fatal", value: "fatal" },
];

function getSeverityVariant(
  severity: LogSeverity,
): "secondary" | "destructive" | "outline" {
  if (severity === "fatal" || severity === "error") {
    return "destructive";
  }

  if (severity === "warn") {
    return "outline";
  }

  return "secondary";
}

function formatTimestamp(timestampMs: number): string {
  if (!Number.isFinite(timestampMs)) {
    return "-";
  }

  return new Date(timestampMs).toLocaleString();
}

function toStartOfDayMs(date: Date | undefined): number | undefined {
  if (!date) {
    return undefined;
  }

  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    0,
    0,
    0,
    0,
  ).getTime();
}

function toEndOfDayMs(date: Date | undefined): number | undefined {
  if (!date) {
    return undefined;
  }

  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    23,
    59,
    59,
    999,
  ).getTime();
}

function safeParseInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return parsed;
}

export function LogsView({ apiBaseUrl, apiKey }: LogsViewProps) {
  const [action, setAction] = useState<LogAction>("get");
  const [query, setQuery] = useState("");
  const [severity, setSeverity] = useState<"all" | LogSeverity>("all");
  const [fromDate, setFromDate] = useState<Date | undefined>(undefined);
  const [toDate, setToDate] = useState<Date | undefined>(undefined);
  const [limit, setLimit] = useState("100");
  const [offset, setOffset] = useState("0");

  const [isRunning, setIsRunning] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [logs, setLogs] = useState<StoredLog[]>([]);
  const [deleted, setDeleted] = useState<number | null>(null);
  const [lastRunAt, setLastRunAt] = useState<number | null>(null);

  const hasApiKey = useMemo(() => {
    return (
      apiKey.trim().length > 0 &&
      !apiKey.startsWith("Configure VITE_MCI_API_KEY")
    );
  }, [apiKey]);

  function getHeaders(): Headers {
    const headers = new Headers();

    if (hasApiKey) {
      headers.set("Authorization", `Bearer ${apiKey}`);
    }

    return headers;
  }

  async function parseError(response: Response): Promise<string> {
    try {
      const payload = (await response.json()) as { error?: string };

      if (typeof payload.error === "string" && payload.error.trim()) {
        return payload.error;
      }
    } catch {}

    return `Request failed (${response.status}).`;
  }

  function buildGetParams(): URLSearchParams {
    const params = new URLSearchParams();
    const normalizedQuery = query.trim();
    const fromMs = toStartOfDayMs(fromDate);
    const toMs = toEndOfDayMs(toDate);

    if (normalizedQuery) {
      params.set("query", normalizedQuery);
    }

    if (severity !== "all") {
      params.set("severity", severity);
    }

    if (fromMs !== undefined) {
      params.set("from", `${fromMs}`);
    }

    if (toMs !== undefined) {
      params.set("to", `${toMs}`);
    }

    params.set(
      "limit",
      `${Math.max(1, Math.min(1000, safeParseInt(limit, 100)))}`,
    );
    params.set("offset", `${Math.max(0, safeParseInt(offset, 0))}`);

    return params;
  }

  async function runGet(): Promise<void> {
    const params = buildGetParams();
    const url = `${apiBaseUrl}/logs?${params.toString()}`;
    const response = await fetch(url, {
      method: "GET",
      headers: getHeaders(),
    });

    if (!response.ok) {
      throw new Error(await parseError(response));
    }

    const payload = (await response.json()) as LogListResponse;

    setLogs(Array.isArray(payload.logs) ? payload.logs : []);
    setDeleted(null);
  }

  async function runDelete(): Promise<void> {
    const normalizedQuery = query.trim();

    if (!normalizedQuery) {
      throw new Error("Delete requires a non-empty query.");
    }

    const params = new URLSearchParams();
    params.set("query", normalizedQuery);

    const deleteResponse = await fetch(
      `${apiBaseUrl}/logs?${params.toString()}`,
      {
        method: "DELETE",
        headers: getHeaders(),
      },
    );

    if (!deleteResponse.ok) {
      throw new Error(await parseError(deleteResponse));
    }

    const payload = (await deleteResponse.json()) as DeleteResponse;
    setDeleted(Number(payload.deleted ?? 0));

    await runGet();
  }

  async function handleRun(): Promise<void> {
    setIsRunning(true);
    setErrorMessage("");

    try {
      if (action === "get") {
        await runGet();
      } else {
        await runDelete();
      }

      setLastRunAt(Date.now());
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Unexpected error.",
      );
    } finally {
      setIsRunning(false);
    }
  }

  function clearResults(): void {
    setLogs([]);
    setDeleted(null);
    setErrorMessage("");
    setLastRunAt(null);
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-7xl flex-col gap-4 p-4 lg:p-6">
      <Card className="border-border bg-card shadow-sm">
        <CardHeader className="gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="text-base font-semibold">
              Logs & Analytics
            </CardTitle>
            <div className="flex items-center gap-2">
              {!hasApiKey ? (
                <Badge variant="destructive">API key missing</Badge>
              ) : null}
              {lastRunAt ? (
                <Badge variant="secondary" className="gap-1">
                  <Clock3 className="size-3" />
                  {new Date(lastRunAt).toLocaleTimeString()}
                </Badge>
              ) : null}
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="flex flex-nowrap items-end gap-3 overflow-x-auto">
            <div className="min-w-72 space-y-2">
              <Label htmlFor="log-query">Query</Label>
              <Input
                id="log-query"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Enter search query"
                value={query}
              />
            </div>

            <div className="min-w-44 space-y-2">
              <Label htmlFor="log-severity">Severity</Label>
              <Select
                onValueChange={(value) =>
                  setSeverity(value as "all" | LogSeverity)
                }
                value={severity}
              >
                <SelectTrigger className="w-full" id="log-severity">
                  <SelectValue placeholder="All severities" />
                </SelectTrigger>
                <SelectContent>
                  {SEVERITY_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="min-w-48 space-y-2">
              <Label htmlFor="log-from">From</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    className="w-full justify-start text-left font-normal data-[empty=true]:text-muted-foreground"
                    data-empty={!fromDate}
                    id="log-from"
                    variant="outline"
                  >
                    <CalendarIcon className="size-4" />
                    {fromDate ? (
                      format(fromDate, "PPP")
                    ) : (
                      <span>Pick from date</span>
                    )}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0">
                  <Calendar
                    mode="single"
                    onSelect={setFromDate}
                    selected={fromDate}
                  />
                </PopoverContent>
              </Popover>
            </div>

            <div className="min-w-48 space-y-2">
              <Label htmlFor="log-to">To</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    className="w-full justify-start text-left font-normal data-[empty=true]:text-muted-foreground"
                    data-empty={!toDate}
                    id="log-to"
                    variant="outline"
                  >
                    <CalendarIcon className="size-4" />
                    {toDate ? format(toDate, "PPP") : <span>Pick to date</span>}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0">
                  <Calendar
                    mode="single"
                    onSelect={setToDate}
                    selected={toDate}
                  />
                </PopoverContent>
              </Popover>
            </div>

            <div className="min-w-24 space-y-2">
              <Label htmlFor="log-limit">Limit</Label>
              <Input
                id="log-limit"
                min={1}
                onChange={(event) => setLimit(event.target.value)}
                step={1}
                type="number"
                value={limit}
              />
            </div>

            <div className="min-w-24 space-y-2">
              <Label htmlFor="log-offset">Offset</Label>
              <Input
                id="log-offset"
                min={0}
                onChange={(event) => setOffset(event.target.value)}
                step={1}
                type="number"
                value={offset}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="flex min-h-0 flex-1 flex-col border-border/60 shadow-sm">
        <CardHeader>
          <div className="flex items-center gap-2">
            <div>
              <Tabs
                value={action}
                onValueChange={(value) => setAction(value as LogAction)}
              >
                <TabsList className="w-full">
                  <TabsTrigger className="px-4 gap-2" value="get">
                    <Search className="size-3.5" />
                    Get
                  </TabsTrigger>
                  <TabsTrigger className="px-4 gap-2" value="delete">
                    <Trash2 className="size-3.5" />
                    Delete
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </div>

            <div className="ml-auto flex min-w-fit items-end gap-2">
              <Button
                className="px-3 gap-3"
                disabled={isRunning}
                onClick={() => void handleRun()}
              >
                {isRunning ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <Play className="size-4" />
                )}
                Run
              </Button>
            </div>
            <Button
              aria-label="Clear query results"
              onClick={clearResults}
              type="button"
              variant="outline"
            >
              <Trash2 className="size-4" />
            </Button>
          </div>

          {errorMessage ? (
            <div className="flex items-center gap-2 border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              <ShieldAlert className="size-4" />
              <span>{errorMessage}</span>
            </div>
          ) : null}

          {deleted !== null ? (
            <div className="border border-border bg-muted/40 px-3 py-2 text-xs">
              Deleted <span className="font-semibold">{deleted}</span> log(s)
              matching query “{query.trim()}”.
            </div>
          ) : null}
        </CardHeader>

        <Separator />

        <CardContent className="min-h-0 flex-1 p-0">
          {logs.length === 0 ? (
            <div className="text-muted-foreground flex h-full min-h-56 items-center justify-center p-6 text-sm">
              Run a query to load logs.
            </div>
          ) : (
            <ScrollArea className="h-[50vh] min-h-56">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-44">Timestamp</TableHead>
                    <TableHead className="w-20">Severity</TableHead>
                    <TableHead className="w-16">Code</TableHead>
                    <TableHead className="w-20">Method</TableHead>
                    <TableHead className="w-52">Path</TableHead>
                    <TableHead>Message</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {logs.map((log) => (
                    <TableRow key={log.id}>
                      <TableCell className="text-muted-foreground">
                        {formatTimestamp(log.timestampMs)}
                      </TableCell>
                      <TableCell>
                        <Badge
                          className="uppercase"
                          variant={getSeverityVariant(log.severity)}
                        >
                          {log.severity}
                        </Badge>
                      </TableCell>
                      <TableCell>{log.statusCode ?? "-"}</TableCell>
                      <TableCell>{log.requestMethod ?? "-"}</TableCell>
                      <TableCell className="max-w-52 truncate">
                        {log.requestPath ?? "-"}
                      </TableCell>
                      <TableCell className="max-w-xl whitespace-normal break-words">
                        {log.message || "-"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
