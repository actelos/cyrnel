import { Loader2, Undo2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { type JSONSchema, RjsfForm } from "@/components/rjsf-form";
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
import { SheetFooter } from "@/components/ui/sheet";
import { useNotification } from "@/hooks/use-notification";
import { apiFetch, errorMessageFrom } from "@/lib/api";

interface JsonSchemaFormProps {
  title?: string;
  schema: JSONSchema;
  currentValues: Record<string, unknown>;
  patchUrl: string;
  presentSet?: Set<string>;
  outdatedPaths?: string[];
  onSaved?: () => void | Promise<void>;
}

function jsonPointer(path: string): string {
  return `/${path.replace(/~/g, "~0").replace(/\//g, "~1")}`;
}

function encodePointer(path: string): string {
  return path.replace(/~/g, "~0").replace(/\//g, "~1");
}

function expandObjectReplace(
  basePath: string,
  obj: Record<string, unknown>,
  presentSet: Set<string>,
): Array<Record<string, unknown>> {
  const ops: Array<Record<string, unknown>> = [];

  for (const [key, value] of Object.entries(obj)) {
    const path = `${basePath}/${encodePointer(key)}`;
    const isPresent = presentSet.has(path);

    if (isPresent && (value === "" || value === 0 || value === false)) {
      continue;
    }

    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      ops.push(
        ...expandObjectReplace(
          path,
          value as Record<string, unknown>,
          presentSet,
        ),
      );
    } else {
      ops.push({ op: isPresent ? "replace" : "add", path, value });
    }
  }

  return ops;
}

function expandPatch(
  patch: Array<Record<string, unknown>>,
  presentSet: Set<string>,
): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];

  for (const op of patch) {
    if (
      op.op === "replace" &&
      typeof op.value === "object" &&
      op.value !== null &&
      !Array.isArray(op.value)
    ) {
      const leafOps = expandObjectReplace(
        op.path as string,
        op.value as Record<string, unknown>,
        presentSet,
      );
      result.push(...leafOps);
    } else {
      result.push(op);
    }
  }

  return result;
}

function buildPatch(
  current: Record<string, unknown>,
  next: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const patch: Array<Record<string, unknown>> = [];
  for (const key of Object.keys(current)) {
    if (!Object.hasOwn(next, key)) {
      patch.push({ op: "remove", path: jsonPointer(key) });
    }
  }
  for (const [key, value] of Object.entries(next)) {
    if (
      Object.hasOwn(current, key) &&
      JSON.stringify(current[key]) === JSON.stringify(value)
    ) {
      continue;
    }
    const op = Object.hasOwn(current, key) ? "replace" : "add";
    patch.push({ op, path: jsonPointer(key), value });
  }
  return patch;
}

function subschemaAtPointer(
  schema: JSONSchema,
  pointer: string,
): JSONSchema | undefined {
  const segments = pointer
    .split("/")
    .slice(1)
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  let node: JSONSchema | undefined = schema;
  for (const segment of segments) {
    const properties = node?.properties as
      | Record<string, JSONSchema>
      | undefined;
    if (!properties) return undefined;
    node = properties[segment];
  }
  return node;
}

function isArrayType(type: unknown): boolean {
  return type === "array" || (Array.isArray(type) && type.includes("array"));
}

function removalPlan(
  path: string,
  schema: JSONSchema,
): { pointer: string; confirm: boolean } {
  const arrayItem = /\/items\/\d+/.exec(path);
  if (arrayItem && arrayItem.index > 0) {
    const arrayPointer = path.slice(0, arrayItem.index);
    const subschema = subschemaAtPointer(schema, arrayPointer);
    if (subschema && isArrayType(subschema.type)) {
      return { pointer: arrayPointer, confirm: true };
    }
  }
  return { pointer: path, confirm: false };
}

function isPathCovered(pointer: string, path: string): boolean {
  return path === pointer || path.startsWith(`${pointer}/`);
}

