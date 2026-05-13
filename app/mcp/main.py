from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Annotated, Any, Dict, Optional
from enum import Enum

import httpx
from fastmcp import FastMCP
from pydantic import Field

from mcp_types import (
    DiscoverRequest,
    DiscoverServicesResponse,
    DiscoverToolsResponse,
    JsonPatch,
    OkResponse,
    PatchServiceSecretsResponse,
    Process,
    ProcessCreatedResponse,
    ProcessListResponse,
    ProcessOutputResponse,
    ProcessState,
    ProcessStatusQuery,
    ServiceConfigurationResponse,
    ServiceConfigurationSchemaResponse,
    ServiceDetails,
    ServiceEnabledResponse,
    ServiceInstalledResponse,
    ServiceSecretsSchemaResponse,
    ServiceUpdatedResponse,
    ToolDetails,
    ToolEnabledResponse,
)

DEFAULT_API_URL = "http://localhost:7687"
DEFAULT_MCP_HTTP_HOST = "127.0.0.1"
DEFAULT_MCP_HTTP_PORT = 3333
DEFAULT_TIMEOUT_SECONDS = 30.0


@dataclass
class ApiConfig:
    base_url: str
    api_key: Optional[str]
    timeout_seconds: float


config = ApiConfig(
    base_url=os.getenv("MCI_API_URL", DEFAULT_API_URL).rstrip("/"),
    api_key=os.getenv("MCI_API_KEY"),
    timeout_seconds=float(os.getenv("MCI_API_TIMEOUT", str(DEFAULT_TIMEOUT_SECONDS))),
)

HTTP_HOST = os.getenv("MCP_HTTP_HOST", DEFAULT_MCP_HTTP_HOST)
HTTP_PORT = int(os.getenv("MCP_HTTP_PORT", str(DEFAULT_MCP_HTTP_PORT)))

mcp = FastMCP("mci-api")


def _add_optional(params: Dict[str, Any], key: str, value: Any) -> None:
    if value is not None:
        params[key] = value.value if isinstance(value, Enum) else value


def _add_bool_param(params: Dict[str, Any], key: str, value: Optional[bool]) -> None:
    if value is not None:
        params[key] = "true" if value else "false"


def _headers() -> Dict[str, str]:
    headers = {"Accept": "application/json"}
    if config.api_key:
        headers["Authorization"] = f"Bearer {config.api_key}"
    return headers


def _request(
    method: str,
    path: str,
    *,
    params: Optional[Dict[str, Any]] = None,
    json: Optional[Dict[str, Any]] = None,
    text_response: bool = False,
    expected_status: Optional[int] = None,
) -> Any:
    url = f"{config.base_url}{path}"
    with httpx.Client(timeout=config.timeout_seconds) as client:
        response = client.request(
            method,
            url,
            params=params,
            json=json,
            headers=_headers(),
        )

    if expected_status is not None and response.status_code != expected_status:
        raise RuntimeError(
            f"API request failed: {method} {path} -> {response.status_code}: {response.text}"
        )

    if text_response:
        return response.text

    if response.status_code == 204:
        return {"ok": True}

    try:
        return response.json()
    except Exception:
        return {"raw": response.text}


@mcp.tool(
    annotations={"readOnlyHint": True, "idempotentHint": True, "openWorldHint": True}
)
def list_processes(
    state: Annotated[
        ProcessState | None,
        Field(
            description=(
                "Optional process state filter. One of: idle, queued, running, terminating. "
                'Example: "idle".'
            )
        ),
    ] = None,
    status: Annotated[
        ProcessStatusQuery | None,
        Field(
            description=(
                "Optional process status filter. One of: success, failed, timeout, canceled, null. "
                'Use "null" to filter processes with no terminal status yet. Example: "success".'
            )
        ),
    ] = None,
    ref: Annotated[
        str | None,
        Field(
            description=(
                'Optional reference label filter (exact match after trimming). Example: "nightly-sync".'
            ),
            min_length=1,
        ),
    ] = None,
) -> ProcessListResponse:
    """List stored processes using optional state/status/ref filters, returning process records.

    Use this to browse existing processes or to find a pid to inspect with
    `get_process()`, `get_process_output()`, `get_process_stdout()`, or `get_process_stderr()`.

    When to use:
        - Use when you need to find processes by state/status/ref.
    When NOT to use:
        - If you already know the pid, call `get_process(pid)` instead.

    Args:
        state: Optional process state filter (e.g. "idle").
        status: Optional process terminal status filter (e.g. "success" or "null").
        ref: Optional reference label filter (e.g. "nightly-sync").

    Returns:
        Object with key `processes` (list of processes). Returns `processes=[]` when no matches.

    Raises:
        httpx.RequestError: If the API is unreachable (connection/DNS/TLS errors).
        httpx.TimeoutException: If the request exceeds the configured timeout.

    Example:
        list_processes(state="idle", status="null")
        → {"processes": [{"pid": 12, "ref": "nightly-sync", "state": "idle", "status": null}]}
    """
    params: Dict[str, Any] = {}
    _add_optional(params, "state", state)
    _add_optional(params, "status", status)
    _add_optional(params, "ref", ref)
    return _request("GET", "/processes", params=params)


