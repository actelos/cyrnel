import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { useNotification } from "@/hooks/use-notification";
import { copyToClipboard } from "@/lib/copy";
import { cn } from "@/lib/utils";

type CopyButtonProps = Omit<ButtonProps, "onClick"> & {
  value: string;
  label?: string;
  copiedLabel?: string;
  iconOnly?: boolean;
  errorMessage?: string;
};

function CopyButton({
  value,
  label = "Copy",
  copiedLabel = "Copied",
  iconOnly = false,
  errorMessage = "Unable to copy. Select the value manually.",
  size = "sm",
  variant,
  className,
  ...props
}: CopyButtonProps) {
  const { addNotification } = useNotification();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);

  const handleCopy = async () => {
    const ok = await copyToClipboard(value);
    if (!ok) {
      addNotification({
        type: "error",
        title: "Error",
        message: errorMessage,
      });
      return;
    }
    setCopied(true);
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }
    timerRef.current = window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Button
      type="button"
      data-slot="copy-button"
      variant={variant}
      size={size}
      className={cn("gap-1", iconOnly && "h-8 w-8 p-0", className)}
      onClick={() => void handleCopy()}
      {...props}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {!iconOnly ? (copied ? copiedLabel : label) : null}
    </Button>
  );
}

export { CopyButton };
