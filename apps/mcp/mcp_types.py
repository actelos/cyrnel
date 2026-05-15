from __future__ import annotations

from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, Field, RootModel

# Enums


# API: /processes (process.controller.ts)
class ProcessState(str, Enum):
    """Execution state for a stored process."""

    idle = "idle"
    queued = "queued"
    running = "running"
    terminating = "terminating"


# API: /processes (process.controller.ts)
class ProcessStatus(str, Enum):
    """Terminal status for a process execution (null means not completed)."""

    failed = "failed"
    success = "success"
    timeout = "timeout"
    canceled = "canceled"


# API: GET /processes?status=... (process.controller.ts)
class ProcessStatusQuery(str, Enum):
    """
    Query-string representation for filtering process status (supports literal 'null').
    """

    failed = "failed"
    success = "success"
    timeout = "timeout"
    canceled = "canceled"
    null = "null"


# API: PATCH /services/:serviceName/configuration (service.controller.ts)
class JsonPatchOp(str, Enum):
    """Operation type for a JSON Patch entry (RFC 6902 style)."""

    add = "add"
    remove = "remove"
    replace = "replace"  # pyright: ignore[reportAssignmentType]
    move = "move"
    copy = "copy"
    test = "test"


# Request models


# API: POST /processes (process.controller.ts)
class CreateProcessRequest(BaseModel):
    code: str = Field(
        description=(
            "TypeScript source code to execute (plain text). Example: "
            "\"console.log('hello')\"."
        ),
        min_length=1,
    )
    block: bool | None = Field(
        default=None,
        description=(
            "Whether to wait for the process to become idle before responding. "
            "Example: true."
        ),
    )
    ref: str | None = Field(
        default=None,
        description=(
            "Optional reference label to group processes. Must be non-empty after "
            'trimming. Example: "nightly-sync".'
        ),
        min_length=1,
    )
    timeout: int | None = Field(
        default=None,
        description=(
            "Optional execution timeout in milliseconds, or null to disable. "
            "Must be a positive integer when provided. Example: 30000."
        ),
        ge=1,
    )


# API: POST /processes/:pid/signals/run (process.controller.ts)
class RunProcessSignalRequest(BaseModel):
    force: bool | None = Field(
        default=None,
        description=(
            "Whether to overwrite existing outputs (stdout/stderr/output/status) "
            "before rerun. Example: true."
        ),
    )
    block: bool | None = Field(
        default=None,
        description=(
            "Whether to wait for the process to become idle before responding."
            "Example: false."
        ),
    )


# API: POST /discover/services and POST /discover/tools (discover.controller.ts)
class DiscoverRequest(BaseModel):
    query: str | None = Field(
        default=None,
        description=(
            'Optional search string; whitespace is trimmed. Example: "github" or '
            '"issues".'
        ),
    )
    limit: int | None = Field(
        default=None,
        description=(
            "Optional maximum number of results to return. Must be a positive "
            "integer. Example: 10."
        ),
        ge=1,
    )
    enabled: bool | None = Field(
        default=None,
        description=(
            "Optional enabled filter. Use true for enabled only, false for disabled "
            "only, or null to include both. Example: null."
        ),
    )


# API: POST /services/install (service.controller.ts)
class InstallServiceSourceMetadata(BaseModel):
    file_url: str | None = Field(
        default=None,
        description=(
            "Optional URL for the manifest definition file from metadata. "
            'Example: "https://registry.example.com/service.json".'
        ),
        min_length=1,
    )


# API: POST /services/install (service.controller.ts)
class InstallServiceSourceObject(BaseModel):
    file_url: str | None = Field(
        default=None,
        description=(
            "Optional URL for the manifest definition file. Example: "
            '"https://registry.example.com/service.json".'
        ),
        min_length=1,
    )
    metadata: InstallServiceSourceMetadata | None = Field(
        default=None,
        description="Optional nested metadata container for file_url.",
    )


# API: POST /services/install (service.controller.ts)
class ServiceInstallRequest(BaseModel):
    type: str = Field(
        description=(
            "Registry type identifier. Must be non-empty after trimming. "
            'Example: "registry".'
        ),
        min_length=1,
    )
    source: str | InstallServiceSourceObject = Field(
        description=(
            "Manifest definition source, either a URL string or an object with a "
            'file_url. Examples: "https://registry.example.com/service.json" or '
            '{"file_url": "https://registry.example.com/service.json"}.'
        ),
    )


