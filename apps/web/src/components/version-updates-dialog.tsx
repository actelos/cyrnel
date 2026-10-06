import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { formatVersion } from "@/lib/format";

interface VersionUpdatesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: "service" | "module";
  installedVersion: string;
  autoUpdate: boolean;
  autoUpdateConstraint: string | null;
  hasSource: boolean;
  latest: string | null;
  available: string | null;
  upToDate: boolean | null;
  constraintDraft: string;
  onConstraintDraftChange: (value: string) => void;
  isSaving: boolean;
  isChecking: boolean;
  onToggleAutoUpdate: (next: boolean) => void;
  onSaveConstraint: () => void;
  onCheckForUpdate: () => void;
}

export function VersionUpdatesDialog({
  open,
  onOpenChange,
  kind,
  installedVersion,
  autoUpdate,
  autoUpdateConstraint,
  hasSource,
  latest,
  available,
  upToDate,
  constraintDraft,
  onConstraintDraftChange,
  isSaving,
  isChecking,
  onToggleAutoUpdate,
  onSaveConstraint,
  onCheckForUpdate,
}: VersionUpdatesDialogProps) {
  const _label = kind === "service" ? "Service" : "Module";
  const switchId = `${kind}-auto-update-dialog`;
  const constraintId = `${kind}-update-constraint-dialog`;
  const constraintDirty =
    (constraintDraft ?? "").trim() !== (autoUpdateConstraint ?? "").trim();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Version & updates</DialogTitle>
          <DialogDescription>
            Installed version, update policy, and automatic updates for this{" "}
            {kind}.
          </DialogDescription>
        </DialogHeader>
        <dl className="grid gap-x-6 gap-y-3 pt-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground text-xs">Installed version</dt>
            <dd className="font-mono text-xs">
              {formatVersion(installedVersion)}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs">Update policy</dt>
            <dd className="font-mono text-xs">
              {autoUpdateConstraint ?? "Latest"}
              {latest ? ` (latest ${formatVersion(latest)})` : ""}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs">Available</dt>
            <dd className="font-mono text-xs">
              {available
                ? `${formatVersion(available)}${upToDate ? " (up to date)" : ""}`
                : "Not checked yet"}
            </dd>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              id={switchId}
              checked={autoUpdate}
              disabled={!hasSource || isSaving}
              onCheckedChange={(checked) =>
                onToggleAutoUpdate(checked === true)
              }
              aria-label="Automatic updates"
              className="mt-0.5 rounded-none [&_span]:rounded-none"
            />
            <Label htmlFor={switchId} className="text-xs font-normal">
              Automatic updates
              {!hasSource ? " (unavailable without a registry source)" : ""}
            </Label>
          </div>
        </dl>
        {hasSource ? (
          <div className="flex flex-wrap items-end gap-2 pt-4">
            <div className="min-w-44 flex-1 space-y-1">
              <Label htmlFor={constraintId} className="text-xs">
                Update constraint
              </Label>
              <Input
                id={constraintId}
                value={constraintDraft ?? ""}
                onChange={(event) =>
                  onConstraintDraftChange(event.target.value)
                }
                placeholder="Latest (e.g. ^1.4.0)"
                className="font-mono text-xs"
              />
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={isSaving || !constraintDirty}
              onClick={onSaveConstraint}
            >
              {isSaving ? "Saving…" : "Save policy"}
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            This {kind} has no registry source. Use manual update with a direct
            URL instead.
          </p>
        )}
        <div className="flex items-center justify-end gap-2 pt-4">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isChecking}
            onClick={onCheckForUpdate}
          >
            {isChecking ? "Checking…" : "Check for update"}
          </Button>
          <Button type="button" size="sm" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
