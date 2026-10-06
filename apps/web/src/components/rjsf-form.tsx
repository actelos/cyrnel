import type { IChangeEvent } from "@rjsf/core";
import Form from "@rjsf/shadcn";
import type { RJSFSchema, UiSchema } from "@rjsf/utils";
import validator from "@rjsf/validator-ajv8";
import { useMemo } from "react";

export type JSONSchema = Record<string, unknown>;

interface RjsfFormProps {
  schema: JSONSchema;
  formData?: Record<string, unknown> | unknown;
  onChange?: (next: Record<string, unknown>) => void;
  readonly?: boolean;
  disabled?: boolean;
  /** Extra uiSchema to merge on top of the generated one. */
  uiSchema?: UiSchema;
  /** When true, secret-looking string fields use the password widget. Defaults to true. */
  autoPasswordWidgets?: boolean;
  /** Live validation (validate on change). Defaults to true so required/enum errors surface inline. */
  liveValidate?: boolean;
  idPrefix?: string;
}

function isSecretName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.includes("secret") ||
    lower.includes("token") ||
    lower.includes("password") ||
    lower.includes("passwd") ||
    // "key" alone is too broad (e.g. "monkey") but apiKey/accessKey style
    // fields should render as passwords. Match common secret-key patterns.
    lower.includes("api_key") ||
    lower.includes("apikey") ||
    lower.includes("access_key") ||
    lower.includes("accesskey") ||
    lower.includes("private_key") ||
    lower.includes("privatekey") ||
    lower === "key" ||
    lower.endsWith("_key") ||
    lower.endsWith("-key") ||
    lower.endsWith("key")
  );
}

function secretUiFragment(node: JSONSchema): UiSchema | undefined {
  if (!node || typeof node !== "object") return undefined;
  const properties = node.properties as Record<string, JSONSchema> | undefined;
  if (!properties) return undefined;
  const fragment: UiSchema = {};
  let hasAny = false;
  for (const [propName, propSchema] of Object.entries(properties)) {
    if (!propSchema || typeof propSchema !== "object") continue;
    const type = Array.isArray(propSchema.type)
      ? propSchema.type[0]
      : propSchema.type;
    if (
      (type === "string" || type === undefined) &&
      !propSchema.enum &&
      isSecretName(propName)
    ) {
      fragment[propName] = { "ui:widget": "password" };
      hasAny = true;
      continue;
    }
    if (type === "object" || propSchema.properties) {
      const nested = secretUiFragment(propSchema);
      if (nested && Object.keys(nested).length > 0) {
        fragment[propName] = nested;
        hasAny = true;
      }
    }
  }
  return hasAny ? fragment : undefined;
}

function deepMergeUi(a: UiSchema, b: UiSchema): UiSchema {
  const out: UiSchema = { ...a };
  for (const [key, value] of Object.entries(b)) {
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof out[key] === "object" &&
      out[key] !== null &&
      !Array.isArray(out[key])
    ) {
      out[key] = deepMergeUi(out[key] as UiSchema, value as UiSchema);
    } else {
      out[key] = value as never;
    }
  }
  return out;
}

/**
 * Shared RJSF + shadcn form.
 *
 * Single place where JSON Schema -> form rendering lives. Used for:
 * - service / module config + secrets (JsonSchemaForm, setup wizard)
 * - readonly schema previews (service-tool-workbench)
 *
 * RJSF handles nested objects, arrays of objects, oneOf/anyOf/allOf,
 * enums and AJV validation — all cases the previous hand-rolled
 * renderers only partially covered.
 */
export function RjsfForm({
  schema,
  formData,
  onChange,
  readonly = false,
  disabled = false,
  uiSchema,
  autoPasswordWidgets = true,
  liveValidate = true,
  idPrefix,
}: RjsfFormProps) {
  const mergedUiSchema = useMemo<UiSchema>(() => {
    const base: UiSchema = {
      "ui:submitButtonOptions": { norender: true },
    };
    const auto =
      autoPasswordWidgets && !readonly ? secretUiFragment(schema) : undefined;
    let merged = base;
    if (auto) merged = deepMergeUi(merged, auto);
    if (uiSchema) merged = deepMergeUi(merged, uiSchema);
    return merged;
  }, [schema, uiSchema, autoPasswordWidgets, readonly]);

  const rjsfSchema = useMemo(() => schema as unknown as RJSFSchema, [schema]);

  const handleChange = (e: IChangeEvent) => {
    if (!onChange) return;
    const next =
      typeof e.formData === "object" && e.formData !== null
        ? (e.formData as Record<string, unknown>)
        : {};
    onChange(next);
  };

  return (
    <Form
      schema={rjsfSchema}
      validator={validator}
      formData={formData}
      onChange={handleChange}
      uiSchema={mergedUiSchema}
      readonly={readonly}
      disabled={disabled}
      liveValidate={liveValidate ? "onChange" : false}
      showErrorList={false}
      noHtml5Validate
      idPrefix={idPrefix}
    />
  );
}

export { validator };
