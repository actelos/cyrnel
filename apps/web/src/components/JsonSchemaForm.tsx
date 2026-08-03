import { Loader2, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useNotification } from "@/hooks/use-notification";
import { apiFetch, errorMessageFrom } from "@/lib/api";

type JSONSchema = Record<string, unknown>;

interface JsonSchemaFormProps {
  title: string;
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
  if (path.endsWith("/items")) {
    const parent = path.slice(0, -"/items".length);
    const subschema = subschemaAtPointer(schema, parent);
    if (subschema && isArrayType(subschema.type)) {
      return { pointer: parent, confirm: true };
    }
  }
  return { pointer: path, confirm: false };
}

function isPathCovered(pointer: string, path: string): boolean {
  return path === pointer || path.startsWith(`${pointer}/`);
}

function renderField(
  name: string,
  prop: JSONSchema,
  value: unknown,
  onChange: (name: string, value: unknown) => void,
  depth: number,
  presentSet?: Set<string>,
  basePath = "",
  requiredFields: string[] = [],
): React.ReactNode {
  const fullPath = basePath ? `${basePath}/${name}` : `/${name}`;
  const isPresent = presentSet?.has(fullPath);
  const propType = Array.isArray(prop.type) ? prop.type[0] : prop.type;
  const isRequired = requiredFields.includes(name);
  const description =
    typeof prop.description === "string" ? prop.description : undefined;

  const indent = `ml-${Math.min(depth * 4, 8)}`;

  if (propType === "object" && prop.properties) {
    const subProps = prop.properties as Record<string, JSONSchema>;
    const subValues = (value as Record<string, unknown>) ?? {};
    return (
      <fieldset key={name} className={`space-y-3 border-l-2 pl-4 ${indent}`}>
        <legend className="text-sm font-medium flex items-center gap-2">
          {name}
          {isRequired ? (
            <span className="text-destructive ml-0.5">*</span>
          ) : null}
          {description ? (
            <span className="text-xs text-muted-foreground font-normal">
              {description}
            </span>
          ) : null}
        </legend>
        {Object.entries(subProps).map(([subName, subProp]) =>
          renderField(
            subName,
            subProp as JSONSchema,
            subValues[subName],
            (k, v) => {
              onChange(name, { ...subValues, [k]: v });
            },
            depth + 1,
            presentSet,
            fullPath,
            (prop.required as string[]) ?? [],
          ),
        )}
      </fieldset>
    );
  }

  if (propType === "boolean") {
    return (
      <div key={name} className={`flex items-center gap-3 ${indent}`}>
        <Switch
          checked={value === true}
          onCheckedChange={(v) => onChange(name, v)}
        />
        <div className="space-y-0.5">
          <Label className="text-sm font-medium">
            {name}
            {isRequired ? (
              <span className="text-destructive ml-0.5">*</span>
            ) : null}
          </Label>
          {description ? (
            <p className="text-xs text-muted-foreground">{description}</p>
          ) : null}
        </div>
      </div>
    );
  }

  if (prop.enum && Array.isArray(prop.enum)) {
    return (
      <div key={name} className={`space-y-1.5 ${indent}`}>
        <Label className="text-sm font-medium">
          {name}
          {isRequired ? (
            <span className="text-destructive ml-0.5">*</span>
          ) : null}
          {description ? (
            <span className="text-xs text-muted-foreground font-normal ml-2">
              {description}
            </span>
          ) : null}
        </Label>
        <div className="flex flex-wrap gap-1.5">
          {prop.enum.map((option) => {
            const strOption = String(option);
            const selected = value === option;
            return (
              <Badge
                key={strOption}
                variant={selected ? "default" : "outline"}
                className="cursor-pointer text-xs"
                onClick={() => onChange(name, option)}
              >
                {strOption}
              </Badge>
            );
          })}
        </div>
      </div>
    );
  }

  if (propType === "array") {
    const items = Array.isArray(value) ? value : [];
    return (
      <div key={name} className={`space-y-2 ${indent}`}>
        <Label className="text-sm font-medium">
          {name}
          {isRequired ? (
            <span className="text-destructive ml-0.5">*</span>
          ) : null}
          {description ? (
            <span className="text-xs text-muted-foreground font-normal ml-2">
              {description}
            </span>
          ) : null}
        </Label>
        <div className="space-y-2">
          {items.map((item, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: primitives managed by index
            <div key={i} className="flex items-center gap-2">
              <Input
                value={typeof item === "string" ? item : JSON.stringify(item)}
                onChange={(e) => {
                  const next = [...items];
                  next[i] = e.target.value;
                  onChange(name, next);
                }}
                className="flex-1 font-mono text-xs"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-destructive h-8 w-8 p-0"
                onClick={() => {
                  const next = items.filter((_, j) => j !== i);
                  onChange(name, next);
                }}
              >
                ×
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onChange(name, [...items, ""])}
          >
            + Add
          </Button>
        </div>
      </div>
    );
  }

  const isNumber = propType === "number" || propType === "integer";
  const isSecret =
    name.toLowerCase().includes("secret") ||
    name.toLowerCase().includes("token") ||
    name.toLowerCase().includes("key") ||
    name.toLowerCase().includes("password");

  const textAttrs = {
    minLength: typeof prop.minLength === "number" ? prop.minLength : undefined,
    maxLength: typeof prop.maxLength === "number" ? prop.maxLength : undefined,
    pattern: typeof prop.pattern === "string" ? prop.pattern : undefined,
  };
  const numberAttrs = {
    min: typeof prop.minimum === "number" ? prop.minimum : undefined,
    max: typeof prop.maximum === "number" ? prop.maximum : undefined,
    step: typeof prop.step === "number" ? prop.step : undefined,
  };

  if (propType === "object" && !prop.properties) {
    return (
      <div key={name} className={`space-y-1.5 ${indent}`}>
        <Label className="text-sm font-medium">
          {name}
          {isRequired ? (
            <span className="text-destructive ml-0.5">*</span>
          ) : null}
          {description ? (
            <span className="text-xs text-muted-foreground font-normal ml-2">
              {description}
            </span>
          ) : null}
        </Label>
        <Textarea
          value={value !== undefined ? JSON.stringify(value, null, 2) : "{}"}
          onChange={(e) => {
            try {
              onChange(name, JSON.parse(e.target.value));
            } catch {
              onChange(name, e.target.value);
            }
          }}
          className="min-h-[100px] font-mono text-xs resize-none"
          {...textAttrs}
        />
      </div>
    );
  }

  return (
    <div key={name} className={`space-y-1.5 ${indent}`}>
      <Label className="text-sm font-medium">
        {name}
        {isRequired ? <span className="text-destructive ml-0.5">*</span> : null}
        {isPresent ? (
          <span className="w-[6px] h-[6px] bg-primary rounded-full"></span>
        ) : null}
        {description ? (
          <span className="text-xs text-muted-foreground font-normal ml-1">
            {description}
          </span>
        ) : null}
      </Label>
      {isSecret ? (
        <div className="relative">
          <Input
            type="password"
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(name, e.target.value)}
            placeholder="(hidden)"
            className="font-mono text-xs pr-16"
            {...textAttrs}
          />
          <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">
            secret
          </span>
        </div>
      ) : (
        <Input
          type={isNumber ? "number" : "text"}
          value={
            value !== undefined && value !== null
              ? isNumber
                ? String(value)
                : (value as string)
              : ""
          }
          onChange={(e) => {
            const val = e.target.value;
            onChange(
              name,
              isNumber ? (val === "" ? undefined : Number(val)) : val,
            );
          }}
          placeholder={
            typeof prop.default !== "undefined" ? String(prop.default) : ""
          }
          className="font-mono text-xs"
          {...(isNumber ? numberAttrs : textAttrs)}
        />
      )}
    </div>
  );
}

export default function JsonSchemaForm({
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

  const handleChange = (name: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [name]: value }));
  };

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
        title: "Saved",
        message: `${title} updated.`,
      });

      await onSaved?.();
    } catch (err) {
      const msg = errorMessageFrom(
        err,
        `Unable to save ${title.toLowerCase()}.`,
      );
      addNotification({ type: "error", title: "Error", message: msg });
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setValues({ ...currentValues });
    setPendingRemovals([]);
    setConfirmTarget(null);
  };

  const isEmpty = Object.keys(properties).length === 0;

  return (
    <Card className="w-full flex flex-col">
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        <div className="flex items-center gap-2">
          {hasChanges ? (
            <span className="text-xs text-muted-foreground">
              {patch.length + pendingRemovals.length} change
              {patch.length + pendingRemovals.length !== 1 ? "s" : ""}
            </span>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={saving || !hasChanges}
            onClick={handleReset}
          >
            <RotateCcw />
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={saving || !hasChanges}
            onClick={handleSave}
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
        </div>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 overflow-hidden">
        <ScrollArea className="h-full">
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
                  Stored values that no longer match the schema. Removals are
                  applied when you save.
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
                        onClick={() => handleStageRemoval(path)}
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
                      onClick={() =>
                        setPendingRemovals((prev) =>
                          prev.filter((p) => p !== pointer),
                        )
                      }
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
              Object.entries(properties).map(([name, prop]) =>
                renderField(
                  name,
                  prop as JSONSchema,
                  values[name],
                  handleChange,
                  0,
                  presentSet,
                  "",
                  (schema.required as string[]) ?? [],
                ),
              )
            )}
          </div>
        </ScrollArea>
      </CardContent>
      <AlertDialog
        open={confirmTarget !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove entire value?</AlertDialogTitle>
            <AlertDialogDescription>
              The value at{" "}
              <code className="font-mono text-xs">{confirmTarget}</code>{" "}
              contains items that are no longer defined by the schema. Removing
              it deletes the entire value, including any still-valid items.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmTarget) {
                  setPendingRemovals((prev) =>
                    prev.includes(confirmTarget)
                      ? prev
                      : [...prev, confirmTarget],
                  );
                }
                setConfirmTarget(null);
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