@mcp.tool(
    annotations={"readOnlyHint": True, "idempotentHint": True, "openWorldHint": True}
)
def get_process(
    pid: Annotated[
        int, Field(description="Process id (positive integer). Example: 12.", ge=1)
    ],
) -> Process:
    """Fetch a single process record by pid, returning its state/status/ref.

    When to use:
        - Use when you already have a pid and need its current lifecycle metadata.
    When NOT to use:
        - If you need stdout/stderr/code/output, use the specific getter tools instead.

    Args:
        pid: Process id returned by `create_process` (e.g. 12).

    Returns:
        Process object with keys: `pid`, `ref` (optional), `state`, `status`.

    Raises:
        httpx.RequestError: If the API is unreachable (connection/DNS/TLS errors).
        httpx.TimeoutException: If the request exceeds the configured timeout.

    Example:
        get_process(12) → {"pid": 12, "ref": "demo", "state": "idle", "status": "success"}
    """
    return _request("GET", f"/processes/{pid}")


@mcp.tool(annotations={"idempotentHint": False, "openWorldHint": True})
def create_process(
    code: Annotated[
        str,
        Field(
            description=(
                "TypeScript source code to execute (plain text). Example: "
                "\"console.log('hello')\"."
            ),
            min_length=1,
        ),
    ],
    ref: Annotated[
        str | None,
        Field(
            description=(
                "Optional reference label to group processes. Must be non-empty after trimming. "
                'Example: "nightly-sync".'
            ),
            min_length=1,
        ),
    ] = None,
    timeout: Annotated[
        int | None,
        Field(
            description=(
                "Optional execution timeout in seconds (positive integer). "
                "This tool converts seconds to milliseconds for the API. Example: 30."
            ),
            ge=1,
        ),
    ] = None,
    block: Annotated[
        bool,
        Field(
            description=(
                "Whether to wait until the process becomes idle before returning. Example: true."
            )
        ),
    ] = True,
) -> ProcessCreatedResponse:
    """Create and optionally run a new process from TypeScript code, returning its pid.

    A process encapsulates runnable code executed by the MCI environment. If `block` is true,
    the API waits until the process returns to the `idle` state before responding.

    When to use:
        - Use to execute code that discovers services/tools or invokes them.
    When NOT to use:
        - If you want to re-run an existing idle process, use `run_process(pid, force=...)`.

    Args:
        code: TypeScript source code string (e.g. "console.log('hello')").
        ref: Optional reference label (e.g. "nightly-sync").
        timeout: Optional timeout in seconds (e.g. 30). Sent to the API as milliseconds.
        block: Whether to wait for the process to become idle (e.g. True).

    Returns:
        Object with key `pid` (positive integer).

    Raises:
        httpx.RequestError: If the API is unreachable (connection/DNS/TLS errors).
        httpx.TimeoutException: If the request exceeds the configured timeout.
        RuntimeError: If the API responds with a non-201 status code for creation.

    Example:
        create_process(\"console.log('hi')\", ref=\"demo\", timeout=10, block=True)
        → {"pid": 12}
    """
    payload: Dict[str, Any] = {"code": code, "block": block}
    _add_optional(payload, "ref", ref)
    if timeout is not None:
        payload["timeout"] = timeout * 1000
    return _request("POST", "/processes", json=payload, expected_status=201)


