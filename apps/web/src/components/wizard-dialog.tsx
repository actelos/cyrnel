import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export interface WizardStep {
  id: string;
  title: string;
  description?: string;
  content: React.ReactNode;
  canProceed?: boolean;
  validationMessage?: string;
}

interface WizardDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  steps: WizardStep[];
  initialStep?: number;
  onFinish: () => void | Promise<void>;
  finishLabel?: string;
  onSkip?: () => void;
  skipLabel?: string;
  isFinishing?: boolean;
  finishError?: string | null;
}

export function WizardDialog({
  open,
  onOpenChange,
  title,
  description,
  steps,
  initialStep = 0,
  onFinish,
  finishLabel = "Finish",
  onSkip,
  skipLabel = "Skip setup",
  isFinishing = false,
  finishError = null,
}: WizardDialogProps) {
  const [current, setCurrent] = useState(initialStep);
  const [isBusy, setIsBusy] = useState(false);
  const step = steps[current];
  const isLast = current === steps.length - 1;
  const canProceed = step?.canProceed ?? true;

  const handleNext = () => {
    if (!isLast) setCurrent((c) => Math.min(c + 1, steps.length - 1));
  };

  const handleFinish = async () => {
    setIsBusy(true);
    try {
      await onFinish();
    } finally {
      setIsBusy(false);
    }
  };

  if (steps.length === 0) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-lg"
        aria-describedby={description ? undefined : undefined}
      >
        <DialogHeader className="pb-4">
          <DialogTitle>{title}</DialogTitle>
          {description ? (
            <DialogDescription>{description}</DialogDescription>
          ) : null}
        </DialogHeader>

        <ol className="flex items-center gap-2" aria-label="Setup progress">
          {steps.map((s, index) => (
            <li key={s.id} className="flex flex-1 items-center gap-2">
              <button
                type="button"
                onClick={() => setCurrent(index)}
                disabled={isBusy || isFinishing || index === current}
                aria-current={index === current ? "step" : undefined}
                aria-label={`Go to step ${index + 1}: ${s.title}`}
                className={cn(
                  "flex items-center gap-2 rounded-sm",
                  index === current
                    ? "cursor-default"
                    : "cursor-pointer hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                )}
              >
                <span
                  className={cn(
                    "flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium",
                    index < current
                      ? "bg-primary text-primary-foreground"
                      : index === current
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground",
                  )}
                >
                  {index + 1}
                </span>
                <span
                  className={cn(
                    "hidden text-xs sm:block",
                    index === current
                      ? "font-medium text-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  {s.title}
                </span>
              </button>
              {index < steps.length - 1 ? (
                <span className="h-px flex-1 bg-border" aria-hidden />
              ) : null}
            </li>
          ))}
        </ol>

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pt-4">
          <h3 className="text-sm font-medium">{step?.title}</h3>
          {step?.description ? (
            <p className="text-sm text-muted-foreground">{step.description}</p>
          ) : null}
          <div>{step?.content}</div>
          {!canProceed && step?.validationMessage ? (
            <p className="text-xs text-muted-foreground">
              {step.validationMessage}
            </p>
          ) : null}
          {finishError ? (
            <p className="text-sm text-destructive">{finishError}</p>
          ) : null}
        </div>

        <DialogFooter className="flex-wrap gap-2">
          {onSkip ? (
            <Button
              type="button"
              variant="ghost"
              onClick={onSkip}
              disabled={isBusy || isFinishing}
            >
              {skipLabel}
            </Button>
          ) : null}
          <span className="flex-1" />
          {!isLast ? (
            <Button
              type="button"
              onClick={handleNext}
              disabled={!canProceed || isBusy || isFinishing}
            >
              Next
            </Button>
          ) : (
            <Button
              type="button"
              onClick={() => void handleFinish()}
              disabled={!canProceed || isBusy || isFinishing}
            >
              {isBusy || isFinishing ? "Finishing…" : finishLabel}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
