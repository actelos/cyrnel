import { KeyRound } from "lucide-react";
import type { ReactNode } from "react";
import { useId, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { z } from "zod";
import AuthSection, { type AuthSchemeInfo } from "@/components/AuthSection";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useNotification } from "@/hooks/use-notification";
import { apiFetchJson, buildUrl, errorMessageFrom } from "@/lib/api";

const addRegistryResponseSchema = z
  .object({
    id: z.string(),
    baseUrl: z.string(),
    auth: z
      .object({
        schemes: z.record(
          z.string(),
          z.object({ type: z.string() }).passthrough(),
        ),
        security: z.array(z.record(z.string(), z.array(z.string()))),
      })
      .optional(),
  })
  .passthrough();

const REGISTRY_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

const credentialSummarySchema = z.object({
  id: z.string(),
  schemeName: z.string(),
  schemeType: z.enum(["apiKey", "basic", "bearer", "oauth2"]),
  status: z.enum(["active", "expired", "revoked", "error"]),
  oauthClientId: z.string().nullable(),
  requestedScopes: z.array(z.string()),
  grantedScopes: z.array(z.string()).nullable(),
  grantedSource: z.enum(["provider", "inferred"]).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  oauthClient: z
    .object({
      id: z.string(),
      provider: z.string(),
      clientId: z.string(),
      tokenUrl: z.string(),
      authorizationUrl: z.string().nullable(),
    })
    .nullable(),
});

const registryAuthStateSchema = z.object({
  schemes: z.record(z.string(), z.object({ type: z.string() }).passthrough()),
  security: z.array(z.record(z.string(), z.array(z.string()))),
  credentials: z.array(credentialSummarySchema),
});

interface RegistryAuthDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  registryId: string | null;
  authSchemes: Record<string, AuthSchemeInfo> | null;
  onRemoveAll?: () => Promise<void>;
  onAuthUpdated?: () => Promise<void>;
}

