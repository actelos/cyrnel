import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "@/lib/utils";

const alertVariants = cva(
  "relative w-full rounded-none border px-4 py-3 text-sm grid has-[>svg]:grid-cols-[calc(var(--icon-size)_+_theme(spacing.3))_1fr] has-[>svg]:gap-x-3 grid-cols-[0_1fr] has-data-[slot=alert-title)]:mb-1 [&>svg]:size-(--icon-size) [&>svg]:text-current [&>svg]:pointer-events-none [&>svg]:shrink-0 [&>svg]:place-self-center",
  {
    variants: {
      variant: {
        default:
          "border-border bg-background text-foreground [&>svg]:text-foreground",
        destructive:
          "border-destructive/50 text-destructive bg-destructive/5 dark:border-destructive/20 [&>svg]:text-destructive",
        success:
          "border-emerald-500/50 text-emerald-700 bg-emerald-50 dark:border-emerald-500/20 dark:text-emerald-400 dark:bg-emerald-950/20 [&>svg]:text-emerald-600 dark:[&>svg]:text-emerald-400",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Alert({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      role="alert"
      data-variant={variant}
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        "col-start-2 line-clamp-1 min-h-4 font-medium tracking-tight",
        className,
      )}
      {...props}
    />
  );
}

function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "col-start-2 text-xs/relaxed text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export { Alert, AlertDescription, AlertTitle, alertVariants };