# API: POST /services/:serviceName/enabled (service.controller.ts)
class SetServiceEnabledRequest(BaseModel):
    enabled: bool = Field(
        description="Desired enabled state for the service. Example: true.",
    )


# API: POST /services/:serviceName/tools/:toolName/enabled (service.controller.ts)
class SetServiceToolEnabledRequest(BaseModel):
    enabled: bool = Field(
        description="Desired enabled state for the tool. Example: false.",
    )


# API: PATCH /services/:serviceName/configuration and /services/:serviceName/secrets
class JsonPatchAdd(BaseModel):
    op: Literal[JsonPatchOp.add] = Field(
        description="JSON Patch operation type. Must be 'add'. Example: \"add\".",
    )
    path: str = Field(
        description=(
            "JSON Pointer path to the target field. Must be non-empty. "
            'Example: "/enabled".'
        ),
        min_length=1,
    )
    value: Any = Field(
        description="Value to add at the target path. Example: true.",
    )


# API: PATCH /services/:serviceName/configuration and /services/:serviceName/secrets
class JsonPatchRemove(BaseModel):
    op: Literal[JsonPatchOp.remove] = Field(
        description=(
            "JSON Patch operation type. Must be 'remove'. Example: \"remove\"."
        ),
    )
    path: str = Field(
        description=(
            'JSON Pointer path to remove. Must be non-empty. Example: "/token".'
        ),
        min_length=1,
    )


# API: PATCH /services/:serviceName/configuration and /services/:serviceName/secrets
class JsonPatchReplace(BaseModel):
    op: Literal[JsonPatchOp.replace] = Field(
        description=(
            "JSON Patch operation type. Must be 'replace'. Example: \"replace\"."
        ),
    )
    path: str = Field(
        description=(
            "JSON Pointer path to the target field. Must be non-empty. "
            'Example: "/timeout".'
        ),
        min_length=1,
    )
    value: Any = Field(
        description="Replacement value for the target path. Example: 30.",
    )


# API: PATCH /services/:serviceName/configuration and /services/:serviceName/secrets
class JsonPatchMove(BaseModel):
    op: Literal[JsonPatchOp.move] = Field(
        description="JSON Patch operation type. Must be 'move'. Example: \"move\".",
    )
    path: str = Field(
        description=(
            'Destination JSON Pointer path. Must be non-empty. Example: "/newKey".'
        ),
        min_length=1,
    )
    from_: str = (
        Field(  # NOTE: serialized name is handled by aliases in call sites if needed.
            description=(
                'Source JSON Pointer path. Must be non-empty. Example: "/oldKey".'
            ),
            min_length=1,
            alias="from",
        )
    )


# API: PATCH /services/:serviceName/configuration and /services/:serviceName/secrets
class JsonPatchCopy(BaseModel):
    op: Literal[JsonPatchOp.copy] = Field(
        description="JSON Patch operation type. Must be 'copy'. Example: \"copy\".",
    )
    path: str = Field(
        description=(
            'Destination JSON Pointer path. Must be non-empty. Example: "/copied".'
        ),
        min_length=1,
    )
    from_: str = Field(
        description=(
            'Source JSON Pointer path. Must be non-empty. Example: "/original".'
        ),
        min_length=1,
        alias="from",
    )


# API: PATCH /services/:serviceName/configuration and /services/:serviceName/secrets
class JsonPatchTest(BaseModel):
    op: Literal[JsonPatchOp.test] = Field(
        description="JSON Patch operation type. Must be 'test'. Example: \"test\".",
    )
    path: str = Field(
        description='JSON Pointer path to test. Must be non-empty. Example: "/mode".',
        min_length=1,
    )
    value: Any = Field(
        description=(
            'Value to compare against the current value at path. Example: "prod".'
        ),
    )


# API: PATCH /services/:serviceName/configuration and /services/:serviceName/secrets
JsonPatchOperation = (
    JsonPatchAdd
    | JsonPatchRemove
    | JsonPatchReplace
    | JsonPatchMove
    | JsonPatchCopy
    | JsonPatchTest
)