@mcp.tool(annotations={"destructiveHint": True, "openWorldHint": True})
def delete_process(
    pid: Annotated[
        int,
        Field(
            description="Process id to delete (positive integer). Example: 12.", ge=1
        ),
    ],
) -> Process:
    """Delete an idle process by pid, returning the deleted process record.

    Deletion removes the stored record and its associated outputs. The API requires
    the process to be `idle` before it can be deleted.

    When to use:
        - Use to clean up completed/idle processes you no longer need.
    When NOT to use:
        - If the process is running or queued, call `kill_process(pid)` first, then delete.

    Args:
        pid: Process id to delete (e.g. 12).

    Returns:
        Deleted process object with keys: `pid`, `ref` (optional), `state`, `status`.

    Raises:
        httpx.RequestError: If the API is unreachable (connection/DNS/TLS errors).
        httpx.TimeoutException: If the request exceeds the configured timeout.

    Example:
        delete_process(12) → {"pid": 12, "state": "idle", "status": "success"}
    """
    return _request("DELETE", f"/processes/{pid}")


@mcp.tool(
    annotations={"readOnlyHint": True, "idempotentHint": True, "openWorldHint": True}
)
def get_process_code(
    pid: Annotated[
        int, Field(description="Process id (positive integer). Example: 12.", ge=1)
    ],
) -> str:
    """Fetch the original submitted source code for a process, returning raw text.

    When to use:
        - Use to inspect what code was submitted to `create_process`.
    When NOT to use:
        - If you need runtime output, use `get_process_stdout`, `get_process_stderr`, or `get_process_output`.

    Args:
        pid: Process id (e.g. 12).

    Returns:
        Raw code string (text/plain). Returns an empty string only if the stored code is empty.

    Raises:
        httpx.RequestError: If the API is unreachable (connection/DNS/TLS errors).
        httpx.TimeoutException: If the request exceeds the configured timeout.

    Example:
        get_process_code(12) → "console.log('hello')\n"
    """
    return _request("GET", f"/processes/{pid}/code", text_response=True)


@mcp.tool(
    annotations={"readOnlyHint": True, "idempotentHint": True, "openWorldHint": True}
)
def get_process_output(
    pid: Annotated[
        int, Field(description="Process id (positive integer). Example: 12.", ge=1)
    ],
) -> ProcessOutputResponse:
    """Fetch the structured output object emitted by a process, returning JSON.

    This is distinct from stdout/stderr: it is structured data explicitly emitted by the
    process code. The API requires the process to be `idle` before output is available.

    When to use:
        - Use to read machine-readable results produced by a process.
    When NOT to use:
        - If you need text logs, use `get_process_stdout` / `get_process_stderr`.

    Args:
        pid: Process id (e.g. 12).

    Returns:
        JSON object with arbitrary keys/values (may be empty `{}`).

    Raises:
        httpx.RequestError: If the API is unreachable (connection/DNS/TLS errors).
        httpx.TimeoutException: If the request exceeds the configured timeout.

    Example:
        get_process_output(12) → {"result": 42, "metadata": {"service": "github"}}
    """
    return _request("GET", f"/processes/{pid}/output")


@mcp.tool(
    annotations={"readOnlyHint": True, "idempotentHint": True, "openWorldHint": True}
)
def get_process_stdout(
    pid: Annotated[
        int, Field(description="Process id (positive integer). Example: 12.", ge=1)
    ],
) -> str:
    """Fetch the captured stdout for an idle process, returning raw text.

    When to use:
        - Use to read standard output produced by the process execution.
    When NOT to use:
        - If you need structured data, use `get_process_output`.

    Args:
        pid: Process id (e.g. 12).

    Returns:
        Raw stdout string (text/plain). Returns an empty string if the process produced no stdout.

    Raises:
        httpx.RequestError: If the API is unreachable (connection/DNS/TLS errors).
        httpx.TimeoutException: If the request exceeds the configured timeout.

    Example:
        get_process_stdout(12) → "hello\\n"
    """
    return _request("GET", f"/processes/{pid}/stdout", text_response=True)


@mcp.tool(
    annotations={"readOnlyHint": True, "idempotentHint": True, "openWorldHint": True}
)
def get_process_stderr(
    pid: Annotated[
        int, Field(description="Process id (positive integer). Example: 12.", ge=1)
    ],
) -> str:
    """Fetch the captured stderr for an idle process, returning raw text.

    When to use:
        - Use to read standard error produced by the process execution.
    When NOT to use:
        - If you need structured data, use `get_process_output`.

    Args:
        pid: Process id (e.g. 12).

    Returns:
        Raw stderr string (text/plain). Returns an empty string if the process produced no stderr.

    Raises:
        httpx.RequestError: If the API is unreachable (connection/DNS/TLS errors).
        httpx.TimeoutException: If the request exceeds the configured timeout.

    Example:
        get_process_stderr(12) → "warning: ...\\n"
    """
    return _request("GET", f"/processes/{pid}/stderr", text_response=True)