export function RegistryAuthDialog({
  open,
  onOpenChange,
  registryId,
  authSchemes,
  onRemoveAll,
  onAuthUpdated,
}: RegistryAuthDialogProps) {
  const { mutate } = useSWRConfig();
  const { addNotification } = useNotification();

  const [isRemovingAll, setIsRemovingAll] = useState(false);
  const [isRemoveAllConfirmOpen, setIsRemoveAllConfirmOpen] = useState(false);

  const authStateUrl = registryId
    ? buildUrl(`/registries/${registryId}/auth`)
    : null;
  const {
    data: authState,
    error: authStateError,
    isLoading: authStateLoading,
  } = useSWR(
    authStateUrl,
    (url) => apiFetchJson(url, registryAuthStateSchema),
    { refreshInterval: 8000 },
  );

  const handleClose = () => {
    onOpenChange(false);
  };

  const handleRemoveAllAuth = async () => {
    if (!registryId || !onRemoveAll) return;
    setIsRemoveAllConfirmOpen(true);
  };

  const confirmRemoveAllAuth = async () => {
    if (!registryId || !onRemoveAll) return;
    setIsRemovingAll(true);
    setIsRemoveAllConfirmOpen(false);
    try {
      await onRemoveAll();
      if (authStateUrl) await mutate(authStateUrl);
      await onAuthUpdated?.();
      addNotification({
        type: "success",
        title: "Credentials removed",
        message: `All credentials removed for '${registryId}'.`,
      });
    } catch (error) {
      addNotification({
        type: "error",
        title: "Credential removal failed",
        message: errorMessageFrom(error, "Unable to remove credentials."),
      });
    } finally {
      setIsRemovingAll(false);
    }
  };

  const fetchedSchemes = authState?.schemes ?? authSchemes ?? {};
  const schemeCount = Object.keys(fetchedSchemes).length;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Auth for {registryId ?? ""}</DialogTitle>
          <DialogDescription>
            Credentials are owner-scoped to this registry.
          </DialogDescription>
        </DialogHeader>
        <div className="my-2">
          {authStateLoading ? (
            <p className="text-muted-foreground text-sm">
              Loading auth schemes...
            </p>
          ) : authStateError ? (
            <p className="text-destructive text-sm">
              Failed to load auth details.
            </p>
          ) : schemeCount === 0 ? (
            <div className="flex items-center justify-center py-12">
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <KeyRound aria-hidden />
                  </EmptyMedia>
                  <EmptyTitle>No authentication schemes</EmptyTitle>
                  <EmptyDescription>
                    This registry declares no authentication schemes.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            </div>
          ) : registryId ? (
            <div className="space-y-3">
              <AuthSection
                target={{ kind: "registry", id: registryId }}
                authSchemes={fetchedSchemes}
              />
              {onRemoveAll && authState && authState.credentials.length > 0 && (
                <div className="flex justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={isRemovingAll}
                    onClick={handleRemoveAllAuth}
                  >
                    {isRemovingAll ? "Removing..." : "Remove all credentials"}
                  </Button>
                </div>
              )}
            </div>
          ) : null}
        </div>

        <AlertDialog
          open={isRemoveAllConfirmOpen}
          onOpenChange={(open) => {
            if (!open) setIsRemoveAllConfirmOpen(false);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove all credentials?</AlertDialogTitle>
              <AlertDialogDescription>
                All credentials for {registryId ?? ""} will be permanently
                removed. This action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={isRemovingAll}
                onClick={(event) => {
                  event.preventDefault();
                  void confirmRemoveAllAuth();
                }}
              >
                {isRemovingAll ? "Removing..." : "Remove all"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}

export interface AddedRegistry {
  id: string;
  baseUrl: string;
  authSchemes?: Record<string, AuthSchemeInfo>;
}

interface AddRegistryPopoverProps {
  children: ReactNode;
  onAdded?: (registry: AddedRegistry) => void | Promise<void>;
  align?: "start" | "center" | "end";
  side?: "top" | "right" | "bottom" | "left";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function AddRegistryPopover({
  children,
  onAdded,
  align = "end",
  side,
  open: controlledOpen,
  onOpenChange,
}: AddRegistryPopoverProps) {
  const { addNotification } = useNotification();

  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;

  const [registryId, setRegistryId] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [isAdding, setIsAdding] = useState(false);

  const idPrefix = useId();
  const registryIdInputId = `${idPrefix}-registry-id`;
  const baseUrlInputId = `${idPrefix}-base-url`;

  const reset = () => {
    setRegistryId("");
    setBaseUrl("");
    setIsAdding(false);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) reset();
    if (isControlled) {
      onOpenChange?.(nextOpen);
    } else {
      setInternalOpen(nextOpen);
    }
  };

  const idValid = REGISTRY_ID_PATTERN.test(registryId.trim());
  const baseUrlValid = isValidHttpUrl(baseUrl.trim());
  const canAdd =
    baseUrlValid && (registryId.trim().length === 0 || idValid) && !isAdding;

  const handleAdd = async () => {
    if (!baseUrlValid) {
      addNotification({
        type: "error",
        title: "Invalid base URL",
        message: "Base URL must be a valid absolute http(s) URL.",
      });
      return;
    }
    if (registryId.trim().length > 0 && !idValid) {
      addNotification({
        type: "error",
        title: "Invalid registry id",
        message: "Registry id must be a slug matching /^[A-Za-z0-9_-]+$/.",
      });
      return;
    }
    const trimmedId = registryId.trim();
    setIsAdding(true);
    try {
      const body: Record<string, unknown> = { baseUrl: baseUrl.trim() };
      if (trimmedId) body.id = trimmedId;
      const response = await apiFetchJson(
        buildUrl("/registries"),
        addRegistryResponseSchema,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const schemes = (response.auth?.schemes ?? {}) as Record<
        string,
        AuthSchemeInfo
      >;
      const schemeCount = Object.keys(schemes).length;
      const added: AddedRegistry = {
        id: response.id,
        baseUrl: response.baseUrl,
        authSchemes: schemeCount > 0 ? schemes : undefined,
      };
      await onAdded?.(added);
      addNotification({
        type: "success",
        title: "Registry added",
        message:
          schemeCount > 0
            ? `Registry added with ${schemeCount} auth scheme(s). Configure credentials next.`
            : "Registry added.",
      });
      reset();
      handleOpenChange(false);
    } catch (error) {
      addNotification({
        type: "error",
        title: "Registry creation failed",
        message: errorMessageFrom(error, "Unable to add registry."),
      });
    } finally {
      setIsAdding(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align={align} side={side} className="w-[26rem]">
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void handleAdd();
          }}
        >
          <div className="space-y-1">
            <h3 className="text-sm font-medium">Add registry</h3>
            <p className="text-muted-foreground text-xs">
              Provide registry details to connect to access services and modules
            </p>
          </div>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor={registryIdInputId}>ID</Label>
              <Input
                id={registryIdInputId}
                onChange={(event) => setRegistryId(event.target.value)}
                placeholder="github"
                value={registryId}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={baseUrlInputId}>Base URL</Label>
              <Input
                id={baseUrlInputId}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="https://registry.example.com"
                value={baseUrl}
              />
            </div>
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canAdd}>
              {isAdding ? "Connecting" : "Connect"}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
