import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface ToolNode {
  id: string;
  label: string;
}

interface ToolTreeProps {
  data: ToolNode[];
  placeholder?: string;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  className?: string;
}

export function ToolTree({
  data,
  placeholder = "Filter tools...",
  selectedId = null,
  onSelect,
  className,
}: ToolTreeProps) {
  const [query, setQuery] = useState("");

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return data;
    return data.filter((node) => (node.label ?? "").toLowerCase().includes(q));
  }, [data, query]);

  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-1 flex-col rounded-lg border border-border bg-background p-1.5",
        className,
      )}
    >
      <div className="relative mb-1 shrink-0 px-1 pt-0.5">
        <Search className="pointer-events-none absolute top-3 left-3.5 h-3.5 w-3.5 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={placeholder}
          className="h-8 border-0 bg-transparent pr-1 pl-7 text-sm shadow-none focus-visible:ring-0"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {visible.length === 0 ? (
          <p className="px-3 py-4 text-center text-sm text-muted-foreground">
            No tools match the current search.
          </p>
        ) : null}
        {visible.map((node) => {
          const isSelected = selectedId === node.id;
          return (
            <button
              key={node.id}
              type="button"
              onClick={() => onSelect?.(node.id)}
              aria-current={isSelected ? "true" : undefined}
              className={cn(
                "flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-sm text-foreground/90 outline-none",
                "hover:bg-accent/60 focus-visible:bg-accent/60",
                isSelected && "bg-accent",
              )}
            >
              <span className="truncate">{node.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
