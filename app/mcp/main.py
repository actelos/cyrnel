from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Dict, Optional

import httpx
from fastmcp import FastMCP

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
        params[key] = value


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


@mcp.tool()
def list_processes(
    state: Optional[str] = None,
    status: Optional[str] = None,
    ref: Optional[str] = None,
) -> Dict[str, Any]:
    """
    List processes with optional filters.

    Filters let you narrow results to a state (queued/running/finished),
    status (success/failed), or a custom reference label.

    Parameters
    - state: Optional process state filter string.
    - status: Optional process status filter string.
    - ref: Optional reference label used at creation time.

    Returns
    - An object containing a list of processes and any pagination metadata.
    """
    params: Dict[str, Any] = {}
    _add_optional(params, "state", state)
    _add_optional(params, "status", status)
    _add_optional(params, "ref", ref)
    return _request("GET", "/processes", params=params)


@mcp.tool()
def create_process(
    code: str,
    ref: Optional[str] = None,
    timeout: Optional[int] = None,
    block: bool = True,
) -> Dict[str, Any]:
    """
    Create a new process and return its pid.

    A process encapsulates runnable code executed by the MCI. After creation,
    the process is automatically executed.

    In a process, you can discover tools, discover services, invoke tools and
    manipulate their outputs to do complex tasks.

    You can use discovery to find what tools and services are available:
    `tools.discover({ query, limit, enabled })`
    `services.discover({ query, limit, enabled })`

    You can invoke service tools using the generated `invoke` bindings:
    `invoke.<service>.<tool>(parameters)`

    If you’re unsure what to call, discover first. Then invoke.

    Use `get_process_output`, `get_process_stdout`, `get_process_stderr`.

    Parameters
    - code: Source code to execute (MUST BE TYPESCRIPT CODE).
    - ref: Optional reference label to group or identify the process.
    - timeout: Optional execution timeout in seconds for this process.
    - block: Wait for completion before returning (defaults to true).

    Returns
    - pid: The process id for follow-up calls.

    Returns
    - Tool list with definitions or summaries, depending on API configuration.
    """
    payload: Dict[str, Any] = {"code": code, "block": block}
    _add_optional(payload, "ref", ref)
    _add_optional(payload, "timeout", timeout)
    return _request("POST", "/processes", json=payload, expected_status=201)


@mcp.tool()
def get_process(pid: int) -> Dict[str, Any]:
    """
    Get a process by pid.

    Returns the process metadata such as state, status, etc.

    Parameters
    - pid: Process id returned by `create_process`.
    """
    return _request("GET", f"/processes/{pid}")


@mcp.tool()
def delete_process(pid: int) -> Dict[str, Any]:
    """
    Delete a process by pid.

    Removes stored process records and outputs.

    Parameters
    - pid: Process id to delete.

    Returns
    - ok: True when deletion succeeds (HTTP 204).
    """
    return _request("DELETE", f"/processes/{pid}")


@mcp.tool()
def get_process_code(pid: int) -> str:
    """
    Get the code for a process.

    Parameters
    - pid: Process id.

    Returns
    - Raw code string originally submitted.
    """
    return _request("GET", f"/processes/{pid}/code", text_response=True)


@mcp.tool()
def get_process_output(pid: int) -> Dict[str, Any]:
    """
    Get the output for a process (structured).

    Use this to retrieve any structured output of a process that were emitted
    from it's code. This is not a normalization of stdout and stderr, It is more
    like data that was returned from withing the process code.

    Parameters
    - pid: Process id.

    Returns
    - Structured output payload from the API.
    """
    return _request("GET", f"/processes/{pid}/output")


@mcp.tool()
def get_process_stdout(pid: int) -> str:
    """
    Get the stdout for a process.

    Parameters
    - pid: Process id.

    Returns
    - Raw stdout string.
    """
    return _request("GET", f"/processes/{pid}/stdout", text_response=True)


@mcp.tool()
def get_process_stderr(pid: int) -> str:
    """
    Get the stderr for a process.

    Parameters
    - pid: Process id.

    Returns
    - Raw stderr string.
    """
    return _request("GET", f"/processes/{pid}/stderr", text_response=True)


@mcp.tool()
def run_process(pid: int, force: bool = False, block: bool = True) -> Dict[str, Any]:
    """
    Run and re-run an Idle process process. Use force for processes that have
    already been run.

    Parameters
    - pid: Process id to run.
    - force: Run process and overwrite it's existing outputs.
    - block: Wait for completion before returning (defaults to true).

    Returns
    - API response describing the signal action.
    """
    return _request(
        "POST",
        f"/processes/{pid}/signals/run",
        json={"force": force, "block": block},
    )


