import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

interface DataStateAction {
  label: string;
  onClick: () => void;
  variant?: "default" | "outline" | "secondary" | "ghost";
}

interface DataStateProps {
  state: "loading" | "empty" | "error" | "content";
  title: string;
  description?: string;
  icon?: LucideIcon;
  primaryAction?: DataStateAction;
  secondaryAction?: DataStateAction;
  onRetry?: () => void;
  retryLabel?: string;
  children?: ReactNode;
  className?: string;
  skeletonLines?: number;
}

export function DataState({
  state,
  title,
  description,
  icon: Icon,
  primaryAction,
  secondaryAction,
  onRetry,
  retryLabel = "Retry",
  children,
  className,
  skeletonLines = 3,
}: DataStateProps) {
  if (state === "content") {
    return <>{children}</>;
  }

  if (state === "loading") {
    return (
      <div
        className={cn("flex flex-col gap-2 p-4", className)}
        role="status"
        aria-label={`Loading ${title}`}
      >
        <p className="text-sm text-muted-foreground">Loading {title}…</p>
        {Array.from({ length: skeletonLines }).map((_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: skeleton placeholders have no stable identity
          <Skeleton key={`skeleton-${index}`} className="h-10 w-full" />
        ))}
      </div>
    );
  }

  if (state === "error") {
    return (
      <Alert variant="destructive" className={cn("m-4 w-auto", className)}>
        {Icon ? <Icon aria-hidden /> : null}
        <AlertTitle>{title}</AlertTitle>
        {description ? (
          <AlertDescription>{description}</AlertDescription>
        ) : null}
        <div className="col-start-2 mt-3 flex flex-wrap gap-2">
          {onRetry ? (
            <Button type="button" size="sm" onClick={onRetry}>
              {retryLabel}
            </Button>
          ) : null}
          {primaryAction ? (
            <Button
              type="button"
              size="sm"
              variant={primaryAction.variant ?? "outline"}
              onClick={primaryAction.onClick}
            >
              {primaryAction.label}
            </Button>
          ) : null}
          {secondaryAction ? (
            <Button
              type="button"
              size="sm"
              variant={secondaryAction.variant ?? "ghost"}
              onClick={secondaryAction.onClick}
            >
              {secondaryAction.label}
            </Button>
          ) : null}
        </div>
      </Alert>
    );
  }

  // empty
  return (
    <Empty className={className}>
      <EmptyHeader>
        {Icon ? (
          <EmptyMedia variant="icon">
            <Icon aria-hidden />
          </EmptyMedia>
        ) : null}
        <EmptyTitle>{title}</EmptyTitle>
        {description ? (
          <EmptyDescription>{description}</EmptyDescription>
        ) : null}
      </EmptyHeader>
      {primaryAction || secondaryAction ? (
        <EmptyContent>
          <div className="flex flex-wrap items-center justify-center gap-2">
            {primaryAction ? (
              <Button
                type="button"
                size="sm"
                variant={primaryAction.variant ?? "default"}
                onClick={primaryAction.onClick}
              >
                {primaryAction.label}
              </Button>
            ) : null}
            {secondaryAction ? (
              <Button
                type="button"
                size="sm"
                variant={secondaryAction.variant ?? "outline"}
                onClick={secondaryAction.onClick}
              >
                {secondaryAction.label}
              </Button>
            ) : null}
          </div>
        </EmptyContent>
      ) : null}
    </Empty>
  );
}
