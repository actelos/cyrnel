import {
  AlertTriangle,
  ArrowUpRight,
  ChevronDown,
  CircleCheck,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import useSWR from "swr";
import { z } from "zod";
import { SetupWizard } from "@/components/setup-wizard";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useNotification } from "@/hooks/use-notification";
import { apiFetch, apiFetchJson, buildUrl, errorMessageFrom } from "@/lib/api";

const registryServiceEntrySchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  source: z.string(),
  kind: z.string().optional(),
  icon: z.object({ url: z.string(), hash: z.string() }).optional(),
});

export type RegistryServiceEntry = z.infer<typeof registryServiceEntrySchema>;

const installAdapterItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  compatible: z.boolean(),
  active: z.boolean(),
  isBuiltin: z.boolean(),
});

const installAdaptersResponseSchema = z.object({
  default: z.string().nullable(),
  adapters: z.array(installAdapterItemSchema),
});

const installResponseSchema = z.object({ id: z.string() });

type InstallAdaptersResponse = z.infer<typeof installAdaptersResponseSchema>;

interface AdapterItem {
  value: string;
  label: string;
  compatible: boolean;
  active: boolean;
  isBuiltin: boolean;
  isDefault: boolean;
}

function adapterReason(item: AdapterItem, kind: string | undefined): string {
  if (item.compatible && item.active) {
    const builtin = item.isBuiltin ? ", built-in" : "";
    const prefix = item.isDefault ? "Recommended" : "Compatible";
    return `${prefix} — accepts ${kind ?? "this definition kind"} and is currently active${builtin}.`;
  }
  if (item.compatible) {
    return `Inactive — enable the ${item.label} module to use it. Installation will fail without an active adapter.`;
  }
  return `Not compatible — does not accept ${kind ?? "this definition kind"}. Installation with this adapter will fail.`;
}

function getAdapterStatus(
  item: AdapterItem | null,
): "recommended" | "unsure" | "not-recommended" {
  if (!item) return "recommended";
  if (item.compatible && item.active) return "recommended";
  if (item.compatible) return "unsure";
  return "not-recommended";
}

function getAdapterIcon(status: "recommended" | "unsure" | "not-recommended") {
  switch (status) {
    case "recommended":
      return CircleCheck;
    case "unsure":
      return AlertTriangle;
    case "not-recommended":
      return XCircle;
  }
}

function toBase64(buf: Uint8Array | null | undefined): string {
  if (!buf) return "";
  let binary = "";
  for (let i = 0; i < buf.length; i++) {
    binary += String.fromCharCode(buf[i]);
  }
  return btoa(binary);
}

function buildAdapterItems(
  ranked: InstallAdaptersResponse | undefined,
): AdapterItem[] {
  if (!ranked) return [];
  return ranked.adapters.map((adapter) => ({
    value: adapter.id,
    label: adapter.name,
    compatible: adapter.compatible,
    active: adapter.active,
    isBuiltin: adapter.isBuiltin,
    isDefault: ranked.default === adapter.id,
  }));
}