@mcp.tool(annotations={"idempotentHint": False, "openWorldHint": True})
def run_process(
    pid: Annotated[
        int,
        Field(description="Process id to run (positive integer). Example: 12.", ge=1),
    ],
    force: Annotated[
        bool,
        Field(
            description=(
                "Whether to overwrite existing outputs before rerunning. "
                "Example: false."
            )
        ),
    ] = False,
    block: Annotated[
        bool,
        Field(
            description=(
                "Whether to wait until the process becomes idle before returning. Example: true."
            )
        ),
    ] = True,
) -> Process:
    """Run (or re-run) an idle process by pid, returning the resulting process record.

    The API only accepts a run signal when the process is currently `idle`. If `force` is false
    and the process has existing outputs, the API rejects the request.

    When to use:
        - Use to re-run a process you previously created.
    When NOT to use:
        - If you need to start a brand-new execution, use `create_process` instead.

    Args:
        pid: Process id to run (e.g. 12).
        force: Overwrite existing outputs before rerun (e.g. True).
        block: Wait for the process to return to `idle` before returning (e.g. True).

    Returns:
        Process object with keys: `pid`, `ref` (optional), `state`, `status`.

    Raises:
        httpx.RequestError: If the API is unreachable (connection/DNS/TLS errors).
        httpx.TimeoutException: If the request exceeds the configured timeout.

    Example:
        run_process(12, force=True, block=True) → {"pid": 12, "state": "idle", "status": "success"}
    """
    return _request(
        "POST",
        f"/processes/{pid}/signals/run",
        json={"force": force, "block": block},
    )


@mcp.tool(annotations={"idempotentHint": False, "openWorldHint": True})
def kill_process(
    pid: Annotated[
        int,
        Field(description="Process id to stop (positive integer). Example: 12.", ge=1),
    ],
) -> Process:
    """Stop a queued or running process by pid, returning the updated process record.

    When to use:
        - Use to cancel queued work or interrupt a running process.
    When NOT to use:
        - If the process is already idle and you want to remove it, use `delete_process` instead.

    Args:
        pid: Process id to stop (e.g. 12).

    Returns:
        Updated process object. If the process was queued, it may transition to `idle` with status `canceled`.

    Raises:
        httpx.RequestError: If the API is unreachable (connection/DNS/TLS errors).
        httpx.TimeoutException: If the request exceeds the configured timeout.

    Example:
        kill_process(12) → {"pid": 12, "state": "terminating", "status": null}
    """
    return _request("POST", f"/processes/{pid}/signals/kill", json={})


@mcp.tool(
    annotations={"readOnlyHint": True, "idempotentHint": True, "openWorldHint": True}
)
def discover_services(
    query: Annotated[
        str | None,
        Field(
            description=(
                "Optional search string to match service name/description. Whitespace is trimmed. "
                'Example: "github".'
            )
        ),
    ] = None,
    limit: Annotated[
        int | None,
        Field(
            description=(
                "Optional maximum number of results to return (positive integer). Example: 5."
            ),
            ge=1,
        ),
    ] = None,
    enabled: Annotated[
        bool | None,
        Field(
            description=(
                "Optional enabled filter. Example: true. "
                "Note: omitting this parameter uses the API default (commonly enabled-only)."
            )
        ),
    ] = None,
) -> DiscoverServicesResponse:
    """Discover installed services by query and filters, returning matching service summaries.

    This tool is read-only: it searches the manifest store and returns metadata for each match.

    When to use:
        - Use when you want to shortlist services by name/description.
    When NOT to use:
        - If you already know the exact service name, call `get_service(service_name)` instead.

    Args:
        query: Optional query string (e.g. "github").
        limit: Optional maximum number of results (e.g. 10).
        enabled: Optional enabled filter (e.g. True).

    Returns:
        Object with key `services` (list). Returns `services=[]` if there are no matches.

    Raises:
        httpx.RequestError: If the API is unreachable (connection/DNS/TLS errors).
        httpx.TimeoutException: If the request exceeds the configured timeout.

    Example:
        discover_services(query="git", limit=3, enabled=True)
        → {"services": [{"name":"github","type":"registry","source":"...","description":"...","hash":"...","enabled":true}]}
    """
    payload: Dict[str, Any] = {}
    _add_optional(payload, "query", query)
    _add_optional(payload, "limit", limit)
    _add_bool_param(payload, "enabled", enabled)
    return _request("POST", "/services/discover", json=payload)


