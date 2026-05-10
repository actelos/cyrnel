import { useState } from "react";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface ConfigEditorProps {
  config?: string;
  schema?: string;
  jsonPatch?: string;
  onJsonPatchChange?: (value: string) => void;
}

export default function ConfigEditor({
  config = "",
  schema = "",
  jsonPatch = "",
  onJsonPatchChange,
}: ConfigEditorProps) {
  const [patch, setPatch] = useState(jsonPatch);

  const handlePatchChange = (value: string) => {
    setPatch(value);
    onJsonPatchChange?.(value);
  };

  return (
    <div className="space-y-4">
      <Label htmlFor="config">Current Config</Label>
      <Textarea
        id="config"
        value={config}
        readOnly
        placeholder="Current configuration will appear here..."
        className="min-h-[250px] font-mono text-sm resize-none"
      />

      <Label htmlFor="schema">Schema</Label>
      <Textarea
        id="schema"
        value={schema}
        readOnly
        placeholder="Schema definition will appear here..."
        className="min-h-[250px] font-mono text-sm resize-none"
      />

      <Label htmlFor="patch">
        JSON Patch
      </Label>
      <Textarea
        id="patch"
        value={patch}
        onChange={(e) => handlePatchChange(e.target.value)}
        placeholder="Enter JSON patch operations here..."
        className="min-h-[250px] font-mono text-sm resize-none"
      />
    </div>
  );
}
