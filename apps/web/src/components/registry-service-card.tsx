import { ArrowUpRight, ChevronDown } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import useSWR from "swr";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
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
import { useNotification } from "@/hooks/use-notification";
import { apiFetch, apiFetchJson, buildUrl, errorMessageFrom } from "@/lib/api";

const registryServiceEntrySchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  source: z.string(),
  kind: z.string().optional(),
  icon: z.string().optional(),
});

export type RegistryServiceEntry = z.infer<typeof registryServiceEntrySchema>;

const installAdapterItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  compatible: z.boolean(),
  active: z.boolean(),
});

const installAdaptersResponseSchema = z.object({
  default: z.string().nullable(),
  adapters: z.array(installAdapterItemSchema),
});

type InstallAdaptersResponse = z.infer<typeof installAdaptersResponseSchema>;

function toBase64(buf: Uint8Array | null | undefined): string {
  if (!buf) return "";
  let binary = "";
  for (let i = 0; i < buf.length; i++) {
    binary += String.fromCharCode(buf[i]);
  }
  return btoa(binary);
}

function buildAdapterItems(ranked: InstallAdaptersResponse | undefined): Array<{
  value: string;
  label: string;
  compatible: boolean;
  active: boolean;
  isDefault: boolean;
}> {
  if (!ranked) return [];
  return ranked.adapters.map((adapter) => ({
    value: adapter.id,
    label: adapter.name,
    compatible: adapter.compatible,
    active: adapter.active,
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
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pendingAdapter, setPendingAdapter] = useState<string | undefined>(
    undefined,
  );
  const [dialogId, setDialogId] = useState(entry.id);
  const [dialogVersion, setDialogVersion] = useState("latest");
  const [installing, setInstalling] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

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
      refreshInterval: 30000,
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

  const pendingAdapterLabel =
    pendingAdapter === undefined
      ? "Automatic"
      : (adapterItems.find((item) => item.value === pendingAdapter)?.label ??
        pendingAdapter);

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
    const body: Record<string, string> = { source: entry.source };
    if (trimmedId !== "" && trimmedId !== entry.id) body.id = trimmedId;
    if (trimmedVersion !== "") body.version = trimmedVersion;
    if (pendingAdapter?.trim()) body.adapter = pendingAdapter.trim();

    setInstalling(true);
    try {
      await apiFetch(buildUrl("/services/install"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      addNotification({
        type: "success",
        title: "Success",
        message: `${entry.name ?? entry.id} installed.`,
      });
      setDialogOpen(false);
      await onInstalled();
    } catch (error) {
      addNotification({
        type: "error",
        title: "Error",
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
              className="h-10 w-10 shrink-0 rounded-md bg-secondary object-contain p-1"
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
                    className="h-10 w-10 shrink-0 rounded-md bg-secondary object-contain p-1"
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
            <DialogDescription>
              Adapter: {pendingAdapterLabel}. Id and version are optional.
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
    </div>
  );
}
