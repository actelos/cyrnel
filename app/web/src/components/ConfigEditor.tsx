import { useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface ConfigEditorProps {
  config?: string;
  schema?: string;
  jsonPatch?: string;
  onJsonPatchChange?: (value: string) => void;
  idPrefix?: string;
  labels?: {
    config?: string;
    schema?: string;
    patch?: string;
  };
  hideConfig?: boolean;
}

export default function ConfigEditor({
  config = "",
  schema = "",
  jsonPatch = "",
  onJsonPatchChange,
  idPrefix = "config-editor",
  labels,
  hideConfig = false,
}: ConfigEditorProps) {
  const [patch, setPatch] = useState(jsonPatch);
  const resolvedLabels = {
    config: labels?.config ?? "Current Config",
    schema: labels?.schema ?? "Schema",
    patch: labels?.patch ?? "JSON Patch",
  };

  useEffect(() => {
    setPatch(jsonPatch);
  }, [jsonPatch]);

  const handlePatchChange = (value: string) => {
    setPatch(value);
    onJsonPatchChange?.(value);
  };

  return (
    <div className="space-y-4">
      {hideConfig ? null : (
        <>
          <Label htmlFor={`${idPrefix}-config`}>{resolvedLabels.config}</Label>
          <Textarea
            id={`${idPrefix}-config`}
            value={config}
            readOnly
            placeholder="Current configuration will appear here..."
            className="min-h-[250px] font-mono text-sm resize-none"
          />
        </>
      )}

      <Label htmlFor={`${idPrefix}-schema`}>{resolvedLabels.schema}</Label>
      <Textarea
        id={`${idPrefix}-schema`}
        value={schema}
        readOnly
        placeholder="Schema definition will appear here..."
        className="min-h-[250px] font-mono text-sm resize-none"
      />

      <Label htmlFor={`${idPrefix}-patch`}>{resolvedLabels.patch}</Label>
      <Textarea
        id={`${idPrefix}-patch`}
        value={patch}
        onChange={(e) => handlePatchChange(e.target.value)}
        placeholder="Enter JSON patch operations here..."
        className="min-h-[250px] font-mono text-sm resize-none"
      />
    </div>
  );
}
