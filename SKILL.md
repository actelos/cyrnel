---
name: cyrnel
description: >
  Use this skill whenever you have access to Cyrnel via MCP i.e., whenever
  the user's task involves invoking external services, running processes,
  chaining tool calls, or orchestrating workflows through the Cyrnel.
  Always trigger this skill at the start of any session where Cyrnel MCP tools
  are available, before writing any process code. Also use it when the user
  asks you to "run a tool", "create a process", "invoke a service", or
  "chain multiple steps together". Do NOT skip this skill just because a Cyrnel
  task seems simple, the runtime syntax is environment-dependent and must
  always be looked up first.
---

# Cyrnel Skill

You have access to cyrnel via the MCP server. Cyrnel lets you discover,
orchestrate, and invoke tools exposed by external services — all through a
secure sandboxed runtime. Follow this guide precisely.

## 1. Discovery — Read Before You Write

The execution environment is **not fixed**. Language, globals, and calling
conventions depend on which environment module is active. Never assume syntax.

**Before writing any process code:**

1. **`get_environment_docs`** — Call this once at the start of every session.
   It returns the runtime language, available globals, I/O conventions, and a
   worked example. This is your source of truth for code syntax.
2. **`list_tools`** — Search for tools relevant to your task. Always pass a
   targeted `query` and a low `limit` (5–10). Do not list all tools.
3. **`get_tool_docs`** — Call this only for the specific tools you intend to
   invoke. It returns parameter schemas, return shapes, and a copy-pasteable
   invocation snippet in the active environment's syntax.

Do not call `get_tool_docs` for tools you are not going to use. Do not call
`get_environment_docs` more than once per session.

### Query phrasing for `list_tools`

Tool search is a hybrid FTS5 + vector index, not substring matching. The
following phrasing rules are backed by measurement against the real registry:

- **Phrase queries naturally** — write what you mean ("create a new issue",
  "send an email to the user"). Word order, stopwords, and singular/plural
  forms do not matter: `"issue create"`, `"issues"`, and
  `"create a new issue in the repository"` all find `issues_create`.
- **Do not try to match tool names literally** — the index searches names,
  summaries, and descriptions. Query `"starred repos"` and get
  `activity_list_repos_starred_by_user`; never guess endpoint names.
- **Use vocabulary the tool's description would use** — indexed text is the
  match target. A synonym that never appears in the corpus may miss (e.g.
  `"branch rules"` does not find `repos_get_branch_protection`). If a query
  returns nothing relevant, rephrase with different words before concluding
  the tool does not exist.
- **Prefer distinctive words over ambiguous ones** — `"billing"` or
  `"protection"` rank the right tool first; `"email"` or `"issue"` alone are
  too broad to make the top 5.
- **Avoid typos** — neither FTS5 nor the embedding model tolerate them; a
  misspelled query silently returns unrelated results.

## 2. Execution — One Process, Many Calls

When a task requires multiple tool invocations, **chain them inside a single
process**. Do not create separate processes for each step. Do not round-trip
back to the LLM between invocations.

**Anti-pattern (wasteful):**

```
create_process → call Tool A → read output → create_process → call Tool B
```

**Correct pattern:**

```
create_process with code that calls Tool A then Tool B sequentially
```

Conceptual pseudo-code (actual syntax comes from `get_environment_docs`):

```
data = invoke service_a.tool_x(params)
result = invoke service_b.tool_y({ input: data.field })
output({ status: "done", result: result })
```

**Error handling:** Wrap tool invocations in try/catch when you need to handle
failures gracefully. Uncaught errors mark the process as `failed`.

## 3. Output Filtering — Return Only What You Need

This is the most important optimization. Large raw API responses will bloat
your context and degrade your reasoning. **Filter aggressively.**

### 3a. Filter inside your code

Do not pass raw API responses to the output. Extract only the fields you need.

```
// BAD — dumps the entire API response into your context
records = invoke crm.listContacts({ limit: 100 })
output({ records: records })

// GOOD — extracts only what matters
records = invoke crm.listContacts({ limit: 100 })
active = records.filter(r => r.status == "active")
output({ count: active.length, emails: active.map(r => r.email) })
```

Use the sandbox runtime for all data transformation: filtering, mapping,
sorting, aggregating, string formatting. The runtime is fast and free. Your
context window is not.

### 3b. Filter at the process level

`with_stdout` and `with_stderr` default to `false`. Do not change them unless
you are debugging a failure.

- `with_output: true` (default) — this is your structured result. Keep it on.
- `with_stdout` / `with_stderr` — set to `true` only when a process fails and
  you need to inspect logs. Alternatively, call `get_process_stderr` or
  `get_process_stdout` after the fact for just that process.

## 4. Process Reuse

If you need to re-run the same logic (e.g. a repeated check or retry):

1. Create the process once with a descriptive `ref` (e.g. `"daily-report"`).
2. On subsequent runs, use `run_process` with the process `id` and
   `force: true` instead of re-submitting the entire code string.

This saves significant context — a process ID is a single integer versus
potentially hundreds of lines of code.

## 5. Blocking vs Non-Blocking

- **`block: true`** (default): The response waits until execution completes
  and includes results inline. Use this when you need the output to continue
  your task.
- **`block: false`**: The response returns immediately with just the process
  ID. Use this for long-running operations where you can check back later
  with `get_process_output`.

For tasks with timeouts, set a reasonable `timeout` value in seconds. The
default is 30 seconds.

## Quick Reference

| Step | Tool | When |
|---|---|---|
| Learn the runtime | `get_environment_docs` | Once per session |
| Find tools | `list_tools` | Natural-language `query` + low `limit` |
| Read tool schemas | `get_tool_docs` | Per tool you will invoke |
| Execute code | `create_process` | First run of a script |
| Re-run code | `run_process` | Subsequent runs (use `force: true`) |
| Debug failures | `get_process_stderr` | Only on failed processes |
| Read results | `get_process_output` | For non-blocking runs |

## Checklist

Before submitting a process:

- [ ] Read `get_environment_docs` for correct syntax
- [ ] Read `get_tool_docs` for every tool you call
- [ ] Chain all invocations in a single process
- [ ] Filter output to only the fields you need
- [ ] Leave `with_stdout` and `with_stderr` at their defaults (`false`) — only enable when debugging
- [ ] Use `ref` for processes you may re-run