export function RegistryServiceCard({
  entry,
  registryId,
  onInstalled,
  installedServiceId = null,
}: {
  entry: RegistryServiceEntry;
  registryId: string;
  onInstalled: () => void | Promise<void>;
  installedServiceId?: string | null;
}) {
  const { addNotification } = useNotification();
  const navigate = useNavigate();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pendingAdapter, setPendingAdapter] = useState<string | undefined>(
    undefined,
  );
  const [dialogId, setDialogId] = useState(entry.id);
  const [dialogVersion, setDialogVersion] = useState("latest");
  const [dialogAutoUpdate, setDialogAutoUpdate] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [installedId, setInstalledId] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);

  const adapterUrl = buildUrl("/services/install/adapters", {
    kind: entry.kind ?? undefined,
  });

  const { data: ranked } = useSWR(adapterUrl, (url) =>
    apiFetchJson(url, installAdaptersResponseSchema),
  );

  const { data: iconData } = useSWR(
    entry.icon ? `${registryId}/definitions/${entry.id}/icon` : null,
    async () => {
      if (!entry.icon) return "";
      const res = await apiFetch(
        buildUrl(`/registries/${registryId}/definitions/${entry.id}/icon`),
      );
      const bytes = await res.arrayBuffer();
      return toBase64(new Uint8Array(bytes));
    },
    {
      revalidateOnFocus: false,
      revalidateIfStale: false,
    },
  );

  const adapterItems = entry.kind ? buildAdapterItems(ranked) : [];
  const adaptersLoaded = !entry.kind || ranked !== undefined;
  const recommended =
    adapterItems.find(
      (item) => item.isDefault && item.compatible && item.active,
    ) ?? null;
  const compatibleOthers = adapterItems.filter(
    (item) => item !== recommended && item.compatible && item.active,
  );
  const otherAdapters = adapterItems.filter(
    (item) => item !== recommended && (!item.compatible || !item.active),
  );
  const installOptions = [...compatibleOthers, ...otherAdapters];

  const selectedAdapterItem =
    pendingAdapter === undefined
      ? null
      : (adapterItems.find((item) => item.value === pendingAdapter) ?? null);

  const openInstallDialog = (adapterId?: string) => {
    setPendingAdapter(adapterId);
    setDialogId(entry.id);
    setDialogVersion("latest");
    setDialogOpen(true);
  };

  const handleConfirmInstall = async () => {
    if (installing) return;
    const trimmedId = dialogId.trim();
    const trimmedVersion = dialogVersion.trim();
    const body: Record<string, string | boolean> = { source: entry.source };
    if (trimmedId !== "" && trimmedId !== entry.id) body.id = trimmedId;
    if (trimmedVersion !== "") body.version = trimmedVersion;
    if (pendingAdapter?.trim()) body.adapter = pendingAdapter.trim();
    body.autoUpdate = dialogAutoUpdate;

    setInstalling(true);
    try {
      const created = await apiFetchJson(
        buildUrl("/services/install"),
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

  const handlePrimaryClick = () => {
    if (installing) return;
    if (!adaptersLoaded || recommended || installOptions.length === 0) {
      openInstallDialog(recommended?.value);
    } else {
      setMenuOpen(true);
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
            <span
              className="block truncate text-sm font-semibold"
              title={entry.name ?? entry.id}
            >
              {entry.name ?? entry.id}
            </span>
            <span
              className="block max-w-full truncate font-mono text-xs text-muted-foreground"
              title={entry.id}
            >
              {entry.id}
            </span>
          </span>
        </button>
        {installedServiceId ? (
          <Button
            type="button"
            size="sm"
            className="mt-0.5 shrink-0 gap-1"
            asChild
          >
            <Link to={`/services/${installedServiceId}`}>
              Open
              <ArrowUpRight />
            </Link>
          </Button>
        ) : (
          <ButtonGroup className="mt-0.5 shrink-0">
            <Button
              type="button"
              size="sm"
              disabled={installing}
              onClick={handlePrimaryClick}
              className="rounded-r-none"
            >
              {installing ? "Installing" : "Install"}
            </Button>
            <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  aria-label="Choose adapter"
                  disabled={
                    installing || !adaptersLoaded || installOptions.length === 0
                  }
                  className="rounded-l-none border-l-0 px-2"
                >
                  <ChevronDown />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-72">
                {compatibleOthers.length > 0 ? (
                  <>
                    <DropdownMenuLabel>Compatible adapters</DropdownMenuLabel>
                    {compatibleOthers.map((item) => (
                      <DropdownMenuItem
                        key={item.value}
                        title={adapterReason(item, entry.kind)}
                        onSelect={() => openInstallDialog(item.value)}
                      >
                        {item.label}
                        {item.isDefault ? " (recommended)" : ""}
                      </DropdownMenuItem>
                    ))}
                  </>
                ) : null}
                {compatibleOthers.length > 0 && otherAdapters.length > 0 ? (
                  <DropdownMenuSeparator />
                ) : null}
                {otherAdapters.length > 0 ? (
                  <>
                    <DropdownMenuLabel>Other adapters</DropdownMenuLabel>
                    {otherAdapters.map((item) => (
                      <DropdownMenuItem
                        key={item.value}
                        title={adapterReason(item, entry.kind)}
                        onSelect={() => openInstallDialog(item.value)}
                      >
                        {item.label}{" "}
                        <span className="text-muted-foreground">
                          ({item.compatible ? "inactive" : "kind mismatch"}
                          {item.isDefault ? ", recommended" : ""})
                        </span>
                      </DropdownMenuItem>
                    ))}
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </ButtonGroup>
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
              {entry.kind ? (
                <Badge
                  variant="secondary"
                  className="mt-0.5 max-w-[16ch] shrink-0 justify-start"
                  title={entry.kind}
                >
                  <span className="min-w-0 truncate">{entry.kind}</span>
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
            <DialogDescription className="flex items-center gap-2">
              Installing using{" "}
              <Link
                to={`/settings/modules/${selectedAdapterItem?.value}`}
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-primary"
              >
                {selectedAdapterItem?.label}
              </Link>
              <span className="flex items-center">
                {(() => {
                  const status = getAdapterStatus(selectedAdapterItem);
                  const Icon = getAdapterIcon(status);
                  const reason = selectedAdapterItem
                    ? adapterReason(selectedAdapterItem, entry.kind)
                    : recommended
                      ? adapterReason(recommended, entry.kind)
                      : "No recommended adapter available";
                  return (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Icon className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground cursor-help" />
                      </TooltipTrigger>
                      <TooltipContent side="top" align="center">
                        {reason}
                      </TooltipContent>
                    </Tooltip>
                  );
                })()}
              </span>
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 my-2">
            <div className="space-y-1">
              <Label htmlFor={`${entry.id}-dialog-id`}>Service id</Label>
              <Input
                id={`${entry.id}-dialog-id`}
                className="h-8 text-xs"
                placeholder={entry.id}
                value={dialogId}
                disabled={installing}
                onChange={(event) => setDialogId(event.target.value)}
              />
            </div>
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
                Semver range, exact version constraints.
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
                Automatic updates
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
        kind="service"
        id={installedId}
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        onCompleted={() => {
          if (installedId) navigate(`/services/${installedId}`);
        }}
      />
    </div>
  );
}