@mcp.tool(
    annotations={"readOnlyHint": True, "idempotentHint": True, "openWorldHint": True}
)
def get_service(
    service_name: Annotated[
        str,
        Field(
            description='Exact service identifier (manifest id). Example: "github".',
            min_length=1,
        ),
    ],
) -> ServiceDetails:
    """Fetch a single service manifest by exact name, returning metadata and schemas.

    When to use:
        - Use when you already know the exact service name.
    When NOT to use:
        - If you only have a substring, call `discover_services(query=...)` first.

    Args:
        service_name: Exact service identifier (e.g. "github").

    Returns:
        Service details object with keys: `name`, `type`, `source`, `description`, `hash`,
        `enabled`, `configSchema`, `secretsSchema`.

    Raises:
        httpx.RequestError: If the API is unreachable (connection/DNS/TLS errors).
        httpx.TimeoutException: If the request exceeds the configured timeout.

    Example:
        get_service("github") → {"name":"github","type":"registry","source":"...","description":"...","hash":"...","enabled":false,"configSchema":{...},"secretsSchema":{...}}
    """
    return _request("GET", f"/services/{service_name}")


@mcp.tool(
    annotations={"readOnlyHint": True, "idempotentHint": True, "openWorldHint": True}
)
def get_service_configuration_schema(
    service_name: Annotated[
        str,
        Field(
            description='Exact service identifier (manifest id). Example: "github".',
            min_length=1,
        ),
    ],
) -> ServiceConfigurationSchemaResponse:
    """Fetch a service configuration JSON Schema by service name, returning `configSchema`.

    When to use:
        - Use to learn which configuration keys/values a service accepts.
    When NOT to use:
        - If you need current configured values, call `get_service_configuration` instead.

    Args:
        service_name: Exact service identifier (e.g. "github").

    Returns:
        Object with key `configSchema` (JSON Schema object).

    Raises:
        httpx.RequestError: If the API is unreachable (connection/DNS/TLS errors).
        httpx.TimeoutException: If the request exceeds the configured timeout.

    Example:
        get_service_configuration_schema("github") → {"configSchema": {"type":"object","properties":{...}}}
    """
    return _request("GET", f"/services/{service_name}/configuration/schema")


@mcp.tool(
    annotations={"readOnlyHint": True, "idempotentHint": True, "openWorldHint": True}
)
def get_service_configuration(
    service_name: Annotated[
        str,
        Field(
            description='Exact service identifier (manifest id). Example: "github".',
            min_length=1,
        ),
    ],
) -> ServiceConfigurationResponse:
    """Fetch the current service configuration by service name, returning `config`.

    When to use:
        - Use to inspect the currently stored configuration values.
    When NOT to use:
        - If you need the allowed shape/constraints, call `get_service_configuration_schema` instead.

    Args:
        service_name: Exact service identifier (e.g. "github").

    Returns:
        Object with key `config` (JSON object). Returns `{}` when no config is stored.

    Raises:
        httpx.RequestError: If the API is unreachable (connection/DNS/TLS errors).
        httpx.TimeoutException: If the request exceeds the configured timeout.

    Example:
        get_service_configuration("github") → {"config": {"token":"***","baseUrl":"https://api.github.com"}}
    """
    return _request("GET", f"/services/{service_name}/configuration")


@mcp.tool(annotations={"idempotentHint": False, "openWorldHint": True})
def patch_service_configuration(
    service_name: Annotated[
        str,
        Field(
            description='Exact service identifier (manifest id). Example: "github".',
            min_length=1,
        ),
    ],
    patch: Annotated[
        JsonPatch,
        Field(
            description=(
                "JSON Patch operation list to apply to the service configuration (RFC 6902 style). "
                'Example: [{"op":"add","path":"/enabled","value":true}].'
            )
        ),
    ],
) -> ServiceConfigurationResponse:
    """Patch a service configuration with JSON Patch operations, returning the updated `config`.

    This mutates stored configuration and may trigger downstream restaging behavior in the API.

    When to use:
        - Use to update one or more config keys without sending the entire object.
    When NOT to use:
        - If you only need to read config, use `get_service_configuration`.

    Args:
        service_name: Exact service identifier (e.g. "github").
        patch: JSON Patch operation list (e.g. [{"op":"replace","path":"/timeout","value":30}]).

    Returns:
        Object with key `config` containing the updated configuration object.

    Raises:
        httpx.RequestError: If the API is unreachable (connection/DNS/TLS errors).
        httpx.TimeoutException: If the request exceeds the configured timeout.

    Example:
        patch_service_configuration(\"github\", patch=[{\"op\":\"replace\",\"path\":\"/timeout\",\"value\":30}])
        → {"config": {"timeout": 30}}
    """
    return _request(
        "PATCH",
        f"/services/{service_name}/configuration",
        json=patch.model_dump(mode="json"),
    )


