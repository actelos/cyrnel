import { Maximize2 } from "lucide-react";
import { useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { SyntaxHighlight } from "@/components/syntax-highlight";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export type DetailVariant = "default" | "code" | "error";

const detailBoxClass = (variant: DetailVariant) => {
  if (variant === "error") {
    return "border border-destructive/40 bg-destructive/5 text-destructive";
  }
  return "border bg-muted/30";
};

interface DetailViewProps {
  title: string;
  content: string;
  variant?: DetailVariant;
  language?: string;
  boxClassName?: string;
  className?: string;
}

function DetailView({
  title,
  content,
  variant = "default",
  language,
  boxClassName,
  className,
}: DetailViewProps) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className={cn("relative", className)}>
      <div className="absolute right-2 top-2 z-10 flex gap-1 overflow-auto">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="h-8 w-8 p-0"
          aria-label={`Expand ${title}`}
          onClick={() => setIsOpen(true)}
        >
          <Maximize2 />
        </Button>
        <CopyButton value={content} variant="secondary" iconOnly />
      </div>
      <div
        className={cn(
          "flex w-full overflow-auto p-3 pr-19 text-xs font-mono whitespace-pre",
          detailBoxClass(variant),
          boxClassName ?? "min-h-24 max-h-62",
        )}
      >
        <SyntaxHighlight code={content} language={language} />
      </div>
      <DetailViewDialog
        open={isOpen}
        onOpenChange={setIsOpen}
        title={title}
        content={content}
        variant={variant}
        language={language}
      />
    </div>
  );
}

interface DetailViewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  content: string;
  variant?: DetailVariant;
  language?: string;
}

function DetailViewDialog({
  open,
  onOpenChange,
  title,
  content,
  variant = "default",
  language,
}: DetailViewDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-10/12 max-w-3xl space-y-4">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="relative min-h-0 flex-1 mb-0">
          <CopyButton
            value={content}
            variant="secondary"
            iconOnly
            className="absolute right-2 top-2 z-10"
          />
          <div
            className={cn(
              "max-h-90 min-h-[200px] overflow-auto",
              detailBoxClass(variant),
            )}
          >
            <div className="h-full w-max p-4 pr-12">
              <div className="text-xs font-mono whitespace-pre">
                <SyntaxHighlight code={content} language={language} />
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export { DetailView, DetailViewDialog };
