import { ChevronDown } from "lucide-react";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type ToolPolicyDecision = "allow" | "block" | "ask";

export type Tool = {
  id: string;
  name: string;
  summary: string;
  description: string;
  policy?: {
    decision: ToolPolicyDecision;
  };
};

export function ToolCard({
  tool,
  onPolicyChange,
}: {
  tool: Tool;
  onPolicyChange: (decision: ToolPolicyDecision) => void;
}) {
  const [open, setOpen] = useState(false);
  const summary =
    tool.summary && tool.summary !== tool.name
      ? tool.summary
      : "No summary available";

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center gap-3 px-4">
        <button
          type="button"
          onClick={() => setOpen((previous) => !previous)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 flex-col items-start gap-0.5 py-2.5 text-left"
        >
          <span className="text-sm font-semibold">{tool.name}</span>
          <span className="font-mono text-xs text-muted-foreground">
            {tool.id}
          </span>
          <span className="text-xs text-muted-foreground">{summary}</span>
        </button>
        <Select
          value={tool.policy?.decision ?? "ask"}
          onValueChange={(value) => onPolicyChange(value as ToolPolicyDecision)}
        >
          <SelectTrigger size="sm" aria-label="Tool policy">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="allow">allow</SelectItem>
            <SelectItem value="block">block</SelectItem>
            <SelectItem value="ask">ask</SelectItem>
          </SelectContent>
        </Select>
        <button
          type="button"
          onClick={() => setOpen((previous) => !previous)}
          aria-expanded={open}
          aria-label={open ? "Hide description" : "Show description"}
          className="shrink-0 p-1 text-muted-foreground"
        >
          <ChevronDown
            aria-hidden
            className={`size-4 transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>
      </div>
      {open ? (
        <div className="px-4 pb-2.5 text-xs">
          {tool.description ? (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                p: ({ children }) => <p>{children}</p>,
              }}
            >
              {tool.description}
            </ReactMarkdown>
          ) : (
            <p className="text-muted-foreground">No description</p>
          )}
        </div>
      ) : null}
    </Card>
  );
}