@mcp.tool(
    annotations={"readOnlyHint": True, "idempotentHint": True, "openWorldHint": True}
)
def get_service_secrets_schema(
    service_name: Annotated[
        str,
        Field(
            description='Exact service identifier (manifest id). Example: "github".',
            min_length=1,
        ),
    ],
) -> ServiceSecretsSchemaResponse:
    """Fetch a service secrets JSON Schema by service name, returning `secretsSchema`.

    When to use:
        - Use to learn which secret keys/values a service accepts.
    When NOT to use:
        - If you need to update secrets, call `patch_service_secrets` instead.

    Args:
        service_name: Exact service identifier (e.g. "github").

    Returns:
        Object with key `secretsSchema` (JSON Schema object).

    Raises:
        httpx.RequestError: If the API is unreachable (connection/DNS/TLS errors).
        httpx.TimeoutException: If the request exceeds the configured timeout.

    Example:
        get_service_secrets_schema("github") → {"secretsSchema": {"type":"object","properties":{...}}}
    """
    return _request("GET", f"/services/{service_name}/secrets/schema")


@mcp.tool(annotations={"idempotentHint": False, "openWorldHint": True})
def patch_service_secrets(
    service_name: Annotated[
        str,
        Field(
            description='Exact service identifier (manifest id). Example: "github".',
            min_length=1,
        ),
    ],
    patch: Annotated[
        JsonPatch,
        Field(
            description=(
                "JSON Patch operation list to apply to the service secrets payload (RFC 6902 style). "
                'Example: [{"op":"add","path":"/token","value":"ghp_..."}].'
            )
        ),
    ],
) -> PatchServiceSecretsResponse:
    """Patch a service secrets payload with JSON Patch operations, returning update status.

    This mutates stored secrets. Treat all values as sensitive; avoid logging secrets.

    When to use:
        - Use to update one or more secret keys without sending the entire object.
    When NOT to use:
        - If you only need to inspect schemas, use `get_service_secrets_schema`.

    Args:
        service_name: Exact service identifier (e.g. "github").
        patch: JSON Patch operation list (e.g. [{"op":"add","path":"/token","value":"ghp_..."}]).

    Returns:
        Object with key `updated` (boolean). On success, `updated` is true.

    Raises:
        httpx.RequestError: If the API is unreachable (connection/DNS/TLS errors).
        httpx.TimeoutException: If the request exceeds the configured timeout.

    Example:
        patch_service_secrets(\"github\", patch=[{\"op\":\"add\",\"path\":\"/token\",\"value\":\"ghp_123\"}])
        → {"updated": true}
    """
    return _request(
        "PATCH",
        f"/services/{service_name}/secrets",
        json=patch.model_dump(mode="json"),
    )


@mcp.tool(annotations={"idempotentHint": False, "openWorldHint": True})
def create_service(
    service_type: Annotated[
        str,
        Field(
            description='Registry type identifier (non-empty). Example: "registry".',
            min_length=1,
        ),
    ],
    source: Annotated[
        str,
        Field(
            description=(
                "Manifest definition source URL string. Example: "
                '"https://registry.example.com/service.json".'
            ),
            min_length=1,
        ),
    ],
) -> ServiceInstalledResponse:
    """Install a service manifest from a registry source, returning the installed service name/type.

    This fetches the manifest definition from `source` and stores it in the API's manifest database.

    When to use:
        - Use to add a new service from a known manifest URL.
    When NOT to use:
        - If the service is already installed and you want to refresh it, use `update_service`.

    Args:
        service_type: Registry type identifier (e.g. "registry").
        source: Manifest definition URL (e.g. "https://registry.example.com/service.json").

    Returns:
        Object with keys: `name`, `type`.

    Raises:
        httpx.RequestError: If the API is unreachable (connection/DNS/TLS errors).
        httpx.TimeoutException: If the request exceeds the configured timeout.
        RuntimeError: If the API responds with a non-201 status code for installation.

    Example:
        create_service(\"registry\", \"https://registry.example.com/github.json\")
        → {"name": "github", "type": "registry"}
    """
    return _request(
        "POST",
        "/services/install",
        json={"type": service_type, "source": source},
        expected_status=201,
    )


