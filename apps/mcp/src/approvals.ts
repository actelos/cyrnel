import { HTTPError } from "ky";
import { z } from "zod";
import { api, searchParams } from "@/fetch.js";

const APPROVAL_PAGE_MAX_LIMIT = 100;

const approvalRow = z.object({
  id: z.string().min(1),
  serviceId: z.string(),
  toolId: z.string(),
  processId: z.number().nullish(),
  parameters: z.unknown().optional(),
  state: z.string().optional(),
  createdAt: z.string().nullish(),
  expiresAt: z.number().nullish(),
  decidedAt: z.number().nullish(),
});

const approvalPage = z.object({
  items: z.array(approvalRow),
  nextCursor: z.string().nullish(),
  hasMore: z.boolean().optional(),
});

export interface PendingApproval {
  id: string;
  serviceId: string;
  toolId: string;
  processId: number | null;
  parameters: unknown;
  state: string;
  createdAt: string | null;
  expiresAt: number | null;
  decidedAt: number | null;
}

export interface ApprovalPage {
  items: PendingApproval[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * Outcome of a decision attempt. `already-decided` and `not-found` are normal
 * races rather than failures: an approval can expire via the sweep, or be
 * resolved by another caller, between being read and being decided.
 */
export type DecisionOutcome = "decided" | "already-decided" | "not-found";

export async function listApprovals(options: {
  state?: "pending" | "approved" | "denied" | "expired";
  processId?: number;
  serviceId?: string;
  toolId?: string;
  limit?: number;
  cursor?: string;
}): Promise<ApprovalPage> {
  const body = await api
    .get("approvals", {
      searchParams: searchParams({
        state: options.state,
        processId: options.processId,
        serviceId: options.serviceId,
        toolId: options.toolId,
        limit: options.limit,
        cursor: options.cursor,
      }),
    })
    .json();
  const parsed = approvalPage.safeParse(body);
  if (!parsed.success) {
    throw new Error("API GET /approvals -> unexpected response shape.");
  }
  return {
    items: parsed.data.items.map((row) => ({
      id: row.id,
      serviceId: row.serviceId,
      toolId: row.toolId,
      processId: row.processId ?? null,
      parameters: row.parameters ?? {},
      state: row.state ?? "pending",
      createdAt: row.createdAt ?? null,
      expiresAt: row.expiresAt ?? null,
      decidedAt: row.decidedAt ?? null,
    })),
    nextCursor: parsed.data.nextCursor ?? null,
    hasMore: parsed.data.hasMore ?? false,
  };
}

export async function getApproval(id: string): Promise<PendingApproval> {
  const body = await api.get(`approvals/${encodeURIComponent(id)}`).json();
  const parsed = approvalRow.safeParse(body);
  if (!parsed.success) {
    throw new Error(`API GET /approvals/${id} -> unexpected response shape.`);
  }
  const row = parsed.data;
  return {
    id: row.id,
    serviceId: row.serviceId,
    toolId: row.toolId,
    processId: row.processId ?? null,
    parameters: row.parameters ?? {},
    state: row.state ?? "pending",
    createdAt: row.createdAt ?? null,
    expiresAt: row.expiresAt ?? null,
    decidedAt: row.decidedAt ?? null,
  };
}

/** Reads every pending approval for a process, following pagination. */
export async function listAllPendingApprovals(
  processId: number,
): Promise<PendingApproval[]> {
  const items: PendingApproval[] = [];
  let cursor: string | undefined;
  do {
    const page: ApprovalPage = await listApprovals({
      state: "pending",
      processId,
      limit: APPROVAL_PAGE_MAX_LIMIT,
      cursor,
    });
    items.push(...page.items);
    cursor = page.hasMore ? (page.nextCursor ?? undefined) : undefined;
  } while (cursor !== undefined);
  return items;
}

export async function decideApproval(
  id: string,
  decision: "approve" | "deny",
): Promise<DecisionOutcome> {
  try {
    await api
      .post(`approvals/${encodeURIComponent(id)}/${decision}`, { json: {} })
      .json();
    return "decided";
  } catch (err) {
    if (err instanceof HTTPError) {
      if (err.response.status === 409) return "already-decided";
      if (err.response.status === 404) return "not-found";
    }
    throw err;
  }
}

const SENSITIVE_KEY_PARTS = [
  "password",
  "passwd",
  "passphrase",
  "secret",
  "token",
  "apikey",
  "api_key",
  "api-key",
  "access_key",
  "access-key",
  "private_key",
  "private-key",
  "credential",
  "authorization",
  "cookie",
  "signature",
];

const MAX_DEPTH = 4;
const MAX_ARRAY_ITEMS = 10;
const MAX_OBJECT_KEYS = 25;
const MAX_STRING_LENGTH = 200;

export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

function redact(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return "...";
  if (Array.isArray(value)) {
    const head = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => redact(item, depth + 1));
    return value.length > MAX_ARRAY_ITEMS
      ? [...head, `... ${value.length - MAX_ARRAY_ITEMS} more`]
      : head;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const out: Record<string, unknown> = {};
    for (const [key, item] of entries.slice(0, MAX_OBJECT_KEYS)) {
      out[key] = isSensitiveKey(key)
        ? "***REDACTED***"
        : redact(item, depth + 1);
    }
    if (entries.length > MAX_OBJECT_KEYS) {
      out["..."] = `${entries.length - MAX_OBJECT_KEYS} more keys`;
    }
    return out;
  }
  if (typeof value === "string" && value.length > MAX_STRING_LENGTH) {
    return `${value.slice(0, MAX_STRING_LENGTH)}...`;
  }
  return value;
}

/**
 * Renders tool parameters for human review. Approval parameters are decrypted
 * server-side and can carry credentials, so this redacts secret-looking keys
 * and truncates before the values ever reach a client or the log.
 */
export function summarizeParameters(
  parameters: unknown,
  maxLength = 600,
): string {
  if (parameters === null || parameters === undefined) return "{}";
  let text: string;
  if (typeof parameters !== "object") {
    text = String(redact(parameters, 0));
  } else {
    try {
      text = JSON.stringify(redact(parameters, 0)) ?? "{}";
    } catch {
      return "[unserializable parameters]";
    }
  }
  return text.length > maxLength
    ? `${text.slice(0, maxLength)}... (truncated)`
    : text;
}