@mcp.tool()
def kill_process(pid: int) -> Dict[str, Any]:
    """
    Kill a queued or running process.

    Parameters
    - pid: Process id to stop.

    Returns
    - API response describing the kill action.
    """
    return _request("POST", f"/processes/{pid}/signals/kill", json={})


@mcp.tool()
def list_services(
    query: Optional[str] = None,
    enabled: Optional[bool] = None,
) -> Dict[str, Any]:
    """
    List installed services with optional filters.

    This is a discovery helper to find services. This is not to be mistaken with
    service discovery from withing the process.

    `services.discover({ query, limit, enabled })` is the recommended method.

    Parameters
    - query: Optional name or substring filter.
    - enabled: Optional enabled filter.

    Returns
    - A list of services and their metadata.
    """
    params: Dict[str, Any] = {}
    _add_optional(params, "query", query)
    _add_bool_param(params, "enabled", enabled)
    return _request("GET", "/services", params=params)


@mcp.tool()
def get_service(service_name: str) -> Dict[str, Any]:
    """
    Get a service by name.

    Parameters
    - service_name: Exact service identifier.

    Returns
    - Service metadata including enabled status and tools summary.
    """
    return _request("GET", f"/services/{service_name}")


@mcp.tool()
def create_service(service_type: str, source: str) -> Dict[str, Any]:
    """
    Install a service from a registry definition URL.

    Parameters
    - service_type: Registry type identifier.
    - source: Registry or manifest URL.

    Returns
    - Service installation result.
    """
    return _request(
        "POST",
        "/services/install",
        json={"type": service_type, "source": source},
        expected_status=201,
    )


@mcp.tool()
def update_service(service_name: str) -> Dict[str, Any]:
    """
    Update a service from its stored source.

    Parameters
    - service_name: Service identifier.

    Returns
    - Update result.
    """
    return _request("POST", f"/services/{service_name}/update")


@mcp.tool()
def set_service_enabled(service_name: str, enabled: bool) -> Dict[str, Any]:
    """
    Enable or disable a service.

    Parameters
    - service_name: Service identifier.
    - enabled: True to enable, False to disable.

    Returns
    - Updated service status.
    """
    return _request(
        "POST",
        f"/services/{service_name}/enabled",
        json={"enabled": enabled},
    )


@mcp.tool()
def delete_service(service_name: str) -> Dict[str, Any]:
    """
    Delete a service by name.

    Parameters
    - service_name: Service identifier.

    Returns
    - ok: True when deletion succeeds (HTTP 204).
    """
    return _request("DELETE", f"/services/{service_name}", expected_status=204)


@mcp.tool()
def list_tools(
    service_name: str,
    query: Optional[str] = None,
    enabled: Optional[bool] = None,
) -> Dict[str, Any]:
    """
    List tools for a service.

    This is a discovery helper to find tools of a service. This is not to be
    mistaken with tool discovery from withing the process.

    `tools.discover({ query, limit, enabled })` is the recommended method.

    Parameters
    - service_name: Service identifier.
    - query: Optional substring filter for tool names.
    - enabled: Optional filter for tool enablement.
    """
    params: Dict[str, Any] = {}
    _add_optional(params, "query", query)
    _add_bool_param(params, "enabled", enabled)
    return _request("GET", f"/services/{service_name}/tools", params=params)


@mcp.tool()
def get_tool_by_name(service_name: str, tool_name: str) -> Dict[str, Any]:
    """
    Get a tool definition by service and tool name.

    Use this to retrieve the schema for a specific tool after discovery,
    including parameter names and types.

    Parameters
    - service_name: Service identifier.
    - tool_name: Tool identifier within that service.

    Returns
    - Tool definition, including its input schema if available.
    """
    return _request("GET", f"/services/{service_name}/tools/{tool_name}")


@mcp.tool()
def set_tool_enabled(
    service_name: str,
    tool_name: str,
    enabled: bool,
) -> Dict[str, Any]:
    """
    Enable or disable a tool for a service.

    Parameters
    - service_name: Service identifier.
    - tool_name: Tool identifier within that service.
    - enabled: True to enable, False to disable.

    Returns
    - Updated tool status.
    """
    return _request(
        "POST",
        f"/services/{service_name}/tools/{tool_name}/enabled",
        json={"enabled": enabled},
    )


def main() -> None:
    try:
        mcp.run(transport="http", host=HTTP_HOST, port=HTTP_PORT)
    except Exception as err:
        print(f"HTTP transport failed: {err}")


if __name__ == "__main__":
    main()
