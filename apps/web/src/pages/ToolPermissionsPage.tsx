import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  GripVertical,
  Pencil,
  Plus,
  Shield,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { z } from "zod";
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
  Empty,
  EmptyContent,
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useNotification } from "@/hooks/use-notification";
import { apiFetch, apiFetchJson, buildUrl, errorMessageFrom } from "@/lib/api";

const decisionSchema = z.enum(["allow", "block", "ask"]);

type Decision = z.infer<typeof decisionSchema>;

const IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const policySchema = z.object({
  decision: decisionSchema,
  updatedAt: z.number().nullable(),
  source: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("rule"),
      ruleId: z.string(),
      servicePattern: z.string(),
      toolPattern: z.string(),
      position: z.number(),
    }),
    z.object({ type: z.literal("default") }),
  ]),
});

const ruleSchema = z.object({
  id: z.string(),
  servicePattern: z.string(),
  toolPattern: z.string(),
  decision: decisionSchema,
  position: z.number(),
  createdAt: z.string(),
  updatedAt: z.number(),
});

const rulesSchema = z.array(ruleSchema);

type Rule = z.infer<typeof ruleSchema>;

const affectedToolSchema = z.object({
  serviceId: z.string(),
  toolId: z.string(),
  name: z.string().catch(""),
  policy: policySchema,
});