@mcp.tool(annotations={"idempotentHint": False, "openWorldHint": True})
def update_service(
    service_name: Annotated[
        str,
        Field(
            description='Exact service identifier (manifest id). Example: "github".',
            min_length=1,
        ),
    ],
) -> ServiceUpdatedResponse:
    """Refresh a service manifest from its stored install source, returning whether it changed.

    When to use:
        - Use to pull updated manifest contents from the stored source URL.
    When NOT to use:
        - If you need to toggle enablement, use `set_service_enabled` instead.

    Args:
        service_name: Exact service identifier (e.g. "github").

    Returns:
        Object with keys: `name` and `updated` (boolean). `updated=false` means no changes were applied.

    Raises:
        httpx.RequestError: If the API is unreachable (connection/DNS/TLS errors).
        httpx.TimeoutException: If the request exceeds the configured timeout.

    Example:
        update_service(\"github\") → {"name": "github", "updated": true}
    """
    return _request("POST", f"/services/{service_name}/update")


@mcp.tool(annotations={"idempotentHint": True, "openWorldHint": True})
def set_service_enabled(
    service_name: Annotated[
        str,
        Field(
            description='Exact service identifier (manifest id). Example: "github".',
            min_length=1,
        ),
    ],
    enabled: Annotated[
        bool,
        Field(description="Desired enabled state for the service. Example: true."),
    ],
) -> ServiceEnabledResponse:
    """Set a service enabled/disabled state by name, returning the resulting state.

    When to use:
        - Use to toggle a service on/off.
    When NOT to use:
        - If you need to remove the service permanently, use `delete_service`.

    Args:
        service_name: Exact service identifier (e.g. "github").
        enabled: Desired enabled state (e.g. True).

    Returns:
        Object with keys: `name`, `enabled`.

    Raises:
        httpx.RequestError: If the API is unreachable (connection/DNS/TLS errors).
        httpx.TimeoutException: If the request exceeds the configured timeout.

    Example:
        set_service_enabled(\"github\", enabled=True) → {"name": "github", "enabled": true}
    """
    return _request(
        "POST",
        f"/services/{service_name}/enabled",
        json={"enabled": enabled},
    )


@mcp.tool(annotations={"destructiveHint": True, "openWorldHint": True})
def delete_service(
    service_name: Annotated[
        str,
        Field(
            description='Exact service identifier (manifest id) to delete. Example: "github".',
            min_length=1,
        ),
    ],
) -> OkResponse:
    """Delete an installed service manifest by name, returning `ok=true` on HTTP 204.

    This permanently removes the manifest and associated stored data.

    When to use:
        - Use to uninstall a service you no longer need.
    When NOT to use:
        - If you only want to disable the service temporarily, use `set_service_enabled`.

    Args:
        service_name: Exact service identifier to delete (e.g. "github").

    Returns:
        Object with key `ok` set to true when the API returns HTTP 204 (no content).

    Raises:
        httpx.RequestError: If the API is unreachable (connection/DNS/TLS errors).
        httpx.TimeoutException: If the request exceeds the configured timeout.
        RuntimeError: If the API response status is not 204.

    Example:
        delete_service(\"github\") → {"ok": true}
    """
    return _request("DELETE", f"/services/{service_name}", expected_status=204)


