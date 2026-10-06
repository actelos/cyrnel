export type SetupStatus =
  | "complete"
  | "authentication_required"
  | "configuration_required"
  | "secrets_required"
  | "multiple_requirements"
  | "unknown";

interface SetupStatusInput {
  schemes?: Record<string, unknown>;
  credentialSchemes?: Record<string, { configured: boolean }>;
  configSchema?: Record<string, unknown>;
  config?: Record<string, unknown>;
  secretsSchema?: Record<string, unknown>;
  secretsPresent?: string[];
}

function requiredKeys(schema: Record<string, unknown> | undefined): string[] {
  if (!schema || typeof schema !== "object") return [];
  const required = (schema as { required?: unknown }).required;
  if (!Array.isArray(required)) return [];
  return required.filter((key): key is string => typeof key === "string");
}

function hasProperties(schema: Record<string, unknown> | undefined): boolean {
  if (!schema || typeof schema !== "object") return false;
  const properties = (schema as { properties?: unknown }).properties;
  return (
    typeof properties === "object" &&
    properties !== null &&
    Object.keys(properties).length > 0
  );
}

export function setupStatus(input: SetupStatusInput): SetupStatus {
  const {
    schemes,
    credentialSchemes,
    configSchema,
    config,
    secretsSchema,
    secretsPresent,
  } = input;

  if (!schemes && !configSchema && !secretsSchema) return "unknown";

  const missing: Exclude<
    SetupStatus,
    "complete" | "multiple_requirements" | "unknown"
  >[] = [];

  const schemeNames = Object.keys(schemes ?? {});
  const authMissing = schemeNames.some(
    (name) => credentialSchemes?.[name]?.configured !== true,
  );
  if (authMissing) missing.push("authentication_required");

  if (hasProperties(configSchema)) {
    const required = requiredKeys(configSchema);
    const values = config ?? {};
    if (required.some((key) => values[key] === undefined)) {
      missing.push("configuration_required");
    }
  }

  if (hasProperties(secretsSchema)) {
    const required = requiredKeys(secretsSchema);
    const present = new Set(secretsPresent ?? []);
    if (required.some((key) => !present.has(`/${key}`) && !present.has(key))) {
      missing.push("secrets_required");
    }
  }

  if (missing.length === 0) return "complete";
  if (missing.length === 1) return missing[0];
  return "multiple_requirements";
}

export function setupStatusLabel(status: SetupStatus): string {
  switch (status) {
    case "complete":
      return "Setup complete";
    case "authentication_required":
      return "Authentication required";
    case "configuration_required":
      return "Configuration required";
    case "secrets_required":
      return "Secrets required";
    case "multiple_requirements":
      return "Setup incomplete";
    case "unknown":
      return "Setup status unknown";
  }
}

export function setupStatusDescription(status: SetupStatus): string {
  switch (status) {
    case "complete":
      return "This item is fully configured.";
    case "authentication_required":
      return "Connect credentials for every authentication scheme to finish setup.";
    case "configuration_required":
      return "Fill in the required configuration values to finish setup.";
    case "secrets_required":
      return "Provide the required secrets to finish setup.";
    case "multiple_requirements":
      return "Several setup steps are still open. Complete authentication, configuration, and secrets.";
    case "unknown":
      return "Setup state could not be determined.";
  }
}
