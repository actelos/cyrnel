import { ArrowUpRight } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import useSWR from "swr";
import { z } from "zod";
import { SetupWizard } from "@/components/setup-wizard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useNotification } from "@/hooks/use-notification";
import { apiFetch, apiFetchJson, buildUrl, errorMessageFrom } from "@/lib/api";

const registryModuleEntrySchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  source: z.string(),
  kind: z.string().optional(),
  type: z.enum(["adapter", "environment"]).optional(),
  icon: z.object({ url: z.string(), hash: z.string() }).optional(),
});

export type RegistryModuleEntry = z.infer<typeof registryModuleEntrySchema>;

const installResponseSchema = z.object({ id: z.string() }).passthrough();

function toBase64(buf: Uint8Array | null | undefined): string {
  if (!buf) return "";
  let binary = "";
  for (let i = 0; i < buf.length; i++) {
    binary += String.fromCharCode(buf[i]);
  }
  return btoa(binary);
}

export function RegistryModuleCard({
  entry,
  registryId,
  onInstalled,
  installedModuleId = null,
}: {
  entry: RegistryModuleEntry;
  registryId: string;
  onInstalled: () => void | Promise<void>;
  installedModuleId?: string | null;
}) {
  const { addNotification } = useNotification();
  const navigate = useNavigate();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogVersion, setDialogVersion] = useState("latest");
  const [dialogAutoUpdate, setDialogAutoUpdate] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [installedId, setInstalledId] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);

  const { data: iconData } = useSWR(
    entry.icon ? `${registryId}/modules/${entry.id}/icon` : null,
    async () => {
      if (!entry.icon) return "";
      const res = await apiFetch(
        buildUrl(`/registries/${registryId}/modules/${entry.id}/icon`),
      );
      const bytes = await res.arrayBuffer();
      return toBase64(new Uint8Array(bytes));
    },
    {
      refreshInterval: 30000,
    },
  );

  const handleConfirmInstall = async () => {
    if (installing) return;
    const trimmedVersion = dialogVersion.trim();
    // Note: the module id always comes from the registry manifest; only
    // source, version, and auto-update are sent.
    const body: Record<string, string | boolean> = { source: entry.source };
    if (trimmedVersion !== "") body.version = trimmedVersion;
    body.autoUpdate = dialogAutoUpdate;

    setInstalling(true);
    try {
      const created = await apiFetchJson(
        buildUrl("/modules/install"),
        installResponseSchema,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      addNotification({
        type: "success",
        title: `${entry.name ?? entry.id} installed`,
        message: `${entry.name ?? entry.id} installed.`,
      });
      setDialogOpen(false);
      await onInstalled();
      setInstalledId(created.id);
      setWizardOpen(true);
    } catch (error) {
      addNotification({
        type: "error",
        title: `${entry.name ?? entry.id} installation failed`,
        message: errorMessageFrom(
          error,
          `Unable to install ${entry.name ?? entry.id}.`,
        ),
      });
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className="flex flex-col justify-between border border-border bg-card">
      <div className="flex items-center gap-3 p-4">
        <button
          type="button"
          onClick={() => setDetailsOpen(true)}
          aria-label={`View ${entry.name ?? entry.id} details`}
          className="flex min-w-0 flex-1 cursor-pointer items-start gap-3 text-left"
        >
          {entry.icon && iconData ? (
            <img
              src={`data:image/png;base64,${iconData}`}
              alt=""
              loading="lazy"
              className="h-10 w-10 shrink-0 rounded-md object-contain"
            />
          ) : (
            <span
              aria-hidden
              className="inline-flex h-10 w-10 shrink-0 items-center justify-center bg-secondary text-sm font-semibold text-secondary-foreground"
            >
              {(entry.name ?? entry.id).trim().charAt(0).toUpperCase()}
            </span>
          )}
          <span className="min-w-0 flex-1 space-y-1">
            <span className="flex items-center gap-2">
              <span
                className="min-w-0 flex-1 truncate text-sm font-semibold"
                title={entry.name ?? entry.id}
              >
                {entry.name ?? entry.id}
              </span>
            </span>
            <span
              className="block max-w-full truncate font-mono text-xs text-muted-foreground"
              title={entry.id}
            >
              {entry.id}
            </span>
          </span>
        </button>
        {installedModuleId ? (
          <Button
            type="button"
            size="sm"
            className="mt-0.5 shrink-0 gap-1"
            asChild
          >
            <Link to={`/settings/modules/${installedModuleId}`}>
              Open
              <ArrowUpRight />
            </Link>
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            className="mt-0.5 shrink-0"
            disabled={installing}
            onClick={() => setDialogOpen(true)}
          >
            {installing ? "Installing" : "Install"}
          </Button>
        )}
      </div>
      <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <div className="flex items-start justify-between gap-3 pr-8">
              <div className="flex min-w-0 flex-1 items-start gap-3">
                {entry.icon && iconData ? (
                  <img
                    src={`data:image/png;base64,${iconData}`}
                    alt=""
                    loading="lazy"
                    className="h-10 w-10 shrink-0 rounded-md object-contain"
                  />
                ) : (
                  <span
                    aria-hidden
                    className="inline-flex h-10 w-10 shrink-0 items-center justify-center bg-secondary text-sm font-semibold text-secondary-foreground"
                  >
                    {(entry.name ?? entry.id).trim().charAt(0).toUpperCase()}
                  </span>
                )}
                <div className="min-w-0 flex-1 space-y-1">
                  <DialogTitle
                    className="truncate"
                    title={entry.name ?? entry.id}
                  >
                    {entry.name ?? entry.id}
                  </DialogTitle>
                  <DialogDescription
                    className="truncate font-mono"
                    title={entry.id}
                  >
                    {entry.id}
                  </DialogDescription>
                </div>
              </div>
              {entry.type ? (
                <Badge variant="secondary" className="mt-0.5 shrink-0">
                  {entry.type}
                </Badge>
              ) : null}
            </div>
          </DialogHeader>
          <div className="my-2 grid gap-3">
            <p className="break-words text-sm whitespace-pre-wrap">
              {entry.description ?? "No description"}
            </p>
            <div className="space-y-1">
              <p className="text-xs font-medium">Source</p>
              <p
                className="truncate font-mono text-xs text-muted-foreground"
                title={entry.source}
              >
                {entry.source}
              </p>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Install {entry.name ?? entry.id}</DialogTitle>
            <DialogDescription>
              The module id comes from the registry manifest. Version is
              optional.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 my-2">
            <div className="space-y-1">
              <Label htmlFor={`${entry.id}-dialog-version`}>Version</Label>
              <Input
                id={`${entry.id}-dialog-version`}
                className="h-8 text-xs"
                placeholder="latest"
                value={dialogVersion}
                disabled={installing}
                onChange={(event) => setDialogVersion(event.target.value)}
              />
              <p className="text-muted-foreground text-xs">
                Semver range or exact version. Blank or “latest” installs the
                latest registry version.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id={`${entry.id}-dialog-auto-update`}
                checked={dialogAutoUpdate}
                disabled={installing}
                onCheckedChange={(checked) =>
                  setDialogAutoUpdate(checked === true)
                }
              />
              <Label
                htmlFor={`${entry.id}-dialog-auto-update`}
                className="text-xs font-normal"
              >
                Automatic updates (follow new versions on the background sweep)
              </Label>
            </div>
          </div>
          <DialogFooter className="flex-row justify-end">
            <DialogClose asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={installing}
              >
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="button"
              size="sm"
              disabled={installing}
              onClick={() => void handleConfirmInstall()}
            >
              {installing ? "Installing" : "Install"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <SetupWizard
        kind="module"
        id={installedId}
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        onCompleted={() => {
          if (installedId) navigate(`/settings/modules/${installedId}`);
        }}
      />
    </div>
  );
}