function useJsonSchemaFormState({
  title,
  schema,
  currentValues,
  patchUrl,
  presentSet,
  outdatedPaths,
  onSaved,
}: JsonSchemaFormProps) {
  const { addNotification } = useNotification();
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [pendingRemovals, setPendingRemovals] = useState<string[]>([]);
  const [confirmTarget, setConfirmTarget] = useState<string | null>(null);

  const properties = (schema.properties ?? {}) as Record<string, JSONSchema>;

  useEffect(() => {
    setValues({ ...currentValues });
  }, [currentValues]);

  const patch = useMemo(
    () => buildPatch(currentValues, values),
    [currentValues, values],
  );

  const outstanding = useMemo(
    () =>
      (outdatedPaths ?? []).filter(
        (path) => !pendingRemovals.some((p) => isPathCovered(p, path)),
      ),
    [outdatedPaths, pendingRemovals],
  );

  const hasChanges = patch.length > 0 || pendingRemovals.length > 0;
  const changeCount = patch.length + pendingRemovals.length;

  const idPrefix = useMemo(
    () => `cfg-${patchUrl.replace(/[^a-zA-Z0-9]/g, "-").slice(-32)}`,
    [patchUrl],
  );

  const handleStageRemoval = (path: string) => {
    const plan = removalPlan(path, schema);
    if (plan.confirm) {
      setConfirmTarget(plan.pointer);
    } else {
      setPendingRemovals((prev) =>
        prev.includes(plan.pointer) ? prev : [...prev, plan.pointer],
      );
    }
  };

  const handleUnstageRemoval = (pointer: string) => {
    setPendingRemovals((prev) => prev.filter((p) => p !== pointer));
  };

  const handleSave = async () => {
    if (!hasChanges) {
      addNotification({
        type: "success",
        title: "No changes",
        message: "No changes to save.",
      });
      return;
    }

    const body = [
      ...(presentSet ? expandPatch(patch, presentSet) : patch),
      ...pendingRemovals.map((path) => ({ op: "remove", path })),
    ];

    if (body.length === 0) {
      addNotification({
        type: "success",
        title: "No changes",
        message: "No changes to save.",
      });
      return;
    }

    setSaving(true);
    try {
      await apiFetch(patchUrl, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      setPendingRemovals([]);
      addNotification({
        type: "success",
        title: `${title ?? "Configuration"} saved`,
        message: `${title ?? "Form"} updated.`,
      });

      await onSaved?.();
    } catch (err) {
      const msg = errorMessageFrom(
        err,
        `Unable to save ${(title ?? "form").toLowerCase()}.`,
      );
      addNotification({
        type: "error",
        title: `${title ?? "Configuration"} save failed`,
        message: msg,
      });
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    if (!hasChanges) return;
    setValues({ ...currentValues });
    setPendingRemovals([]);
    setConfirmTarget(null);
    addNotification({
      type: "info",
      title: "Changes discarded",
      message: "Unsaved changes were discarded.",
    });
  };

  const isEmpty = Object.keys(properties).length === 0;

  return {
    values,
    setValues,
    saving,
    pendingRemovals,
    confirmTarget,
    setConfirmTarget,
    patch,
    outstanding,
    hasChanges,
    changeCount,
    idPrefix,
    isEmpty,
    handleStageRemoval,
    handleUnstageRemoval,
    handleSave,
    handleReset,
  };
}

interface JsonSchemaFormFieldsProps {
  schema: JSONSchema;
  values: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  idPrefix: string;
  outstanding: string[];
  pendingRemovals: string[];
  onStageRemoval: (path: string) => void;
  onUnstageRemoval: (pointer: string) => void;
  isEmpty: boolean;
}

function JsonSchemaFormFields({
  schema,
  values,
  onChange,
  idPrefix,
  outstanding,
  pendingRemovals,
  onStageRemoval,
  onUnstageRemoval,
  isEmpty,
}: JsonSchemaFormFieldsProps) {
  return (
    <div className="space-y-4">
      {outstanding.length > 0 || pendingRemovals.length > 0 ? (
        <div className="space-y-2 rounded-md border border-dashed p-3">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-sm font-medium">Outdated keys</h4>
            {outstanding.length + pendingRemovals.length > 1 ? (
              <Badge variant="outline">
                {outstanding.length + pendingRemovals.length}
              </Badge>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            Stored values that no longer match the schema. Removals are applied
            when you save.
          </p>
          {outstanding.map((path) => {
            const plan = removalPlan(path, schema);
            return (
              <div key={path} className="flex items-center gap-2">
                <span className="flex-1 truncate font-mono text-xs">
                  {plan.pointer}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2 text-destructive"
                  onClick={() => onStageRemoval(path)}
                >
                  Remove
                </Button>
              </div>
            );
          })}
          {pendingRemovals.map((pointer) => (
            <div key={pointer} className="flex items-center gap-2">
              <span className="flex-1 truncate font-mono text-xs text-muted-foreground line-through">
                {pointer}
              </span>
              <span className="text-[10px] text-muted-foreground">
                will be removed
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0"
                onClick={() => onUnstageRemoval(pointer)}
              >
                ×
              </Button>
            </div>
          ))}
        </div>
      ) : null}
      {isEmpty ? (
        <p className="text-sm text-muted-foreground">
          No configuration options available.
        </p>
      ) : (
        <RjsfForm
          schema={schema}
          formData={values}
          onChange={onChange}
          idPrefix={idPrefix}
        />
      )}
    </div>
  );
}

interface JsonSchemaFormActionsProps {
  changeCount: number;
  hasChanges: boolean;
  saving: boolean;
  onReset: () => void;
  onSave: () => void;
  size?: "default" | "sm";
}

function JsonSchemaFormActions({
  changeCount,
  hasChanges,
  saving,
  onReset,
  onSave,
  size = "default",
}: JsonSchemaFormActionsProps) {
  return (
    <>
      {hasChanges ? (
        <span className="mr-auto text-xs text-muted-foreground">
          {changeCount} change{changeCount !== 1 ? "s" : ""}
        </span>
      ) : null}
      <Button
        type="button"
        variant="destructive"
        size={size}
        disabled={saving || !hasChanges}
        onClick={onReset}
        className="gap-2"
      >
        <Undo2 />
        Reset
      </Button>
      <Button
        type="button"
        size={size}
        disabled={saving || !hasChanges}
        onClick={() => void onSave()}
        className="gap-2"
      >
        {saving ? (
          <>
            <Loader2 className="animate-spin" />
            Saving
          </>
        ) : (
          "Save"
        )}
      </Button>
    </>
  );
}

function JsonSchemaFormRemoveConfirm({
  confirmTarget,
  onOpenChange,
  onConfirm,
}: {
  confirmTarget: string | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog
      open={confirmTarget !== null}
      onOpenChange={(open) => {
        if (!open) onOpenChange(false);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove entire value?</AlertDialogTitle>
          <AlertDialogDescription>
            The value at{" "}
            <code className="font-mono text-xs">{confirmTarget}</code> contains
            items that are no longer defined by the schema. Removing it deletes
            the entire value, including any still-valid items.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Remove</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Bare configuration / secrets form.
 *
 * No card chrome — renders fields with Save/Reset inline under the form.
 * Used by the install wizard steps.
 */
export default function JsonSchemaForm(props: JsonSchemaFormProps) {
  const state = useJsonSchemaFormState(props);

  return (
    <div className="space-y-4">
      <JsonSchemaFormFields
        schema={props.schema}
        values={state.values}
        onChange={state.setValues}
        idPrefix={state.idPrefix}
        outstanding={state.outstanding}
        pendingRemovals={state.pendingRemovals}
        onStageRemoval={state.handleStageRemoval}
        onUnstageRemoval={state.handleUnstageRemoval}
        isEmpty={state.isEmpty}
      />
      <div className="flex items-center justify-end gap-2">
        <JsonSchemaFormActions
          changeCount={state.changeCount}
          hasChanges={state.hasChanges}
          saving={state.saving}
          onReset={state.handleReset}
          onSave={state.handleSave}
        />
      </div>
      <JsonSchemaFormRemoveConfirm
        confirmTarget={state.confirmTarget}
        onOpenChange={(open) => {
          if (!open) state.setConfirmTarget(null);
        }}
        onConfirm={() => {
          if (state.confirmTarget) {
            const target = state.confirmTarget;
            state.setConfirmTarget(null);
            state.handleStageRemoval(target);
            // handleStageRemoval with an already-resolved pointer stages it
            // directly; the confirm round-trip above only happens for array
            // values, so re-stage here after closing the dialog.
          }
        }}
      />
    </div>
  );
}

/**
 * Sheet layout for configuration / secrets.
 *
 * Renders the same form fields in the sheet's scrollable body with
 * Save/Reset in a sticky SheetFooter — no card chrome.
 */
export function JsonSchemaFormSheet(props: JsonSchemaFormProps) {
  const state = useJsonSchemaFormState(props);

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto px-4">
        <div className="space-y-4">
          <JsonSchemaFormFields
            schema={props.schema}
            values={state.values}
            onChange={state.setValues}
            idPrefix={state.idPrefix}
            outstanding={state.outstanding}
            pendingRemovals={state.pendingRemovals}
            onStageRemoval={state.handleStageRemoval}
            onUnstageRemoval={state.handleUnstageRemoval}
            isEmpty={state.isEmpty}
          />
        </div>
      </div>
      <SheetFooter className="flex-row items-center justify-end gap-2 border-t">
        <JsonSchemaFormActions
          changeCount={state.changeCount}
          hasChanges={state.hasChanges}
          saving={state.saving}
          onReset={state.handleReset}
          onSave={state.handleSave}
          size="default"
        />
      </SheetFooter>
      <JsonSchemaFormRemoveConfirm
        confirmTarget={state.confirmTarget}
        onOpenChange={(open) => {
          if (!open) state.setConfirmTarget(null);
        }}
        onConfirm={() => {
          if (state.confirmTarget) {
            const target = state.confirmTarget;
            state.setConfirmTarget(null);
            state.handleStageRemoval(target);
          }
        }}
      />
    </>
  );
}

export { JsonSchemaFormActions, JsonSchemaFormFields, useJsonSchemaFormState };
