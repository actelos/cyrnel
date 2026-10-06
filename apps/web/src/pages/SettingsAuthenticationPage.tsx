import { KeyRound, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { z } from "zod";
import {
  CreateOAuthClientDialog,
  EditOAuthClientDialog,
} from "@/components/OAuthClientDialogs";
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
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useNotification } from "@/hooks/use-notification";
import { apiFetch, apiFetchJson, buildUrl, errorMessageFrom } from "@/lib/api";

const oauthClientSchema = z.object({
  id: z.string(),
  provider: z.string(),
  clientId: z.string(),
  tokenUrl: z.string(),
  authorizationUrl: z.string().nullable(),
  clientAuthMethod: z.string(),
  redirectUris: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const oauthClientListSchema = z.array(oauthClientSchema);

type OAuthClient = z.infer<typeof oauthClientSchema>;

export default function SettingsAuthenticationPage() {
  const { mutate } = useSWRConfig();
  const { addNotification } = useNotification();

  const [isCreateOpen, setIsCreateOpen] = useState(false);

  const [editTarget, setEditTarget] = useState<OAuthClient | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<OAuthClient | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const oauthClientsUrl = buildUrl("/oauth-clients");
  const { data: oauthClientsData } = useSWR(
    oauthClientsUrl,
    (url) => apiFetchJson(url, oauthClientListSchema),
    { refreshInterval: 8000 },
  );

  const oauthClients = oauthClientsData ?? [];

  const refresh = async () => {
    await mutate(oauthClientsUrl);
  };

  const notifyError = (title: string, message: string) => {
    addNotification({ type: "error", title, message });
  };

  const handleDelete = async () => {
    if (deleteTarget === null) return;
    setIsDeleting(true);
    setDeleteError(null);
    try {
      await apiFetch(buildUrl(`/oauth-clients/${deleteTarget.id}`), {
        method: "DELETE",
      });
      setDeleteTarget(null);
      setDeleteError(null);
      await refresh();
      addNotification({
        type: "success",
        title: "OAuth client deleted",
        message: "OAuth client deleted.",
      });
    } catch (error) {
      const message = errorMessageFrom(error, "Unable to delete OAuth client.");
      setDeleteError(message);
      notifyError("OAuth client deletion failed", message);
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <>
      <section className="flex h-svh flex-col px-6 pb-6">
        <header className="sticky top-0 z-10 -mx-6 flex items-end justify-between gap-4 border-b bg-background px-6 py-4 mb-6">
          <div className="space-y-1">
            <h2 className="text-lg font-semibold">Authentication</h2>
            <p className="text-muted-foreground text-sm">
              Manage shared OAuth client registrations.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <CreateOAuthClientDialog
              open={isCreateOpen}
              onOpenChange={setIsCreateOpen}
              onCreated={refresh}
            />
            <Button
              type="button"
              className="gap-2"
              onClick={() => setIsCreateOpen(true)}
            >
              <Plus />
              Add client
            </Button>
            <Button
              type="button"
              variant="outline"
              className="gap-2"
              onClick={() => {
                refresh()
                  .then(() => {
                    addNotification({
                      type: "success",
                      title: "OAuth clients refreshed",
                      message: "OAuth clients refreshed.",
                    });
                  })
                  .catch((error) => {
                    notifyError(
                      "Refresh OAuth clients failed",
                      errorMessageFrom(
                        error,
                        "Failed to refresh OAuth clients.",
                      ),
                    );
                  });
              }}
              aria-label="Refresh OAuth clients"
            >
              <RotateCcw />
            </Button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto [&_[data-slot='table-container']]:overflow-visible">
          {oauthClientsData === undefined ? (
            <div className="flex items-center justify-center h-full py-12">
              <p className="text-sm text-muted-foreground">
                Loading OAuth clients…
              </p>
            </div>
          ) : oauthClients.length === 0 ? (
            <div className="flex items-center justify-center h-full py-12">
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <KeyRound aria-hidden />
                  </EmptyMedia>
                  <EmptyTitle>No OAuth clients</EmptyTitle>
                  <EmptyDescription>
                    Register a client to connect services that use OAuth2.
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button
                    type="button"
                    size="sm"
                    className="gap-2"
                    onClick={() => setIsCreateOpen(true)}
                  >
                    <Plus />
                    Add client
                  </Button>
                </EmptyContent>
              </Empty>
            </div>
          ) : (
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-background">
                <TableRow>
                  <TableHead>Provider</TableHead>
                  <TableHead>Client ID</TableHead>
                  <TableHead className="w-24 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {oauthClients.map((client) => (
                  <TableRow key={client.id}>
                    <TableCell className="font-mono max-w-20 truncate">
                      {client.provider}
                    </TableCell>
                    <TableCell className="font-mono max-w-44 truncate">
                      {client.clientId}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`Edit OAuth client ${client.clientId}`}
                          onClick={() => setEditTarget(client)}
                        >
                          <Pencil />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="text-destructive"
                          aria-label={`Delete OAuth client ${client.clientId}`}
                          onClick={() => {
                            setDeleteTarget(client);
                            setDeleteError(null);
                          }}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </section>

      <EditOAuthClientDialog
        open={editTarget !== null}
        onOpenChange={(open) => {
          if (!open) setEditTarget(null);
        }}
        client={editTarget}
        onUpdated={refresh}
      />

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null);
            setDeleteError(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete OAuth client?</AlertDialogTitle>
            <AlertDialogDescription>
              Delete OAuth client "{deleteTarget?.clientId ?? ""}"? This fails
              with a 409 while any service, module, or registry credential still
              references it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError ? (
            <p className="text-destructive text-sm">{deleteError}</p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isDeleting}
              onClick={(event) => {
                event.preventDefault();
                void handleDelete();
              }}
            >
              {isDeleting ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