@mcp.tool(
    annotations={"readOnlyHint": True, "idempotentHint": True, "openWorldHint": True}
)
def discover_tools(
    query: Annotated[
        str | None,
        Field(
            description=(
                "Optional search string to match tool name/description/service name. "
                'Whitespace is trimmed. Example: "issues".'
            )
        ),
    ] = None,
    limit: Annotated[
        int | None,
        Field(
            description=(
                "Optional maximum number of results to return (positive integer). Example: 10."
            ),
            ge=1,
        ),
    ] = None,
    enabled: Annotated[
        bool | None,
        Field(
            description=(
                "Optional enabled filter. Example: true. "
                "Note: omitting this parameter uses the API default (commonly enabled-only)."
            )
        ),
    ] = None,
) -> DiscoverToolsResponse:
    """Discover tools across services by query and filters, returning matching tool summaries.

    This tool is read-only: it searches the manifest store and returns metadata for each match.

    When to use:
        - Use when you need to find candidate tools across all services.
    When NOT to use:
        - If you already know the exact service+tool name, call `get_tool(tool_name, service_name=...)` instead.

    Args:
        query: Optional query string (e.g. "issues").
        limit: Optional maximum number of results (e.g. 10).
        enabled: Optional enabled filter (e.g. True).

    Returns:
        Object with key `tools` (list). Returns `tools=[]` if there are no matches.

    Raises:
        httpx.RequestError: If the API is unreachable (connection/DNS/TLS errors).
        httpx.TimeoutException: If the request exceeds the configured timeout.

    Example:
        discover_tools(query="issue", limit=5, enabled=True)
        → {"tools": [{"serviceName":"github","name":"listIssues","description":"...","enabled":true}]}
    """
    payload: Dict[str, Any] = {}
    _add_optional(payload, "query", query)
    _add_optional(payload, "limit", limit)
    _add_bool_param(payload, "enabled", enabled)
    return _request("POST", "/tools/discover", json=payload)


@mcp.tool(
    annotations={"readOnlyHint": True, "idempotentHint": True, "openWorldHint": True}
)
def get_tool(
    tool_name: Annotated[
        str,
        Field(
            description='Tool name identifier (may be ambiguous across services). Example: "listIssues".',
            min_length=1,
        ),
    ],
    service_name: Annotated[
        str | None,
        Field(
            description=(
                'Optional service identifier to disambiguate tool name. Example: "github". '
                "If omitted and the tool name is ambiguous, the API may return an error."
            ),
            min_length=1,
        ),
    ] = None,
) -> ToolDetails:
    """Fetch a tool definition by name (and optional service), returning schemas and enabled status.

    When to use:
        - Use when you need the tool's input/output schema before invoking it.
    When NOT to use:
        - If you don't know the tool name yet, call `discover_tools(query=...)` first.

    Args:
        tool_name: Tool name identifier (e.g. "listIssues").
        service_name: Optional service identifier (e.g. "github").

    Returns:
        Tool details object with keys: `name`, `description`, `enabled`, `inputSchema`, `outputSchema`.

    Raises:
        httpx.RequestError: If the API is unreachable (connection/DNS/TLS errors).
        httpx.TimeoutException: If the request exceeds the configured timeout.

    Example:
        get_tool(\"listIssues\", service_name=\"github\")
        → {"name":"listIssues","description":"...","enabled":true,"inputSchema":{...},"outputSchema":{...}}
    """
    payload: Dict[str, Any] = {"toolName": tool_name}
    _add_optional(payload, "serviceName", service_name)
    return _request("POST", f"/tools/{tool_name}", json=payload)


@mcp.tool(annotations={"idempotentHint": True, "openWorldHint": True})
def set_tool_enabled(
    service_name: Annotated[
        str,
        Field(
            description='Exact service identifier (manifest id). Example: "github".',
            min_length=1,
        ),
    ],
    tool_name: Annotated[
        str,
        Field(
            description='Tool name identifier within the service. Example: "listIssues".',
            min_length=1,
        ),
    ],
    enabled: Annotated[
        bool,
        Field(description="Desired enabled state for the tool. Example: false."),
    ],
) -> ToolEnabledResponse:
    """Set a tool enabled/disabled state for a service, returning the resulting tool state.

    When to use:
        - Use to toggle a specific tool on/off without uninstalling the service.
    When NOT to use:
        - If you need to enable/disable the whole service, use `set_service_enabled` instead.

    Args:
        service_name: Exact service identifier (e.g. "github").
        tool_name: Tool name identifier (e.g. "listIssues").
        enabled: Desired enabled state (e.g. True).

    Returns:
        Object with keys: `name`, `serviceName`, `enabled`.

    Raises:
        httpx.RequestError: If the API is unreachable (connection/DNS/TLS errors).
        httpx.TimeoutException: If the request exceeds the configured timeout.

    Example:
        set_tool_enabled(\"github\", \"listIssues\", enabled=False)
        → {"name":"listIssues","serviceName":"github","enabled":false}
    """
    return _request(
        "POST",
        f"/tools/{tool_name}/enabled",
        json={"serviceName": service_name, "enabled": enabled},
    )


def main() -> None:
    try:
        mcp.run(transport="http", host=HTTP_HOST, port=HTTP_PORT)
    except Exception as err:
        print(f"HTTP transport failed: {err}")


if __name__ == "__main__":
    main()
