import { useState } from "react";
import { buildUrl } from "@/lib/api";
import { cn } from "@/lib/utils";

interface EntityIconProps {
  kind: "service" | "module";
  id: string;
  label: string;
  hasIcon: boolean;
  className?: string;
}

export function EntityIcon({
  kind,
  id,
  label,
  hasIcon,
  className,
}: EntityIconProps) {
  const [failed, setFailed] = useState(false);
  const src = buildUrl(`/${kind}s/${encodeURIComponent(id)}/icon`);

  if (!hasIcon || failed) {
    const initial = label.trim().charAt(0).toUpperCase() || "?";
    return (
      <span
        aria-hidden
        className={cn(
          "inline-flex h-10 w-10 shrink-0 items-center justify-center bg-secondary text-sm font-semibold text-secondary-foreground",
          className,
        )}
      >
        {initial}
      </span>
    );
  }

  return (
    <img
      src={src}
      alt={`${label} icon`}
      loading="lazy"
      onError={() => setFailed(true)}
      className={cn(
        "h-10 w-10 shrink-0 rounded-md bg-secondary object-contain p-1",
        className,
      )}
    />
  );
}