# API: PATCH /services/:serviceName/configuration and /services/:serviceName/secrets
class JsonPatch(RootModel[list[JsonPatchOperation]]):
    root: list[JsonPatchOperation] = Field(
        description=(
            "JSON Patch operation list (RFC 6902 style). Example: "
            '[{"op":"add","path":"/enabled","value":true}].'
        ),
        min_length=1,
    )


# Response models


# API: GET /processes and GET /processes/:pid (process.controller.ts)
class Process(BaseModel):
    pid: int = Field(
        description="Process identifier (positive integer). Example: 12.",
        ge=1,
    )
    ref: str | None = Field(
        default=None,
        description=(
            "Optional reference label assigned at creation time. Example: "
            '"nightly-sync".'
        ),
        min_length=1,
    )
    state: ProcessState = Field(
        description='Current process state. Example: "idle".',
    )
    status: ProcessStatus | None = Field(
        default=None,
        description='Terminal status (null means not completed). Example: "success".',
    )


# API: GET /processes (process.controller.ts)
class ProcessListResponse(BaseModel):
    processes: list[Process] = Field(
        description=(
            "List of stored processes matching the provided filters. Example: "
            '[{"pid":12,"state":"idle","status":null}].'
        ),
    )


# API: POST /processes (process.controller.ts)
class ProcessCreatedResponse(BaseModel):
    pid: int = Field(
        description="Newly created process identifier. Example: 12.",
        ge=1,
    )


# API: GET /processes/:pid/output (process.controller.ts)
class ProcessOutputResponse(RootModel[dict[str, Any]]):
    root: dict[str, Any] = Field(
        description=(
            'Structured output object emitted by process code. Example: {"result": 42}.'
        ),
    )


# API: POST /discover/tools (discover.controller.ts)
class ToolDiscoverItem(BaseModel):
    serviceName: str = Field(
        description='Owning service identifier. Example: "github".',
        min_length=1,
    )
    name: str = Field(
        description='Tool name identifier within the service. Example: "listIssues".',
        min_length=1,
    )
    description: str = Field(
        description=(
            'Human-readable tool description. Example: "List issues for a repository".'
        ),
    )
    enabled: bool = Field(
        description=(
            "Whether the tool is enabled (includes service enabled state)."
            "Example: true."
        ),
    )


# API: POST /discover/tools (discover.controller.ts)
class DiscoverToolsResponse(BaseModel):
    tools: list[ToolDiscoverItem] = Field(
        description=(
            "Discovered tools matching the query. Returns an empty list if no "
            "matches. Example: "
            '[{"serviceName":"github","name":"listIssues","description":"...",'
            '"enabled":true}].'
        ),
    )


# API: POST /discover/services and GET /services (service.controller.ts)
class ServiceListItem(BaseModel):
    name: str = Field(
        description='Service identifier (manifest id). Example: "github".',
        min_length=1,
    )
    type: str = Field(
        description='Service type identifier. Example: "registry".',
        min_length=1,
    )
    source: str = Field(
        description=(
            "Stored install source URL for the service. Example: "
            '"https://registry.example.com/service.json".'
        ),
        min_length=1,
    )
    description: str = Field(
        description=(
            'Human-readable service description. Example: "GitHub API integration".'
        ),
    )
    hash: str = Field(
        description=(
            'Content hash for the installed manifest definition. Example: "sha256:...".'
        ),
        min_length=1,
    )
    enabled: bool = Field(
        description="Whether the service is enabled. Example: false.",
    )


# API: POST /discover/services (discover.controller.ts)
class DiscoverServicesResponse(BaseModel):
    services: list[ServiceListItem] = Field(
        description=(
            "Discovered services matching the query. Returns an empty list if no "
            "matches. Example: "
            '[{"name":"github","type":"registry","source":"...","description":'
            '"...","hash":"...","enabled":false}].'
        ),
    )


# API: GET /services/:serviceName (service.controller.ts)
class ServiceDetails(BaseModel):
    name: str = Field(
        description='Service identifier (manifest id). Example: "github".',
        min_length=1,
    )
    type: str = Field(
        description='Service type identifier. Example: "registry".',
        min_length=1,
    )
    source: str = Field(
        description=(
            "Stored install source URL for the service."
            'Example: "https://registry.example.com/service.json".'
        ),
        min_length=1,
    )
    description: str = Field(
        description=(
            'Human-readable service description. Example: "GitHub API integration".'
        ),
    )
    hash: str = Field(
        description=(
            'Content hash for the installed manifest definition. Example: "sha256:...".'
        ),
        min_length=1,
    )
    enabled: bool = Field(
        description="Whether the service is enabled. Example: true.",
    )
    configSchema: dict[str, Any] = Field(
        description=(
            "JSON Schema describing the service configuration shape. Example: "
            '{"type":"object", "properties": {}}.'
        ),
    )
    secretsSchema: dict[str, Any] = Field(
        description=(
            "JSON Schema describing the service secrets shape. Example: "
            '{"type":"object", "properties": {}}.'
        ),
    )