const affectedPageSchema = z.object({
  items: z.array(affectedToolSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});

type AffectedTool = z.infer<typeof affectedToolSchema>;

const previewSchema = z.object({
  matchCount: z.number(),
  items: z.array(affectedToolSchema),
});

const POLICY_CONSEQUENCES: Record<Decision, string> = {
  allow: "Allow — invocation proceeds automatically.",
  ask: "Ask — invocation requires approval before it can run.",
  block: "Block — invocation is rejected.",
};

function decisionBadgeVariant(decision: Decision) {
  if (decision === "allow") return "default" as const;
  if (decision === "block") return "destructive" as const;
  return "secondary" as const;
}

function DecisionBadge({ decision }: { decision: Decision }) {
  return <Badge variant={decisionBadgeVariant(decision)}>{decision}</Badge>;
}

/** Presentation-only dotted form. The API always transports the two patterns separately. */
function formatPattern(rule: Pick<Rule, "servicePattern" | "toolPattern">) {
  return `${rule.servicePattern}.${rule.toolPattern}`;
}

function isPatternSide(value: string): boolean {
  return value === "*" || IDENTIFIER_PATTERN.test(value);
}

export interface ParsedPattern {
  servicePattern: string;
  toolPattern: string;
}

/**
 * Parse a full pattern textbox value: `*` (global) or
 * `servicePattern.toolPattern` (e.g. `github.*`, `*.search`).
 */
function parseFullPattern(raw: string): ParsedPattern | null {
  const trimmed = raw.trim();
  if (trimmed === "*") return { servicePattern: "*", toolPattern: "*" };
  const dot = trimmed.indexOf(".");
  if (dot === -1 || trimmed.indexOf(".", dot + 1) !== -1) return null;
  const servicePattern = trimmed.slice(0, dot).trim();
  const toolPattern = trimmed.slice(dot + 1).trim();
  if (!isPatternSide(servicePattern) || !isPatternSide(toolPattern)) {
    return null;
  }
  return { servicePattern, toolPattern };
}

function PatternChips({
  servicePattern,
  toolPattern,
}: Pick<Rule, "servicePattern" | "toolPattern">) {
  return (
    <span className="inline-flex items-center gap-1 font-mono text-xs">
      <Badge variant="outline">{servicePattern}</Badge>
      <span className="text-muted-foreground">.</span>
      <Badge variant="outline">{toolPattern}</Badge>
    </span>
  );
}

type RuleFormErrors = Partial<Record<"pattern" | "decision" | "form", string>>;

/**
 * Single pattern textbox + decision form with live match preview.
 * Used by both the create popover and the per-row edit popover.
 */
function PatternRuleForm({
  idPrefix,
  initialPattern,
  initialDecision,
  submitLabel,
  patternLocked,
  onSubmit,
}: {
  idPrefix: string;
  initialPattern: string;
  initialDecision: Decision;
  submitLabel: string;
  patternLocked?: boolean;
  onSubmit: (parsed: ParsedPattern, decision: Decision) => Promise<void>;
}) {
  const [pattern, setPattern] = useState(initialPattern);
  const [decision, setDecision] = useState<Decision>(initialDecision);
  const [errors, setErrors] = useState<RuleFormErrors>({});
  const [isSaving, setIsSaving] = useState(false);
  const [matchCount, setMatchCount] = useState<number | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);

  const parsed = parseFullPattern(pattern);
  const previewServicePattern = parsed?.servicePattern;
  const previewToolPattern = parsed?.toolPattern;
  const isCatchAll =
    previewServicePattern === "*" && previewToolPattern === "*";

  useEffect(() => {
    if (
      previewServicePattern === undefined ||
      previewToolPattern === undefined
    ) {
      setMatchCount(null);
      setIsPreviewLoading(false);
      return;
    }
    setIsPreviewLoading(true);
    const timer = setTimeout(() => {
      apiFetchJson(
        buildUrl("/tool-policies/preview", {
          servicePattern: previewServicePattern,
          toolPattern: previewToolPattern,
          limit: "1",
        }),
        previewSchema,
      )
        .then((preview) => setMatchCount(preview.matchCount))
        .catch(() => setMatchCount(null))
        .finally(() => setIsPreviewLoading(false));
    }, 300);
    return () => clearTimeout(timer);
  }, [previewServicePattern, previewToolPattern]);

  const handleSubmit = async () => {
    const nextErrors: RuleFormErrors = {};
    const nextParsed = parseFullPattern(pattern);
    if (nextParsed === null) {
      nextErrors.pattern =
        'Use "*" or servicePattern.toolPattern (e.g. github.*, *.search). Each side must be "*" or a valid id.';
    }
    if (decisionSchema.safeParse(decision).success === false) {
      nextErrors.decision = "Decision must be allow, block, or ask.";
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0 || nextParsed === null) return;

    setIsSaving(true);
    try {
      await onSubmit(nextParsed, decision);
    } catch (error) {
      setErrors({
        form: errorMessageFrom(error, "Unable to save rule."),
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex items-baseline justify-between gap-2">
          <Label htmlFor={`${idPrefix}-pattern`}>Pattern</Label>
          <span className="text-xs text-muted-foreground">
            {isPreviewLoading
              ? "Checking…"
              : matchCount === null
                ? null
                : `${matchCount} tool${matchCount === 1 ? "" : "s"} match${matchCount === 1 ? "es" : ""}`}
          </span>
        </div>
        {patternLocked ? (
          <p className="font-mono text-sm">{pattern}</p>
        ) : (
          <Input
            id={`${idPrefix}-pattern`}
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            placeholder="github.*"
            className="font-mono"
          />
        )}
        {patternLocked ? null : (
          <p className="text-xs text-muted-foreground">
            `*` matches everything, `github.*` a whole service, `*.search` a
            tool everywhere.
          </p>
        )}
        {errors.pattern ? (
          <p className="text-xs text-destructive">{errors.pattern}</p>
        ) : null}
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-decision`}>Decision</Label>
        <Select
          value={decision}
          onValueChange={(value) => setDecision(value as Decision)}
        >
          <SelectTrigger id={`${idPrefix}-decision`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="allow">allow</SelectItem>
            <SelectItem value="ask">ask</SelectItem>
            <SelectItem value="block">block</SelectItem>
          </SelectContent>
        </Select>
        {errors.decision ? (
          <p className="text-xs text-destructive">{errors.decision}</p>
        ) : null}
      </div>
      {!isPreviewLoading && matchCount !== null && isCatchAll ? (
        <p className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
          <TriangleAlert size={14} />
          This catch-all matches every tool.
        </p>
      ) : null}
      {errors.form ? (
        <p className="text-sm text-destructive">{errors.form}</p>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          disabled={isSaving}
          onClick={() => void handleSubmit()}
        >
          {isSaving ? "Saving…" : submitLabel}
        </Button>
      </div>
    </div>
  );
}

function RuleAffectedTools({ rule }: { rule: Rule }) {
  const [tools, setTools] = useState<AffectedTool[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    apiFetchJson(
      buildUrl(`/tool-policies/${encodeURIComponent(rule.id)}/affected-tools`, {
        limit: "50",
      }),
      affectedPageSchema,
    )
      .then((page) => {
        if (cancelled) return;
        setTools(page.items);
        setNextCursor(page.nextCursor);
      })
      .catch((fetchError) => {
        if (cancelled) return;
        setError(errorMessageFrom(fetchError, "Failed to load tools."));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [rule.id]);

  const loadMore = async () => {
    if (nextCursor === null || isLoadingMore) return;
    setIsLoadingMore(true);
    try {
      const page = await apiFetchJson(
        buildUrl(
          `/tool-policies/${encodeURIComponent(rule.id)}/affected-tools`,
          { limit: "50", cursor: nextCursor },
        ),
        affectedPageSchema,
      );
      setTools((previous) => [...previous, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (fetchError) {
      setError(errorMessageFrom(fetchError, "Failed to load more tools."));
    } finally {
      setIsLoadingMore(false);
    }
  };

  if (isLoading) {
    return (
      <p className="px-4 py-6 text-center text-sm text-muted-foreground">
        Loading affected tools…
      </p>
    );
  }

  if (error) {
    return <p className="p-4 text-sm text-destructive">{error}</p>;
  }

  if (tools.length === 0) {
    return (
      <div className="flex items-center justify-center px-4 py-6">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Shield aria-hidden />
            </EmptyMedia>
            <EmptyTitle>No tools match</EmptyTitle>
            <EmptyDescription>
              No installed tool matches {formatPattern(rule)} right now. The
              rule still applies to tools installed later.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  return (
    <div className="space-y-2 px-4 py-2">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Tool</TableHead>
            <TableHead>Effective</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tools.map((tool) => (
            <TableRow key={`${tool.serviceId}:${tool.toolId}`}>
              <TableCell className="font-mono text-xs">
                {tool.serviceId}.{tool.toolId}
                {tool.name ? (
                  <span className="block font-sans text-muted-foreground">
                    {tool.name}
                  </span>
                ) : null}
              </TableCell>
              <TableCell>
                <DecisionBadge decision={tool.policy.decision} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {nextCursor !== null ? (
        <div className="flex justify-center pt-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isLoadingMore}
            onClick={() => void loadMore()}
          >
            {isLoadingMore ? "Loading…" : "Load more"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function SortableRuleRow({
  rule,
  isFirst,
  isLast,
  isExpanded,
  isReordering,
  onMove,
  onSavedEdit,
  onDelete,
  onToggleExpand,
}: {
  rule: Rule;
  isFirst: boolean;
  isLast: boolean;
  isExpanded: boolean;
  isReordering: boolean;
  onMove: (direction: -1 | 1) => void;
  onSavedEdit: () => void;
  onDelete: () => void;
  onToggleExpand: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: rule.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : undefined,
  };
  const { mutate } = useSWRConfig();
  const { addNotification } = useNotification();
  const [isEditOpen, setIsEditOpen] = useState(false);
  const isCatchAll = rule.servicePattern === "*" && rule.toolPattern === "*";

  const handleEditSubmit = async (
    parsed: ParsedPattern,
    decision: Decision,
  ) => {
    try {
      await apiFetch(
        buildUrl(`/tool-policies/${encodeURIComponent(rule.id)}`),
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...parsed, decision }),
        },
      );
      await mutate(buildUrl("/tool-policies"));
      addNotification({
        type: "success",
        title: "Rule updated",
        message: `${formatPattern(parsed)} → ${decision}. ${POLICY_CONSEQUENCES[decision]}`,
      });
      setIsEditOpen(false);
      onSavedEdit();
    } catch (error) {
      const message = errorMessageFrom(error, "Unable to save rule.");
      addNotification({ type: "error", title: "Save failed", message });
      throw error;
    }
  };

  return (
    <>
      <TableRow ref={setNodeRef} style={style}>
        <TableCell className="w-10">
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="cursor-grab touch-none text-muted-foreground hover:text-foreground"
              aria-label={`Drag rule ${formatPattern(rule)} to reorder`}
              {...attributes}
              {...listeners}
            >
              <GripVertical size={16} />
            </button>
            <span className="font-mono text-xs text-muted-foreground">
              {rule.position}
            </span>
          </div>
        </TableCell>
        <TableCell>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onToggleExpand}
              aria-expanded={isExpanded}
              aria-label={`${isExpanded ? "Collapse" : "Expand"} tools affected by ${formatPattern(rule)}`}
              className="inline-flex items-center text-muted-foreground hover:text-foreground"
            >
              {isExpanded ? (
                <ChevronDown size={16} />
              ) : (
                <ChevronRight size={16} />
              )}
            </button>
            <PatternChips
              servicePattern={rule.servicePattern}
              toolPattern={rule.toolPattern}
            />
            {isCatchAll ? (
              <span
                className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400"
                title="This rule matches every tool and shadows all rules below it."
              >
                <TriangleAlert size={14} />
                Matches everything
              </span>
            ) : null}
          </div>
        </TableCell>
        <TableCell>
          <DecisionBadge decision={rule.decision} />
        </TableCell>
        <TableCell className="text-right">
          <div className="flex items-center justify-end gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={isFirst || isReordering}
              onClick={() => onMove(-1)}
              aria-label={`Move rule ${formatPattern(rule)} up`}
            >
              <ArrowUp />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={isLast || isReordering}
              onClick={() => onMove(1)}
              aria-label={`Move rule ${formatPattern(rule)} down`}
            >
              <ArrowDown />
            </Button>
            <Popover open={isEditOpen} onOpenChange={setIsEditOpen}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Edit rule ${formatPattern(rule)}`}
                >
                  <Pencil />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-[26rem]">
                <div className="space-y-4">
                  <div className="space-y-1">
                    <h3 className="text-sm font-medium">Edit policy rule</h3>
                    <p className="text-muted-foreground text-xs">
                      Change a permission rule's decision
                    </p>
                  </div>
                  {isEditOpen ? (
                    <PatternRuleForm
                      key={rule.id}
                      idPrefix={`edit-rule-${rule.id}`}
                      initialPattern={formatPattern(rule)}
                      initialDecision={rule.decision}
                      submitLabel="Save changes"
                      patternLocked
                      onSubmit={handleEditSubmit}
                    />
                  ) : null}
                </div>
              </PopoverContent>
            </Popover>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={onDelete}
              aria-label={`Delete rule ${formatPattern(rule)}`}
            >
              <Trash2 />
            </Button>
          </div>
        </TableCell>
      </TableRow>
      {isExpanded ? (
        <TableRow key={`${rule.id}-affected`}>
          <TableCell colSpan={4} className="bg-muted/30 p-0">
            <RuleAffectedTools key={rule.id} rule={rule} />
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}

export default function ToolPermissionsPage() {
  const { addNotification } = useNotification();

  const rulesUrl = useMemo(() => buildUrl("/tool-policies"), []);
  const {
    data: rulesData,
    error: rulesError,
    isLoading: isLoadingRules,
    mutate: mutateRules,
  } = useSWR(rulesUrl, (url) => apiFetchJson(url, rulesSchema));

  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null);
  const [isReordering, setIsReordering] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const rules = useMemo(() => {
    if (!rulesData) return [];
    if (!pendingOrder) return rulesData;
    const rank = new Map(pendingOrder.map((id, index) => [id, index]));
    return [...rulesData].sort(
      (a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0),
    );
  }, [rulesData, pendingOrder]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  const persistOrder = useCallback(
    async (orderedIds: string[]) => {
      setPendingOrder(orderedIds);
      setIsReordering(true);
      try {
        await apiFetch(buildUrl("/tool-policies/order"), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderedIds }),
        });
        setPendingOrder(null);
        await mutateRules();
      } catch (error) {
        setPendingOrder(null);
        addNotification({
          type: "error",
          title: "Reorder failed",
          message: errorMessageFrom(error, "Unable to reorder policy rules."),
        });
      } finally {
        setIsReordering(false);
      }
    },
    [addNotification, mutateRules],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const ids = rules.map((r) => r.id);
      const oldIndex = ids.indexOf(String(active.id));
      const newIndex = ids.indexOf(String(over.id));
      if (oldIndex === -1 || newIndex === -1) return;
      void persistOrder(arrayMove(ids, oldIndex, newIndex));
    },
    [persistOrder, rules],
  );

  const handleMove = useCallback(
    (id: string, direction: -1 | 1) => {
      const ids = rules.map((r) => r.id);
      const index = ids.indexOf(id);
      const target = index + direction;
      if (index === -1 || target < 0 || target >= ids.length) return;
      const next = [...ids];
      const moving = next[index];
      const displaced = next[target];
      if (moving === undefined || displaced === undefined) return;
      next[index] = displaced;
      next[target] = moving;
      void persistOrder(next);
    },
    [persistOrder, rules],
  );

  const [isCreateOpen, setIsCreateOpen] = useState(false);

  const handleCreateSubmit = async (
    parsed: ParsedPattern,
    decision: Decision,
  ) => {
    try {
      await apiFetch(buildUrl("/tool-policies"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...parsed, decision }),
      });
      await mutateRules();
      addNotification({
        type: "success",
        title: "Rule created",
        message: `${formatPattern(parsed)} → ${decision}. ${POLICY_CONSEQUENCES[decision]}`,
      });
      setIsCreateOpen(false);
    } catch (error) {
      const message = errorMessageFrom(error, "Unable to save rule.");
      addNotification({ type: "error", title: "Save failed", message });
      throw error;
    }
  };

  // Delete confirmation.
  const [deletingRule, setDeletingRule] = useState<Rule | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDeleteRule = async () => {
    if (!deletingRule) return;
    setIsDeleting(true);
    try {
      await apiFetch(
        buildUrl(`/tool-policies/${encodeURIComponent(deletingRule.id)}`),
        { method: "DELETE" },
      );
      setDeletingRule(null);
      if (expandedId === deletingRule.id) setExpandedId(null);
      await mutateRules();
      addNotification({
        type: "success",
        title: "Rule deleted",
        message: `${formatPattern(deletingRule)} removed.`,
      });
    } catch (error) {
      addNotification({
        type: "error",
        title: "Delete failed",
        message: errorMessageFrom(error, "Unable to delete rule."),
      });
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <section className="flex h-svh flex-col px-6 pb-6">
      <header className="sticky top-0 z-10 -mx-6 mb-6 flex flex-col gap-4 border-b bg-background px-6 py-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-xl font-semibold">Tool Permissions</h1>
            <p className="text-muted-foreground text-sm">
              Manage tool permission decisions (allow, ask, and block) rules.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Popover open={isCreateOpen} onOpenChange={setIsCreateOpen}>
              <PopoverTrigger asChild>
                <Button type="button" className="gap-2">
                  <Plus />
                  New rule
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-[26rem]">
                <div className="space-y-4">
                  <div className="space-y-1">
                    <h3 className="text-sm font-medium">New policy rule</h3>
                    <p className="text-muted-foreground text-xs">
                      Rules are appended at the lowest precedence (evaluated
                      last).
                    </p>
                  </div>
                  {isCreateOpen ? (
                    <PatternRuleForm
                      key="create"
                      idPrefix="create-rule"
                      initialPattern=""
                      initialDecision="allow"
                      submitLabel="Save rule"
                      onSubmit={handleCreateSubmit}
                    />
                  ) : null}
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto pb-6">
        {isLoadingRules && rules.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">
            Loading policy rules…
          </p>
        ) : rulesError ? (
          <p className="p-4 text-sm text-destructive">
            Failed to load policy rules.
          </p>
        ) : rules.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Shield aria-hidden />
                </EmptyMedia>
                <EmptyTitle>No policy rules yet</EmptyTitle>
                <EmptyDescription>
                  Every tool currently defaults to ask. Create a rule to allow
                  or block groups of tools.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button
                  type="button"
                  size="sm"
                  className="gap-2"
                  onClick={() => setIsCreateOpen(true)}
                >
                  <Plus />
                  New rule
                </Button>
              </EmptyContent>
            </Empty>
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={rules.map((r) => r.id)}
              strategy={verticalListSortingStrategy}
            >
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-background">
                  <TableRow>
                    <TableHead className="w-10">#</TableHead>
                    <TableHead>Pattern</TableHead>
                    <TableHead>Decision</TableHead>
                    <TableHead className="w-44 text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rules.map((rule, index) => (
                    <SortableRuleRow
                      key={rule.id}
                      rule={rule}
                      isFirst={index === 0}
                      isLast={index === rules.length - 1}
                      isExpanded={expandedId === rule.id}
                      isReordering={isReordering}
                      onMove={(direction) => handleMove(rule.id, direction)}
                      onSavedEdit={() => void mutateRules()}
                      onDelete={() => setDeletingRule(rule)}
                      onToggleExpand={() =>
                        setExpandedId((current) =>
                          current === rule.id ? null : rule.id,
                        )
                      }
                    />
                  ))}
                </TableBody>
              </Table>
            </SortableContext>
          </DndContext>
        )}
      </div>

      <AlertDialog
        open={deletingRule !== null}
        onOpenChange={(open) => {
          if (!open) setDeletingRule(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this rule?</AlertDialogTitle>
            <AlertDialogDescription>
              {deletingRule
                ? `${formatPattern(deletingRule)} → ${deletingRule.decision} will be removed. Tools it covered fall through to the next matching rule, or the ask default.`
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isDeleting}
              onClick={() => void handleDeleteRule()}
            >
              {isDeleting ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