# API: GET /services/:serviceName/configuration (service.controller.ts)
class ServiceConfigurationResponse(BaseModel):
    config: dict[str, Any] = Field(
        description=(
            "Current service configuration object. Returns {} if none stored. Example: "
            '{"enabled": true}.'
        ),
    )


# API: GET /services/:serviceName/configuration/schema (service.controller.ts)
class ServiceConfigurationSchemaResponse(BaseModel):
    configSchema: dict[str, Any] = Field(
        description=(
            'JSON Schema for the service configuration. Example: {"type":"object"}.'
        ),
    )


# API: GET /services/:serviceName/secrets/schema (service.controller.ts)
class ServiceSecretsSchemaResponse(BaseModel):
    secretsSchema: dict[str, Any] = Field(
        description='JSON Schema for the service secrets. Example: {"type":"object"}.',
    )


# API: PATCH /services/:serviceName/configuration (service.controller.ts)
class PatchServiceConfigurationResponse(BaseModel):
    config: dict[str, Any] = Field(
        description='Updated service configuration object. Example: {"timeout": 30}.',
    )


# API: PATCH /services/:serviceName/secrets (service.controller.ts)
class PatchServiceSecretsResponse(BaseModel):
    updated: bool = Field(
        description="True when secrets were updated successfully. Example: true.",
    )


# API: POST /services/install (service.controller.ts)
class ServiceInstalledResponse(BaseModel):
    name: str = Field(
        description='Installed service identifier (manifest id). Example: "github".',
        min_length=1,
    )
    type: str = Field(
        description='Installed service type identifier. Example: "registry".',
        min_length=1,
    )


# API: POST /services/:serviceName/update (service.controller.ts)
class ServiceUpdatedResponse(BaseModel):
    name: str = Field(
        description='Service identifier. Example: "github".',
        min_length=1,
    )
    updated: bool = Field(
        description=(
            "Whether the stored manifest definition changed and was updated. "
            "Example: true."
        ),
    )


# API: POST /services/:serviceName/enabled (service.controller.ts)
class ServiceEnabledResponse(BaseModel):
    name: str = Field(
        description='Service identifier. Example: "github".',
        min_length=1,
    )
    enabled: bool = Field(
        description="Resulting enabled state for the service. Example: false.",
    )


# API: 204 responses from endpoints that send no body (app/mcp/main.py _request)
class OkResponse(BaseModel):
    ok: bool = Field(
        description="True when the API returned HTTP 204 (no content). Example: true.",
    )


# API: GET /services/:serviceName/tools/:toolName (service.controller.ts)
class ToolDetails(BaseModel):
    name: str = Field(
        description='Tool name identifier within the service. Example: "listIssues".',
        min_length=1,
    )
    description: str = Field(
        description=(
            'Human-readable tool description. Example: "List issues for a repository".'
        ),
    )
    enabled: bool = Field(
        description=(
            "Whether the tool is enabled (includes service enabled state). Example: "
            "true."
        ),
    )
    inputSchema: dict[str, Any] = Field(
        description=(
            "JSON Schema describing the tool input parameters. Example: "
            '{"type":"object"}.'
        ),
    )
    outputSchema: dict[str, Any] = Field(
        description=(
            "JSON Schema describing the tool output payload. Example: "
            '{"type":"object"}.'
        ),
    )


# API: POST /services/:serviceName/tools/:toolName/enabled (service.controller.ts)
class ToolEnabledResponse(BaseModel):
    name: str = Field(
        description='Tool name identifier within the service. Example: "listIssues".',
        min_length=1,
    )
    serviceName: str = Field(
        description='Owning service identifier. Example: "github".',
        min_length=1,
    )
    enabled: bool = Field(
        description="Resulting enabled state for the tool. Example: false.",
    )
