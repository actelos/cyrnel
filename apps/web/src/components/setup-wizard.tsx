import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import useSWR from "swr";
import { z } from "zod";
import AuthSection from "@/components/AuthSection";
import JsonSchemaForm from "@/components/JsonSchemaForm";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { WizardDialog, type WizardStep } from "@/components/wizard-dialog";
import { apiFetchJson, buildUrl, errorMessageFrom } from "@/lib/api";
import { formatVersion } from "@/lib/format";
import {
  setupStatus,
  setupStatusDescription,
  setupStatusLabel,
} from "@/lib/setup-status";

const detailsSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  adapter: z.string().optional(),
  schemes: z
    .record(z.string(), z.object({ type: z.string() }).passthrough())
    .optional(),
  credentialSchemes: z
    .record(z.string(), z.object({ configured: z.boolean() }).passthrough())
    .optional(),
  configSchema: z.record(z.string(), z.unknown()).optional(),
  secretsSchema: z.record(z.string(), z.unknown()).optional(),
});

const configViewSchema = z.object({
  config: z.record(z.string(), z.unknown()),
  outdated: z.array(z.string()).default([]),
});

const secretsPresenceSchema = z.object({
  present: z.array(z.string()),
  outdated: z.array(z.string()).default([]),
});

const toolsSchema = z.object({
  items: z.array(z.object({ id: z.string() })),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});

function schemaHasProperties(schema: unknown): boolean {
  if (!schema || typeof schema !== "object") return false;
  const properties = (schema as Record<string, unknown>).properties;
  return (
    typeof properties === "object" &&
    properties !== null &&
    Object.keys(properties).length > 0
  );
}

interface SetupWizardProps {
  kind: "service" | "module";
  id: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCompleted?: (id: string) => void;
}

export function SetupWizard({
  kind,
  id,
  open,
  onOpenChange,
  onCompleted,
}: SetupWizardProps) {
  const navigate = useNavigate();
  const [finishError, setFinishError] = useState<string | null>(null);

  const base = kind === "service" ? "/services" : "/modules";
  const detailsUrl = id && open ? buildUrl(`${base}/${id}`) : null;
  const configUrl = id && open ? buildUrl(`${base}/${id}/config`) : null;
  const secretsUrl = id && open ? buildUrl(`${base}/${id}/secrets`) : null;
  const toolsUrl =
    id && open && kind === "service"
      ? buildUrl("/tools", { serviceId: id, limit: "100" })
      : null;

  const { data: details, mutate: mutateDetails } = useSWR(detailsUrl, (url) =>
    apiFetchJson(url, detailsSchema),
  );
  const { data: configView } = useSWR(configUrl, (url) =>
    apiFetchJson(
      url,
      kind === "service"
        ? configViewSchema
        : z.object({
            config: z.record(z.string(), z.unknown()).nullable(),
            outdated: z.array(z.string()).default([]),
          }),
    ),
  );
  const { data: secretsPresence } = useSWR(secretsUrl, (url) =>
    apiFetchJson(url, secretsPresenceSchema),
  );
  const { data: toolList } = useSWR(toolsUrl, (url) =>
    apiFetchJson(url, toolsSchema),
  );

  useEffect(() => {
    if (!open) setFinishError(null);
  }, [open]);

  const schemes = useMemo(
    () => (details?.schemes ?? {}) as Record<string, { type: string }>,
    [details],
  );
  const schemeNames = useMemo(() => Object.keys(schemes), [schemes]);
  const unconfiguredSchemes = useMemo(
    () =>
      schemeNames.filter(
        (name) => details?.credentialSchemes?.[name]?.configured !== true,
      ),
    [schemeNames, details],
  );

  const needsAuth = unconfiguredSchemes.length > 0;
  const needsConfig = schemaHasProperties(details?.configSchema);
  const needsSecrets = schemaHasProperties(details?.secretsSchema);

  const status = useMemo(
    () =>
      setupStatus({
        schemes: details?.schemes,
        credentialSchemes: details?.credentialSchemes,
        configSchema: details?.configSchema as
          | Record<string, unknown>
          | undefined,
        config: (
          configView as { config?: Record<string, unknown> | null } | undefined
        )?.config as Record<string, unknown> | undefined,
        secretsSchema: details?.secretsSchema as
          | Record<string, unknown>
          | undefined,
        secretsPresent: secretsPresence?.present,
      }),
    [details, configView, secretsPresence],
  );

  const secretsSkeleton = useMemo(() => {
    const schema = details?.secretsSchema as
      | { properties?: Record<string, unknown> }
      | undefined;
    const properties = schema?.properties ?? {};
    const values: Record<string, unknown> = {};
    for (const name of Object.keys(properties)) values[name] = "";
    return values;
  }, [details]);

  const presentSet = useMemo(
    () => new Set(secretsPresence?.present ?? []),
    [secretsPresence],
  );

  const steps: WizardStep[] = useMemo(() => {
    if (!details) {
      return [
        {
          id: "loading",
          title: "Loading",
          description: "Loading installation details…",
          content: null,
          canProceed: false,
        },
      ];
    }
    const list: WizardStep[] = [];
    if (needsAuth) {
      list.push({
        id: "auth",
        title: "Authentication",
        description: `${unconfiguredSchemes.length} of ${schemeNames.length} scheme(s) still need credentials.`,
        content: (
          <AuthSection
            target={{ kind, id: details.id }}
            authSchemes={schemes as Record<string, { type: string }>}
          />
        ),
        canProceed: true,
        validationMessage:
          "You can continue without configuring — the detail page will keep showing setup-incomplete until every scheme is connected.",
      });
    }
    if (needsConfig) {
      list.push({
        id: "config",
        title: "Configuration",
        description: "Fill in configuration values, then press Save.",
        content: (
          <JsonSchemaForm
            schema={(details.configSchema ?? {}) as Record<string, unknown>}
            currentValues={
              ((
                configView as
                  | { config?: Record<string, unknown> | null }
                  | undefined
              )?.config ?? {}) as Record<string, unknown>
            }
            patchUrl={buildUrl(`${base}/${details.id}/config`)}
            outdatedPaths={
              (configView as { outdated?: string[] } | undefined)?.outdated
            }
            onSaved={() => void mutateDetails()}
          />
        ),
        canProceed: true,
      });
    }
    if (needsSecrets) {
      list.push({
        id: "secrets",
        title: "Secrets",
        description: "Provide secret values, then press Save.",
        content: (
          <JsonSchemaForm
            schema={(details.secretsSchema ?? {}) as Record<string, unknown>}
            currentValues={secretsSkeleton}
            presentSet={presentSet}
            patchUrl={buildUrl(`${base}/${details.id}/secrets`)}
            outdatedPaths={secretsPresence?.outdated}
            onSaved={() => void mutateDetails()}
          />
        ),
        canProceed: true,
      });
    }
    const toolCount =
      toolList != null
        ? toolList.items.length + (toolList.hasMore ? "+" : "")
        : null;
    list.push({
      id: "review",
      title: list.length === 0 ? "Installed" : "Review",
      description:
        list.length === 0
          ? "Nothing requires configuration."
          : "Review the installation summary.",
      content: (
        <div className="space-y-2 text-sm">
          <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground text-xs">
                {kind === "service" ? "Service" : "Module"}
              </dt>
              <dd className="font-mono text-xs">{details.id}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">
                Installed version
              </dt>
              <dd className="font-mono text-xs">
                {formatVersion(details.version)}
              </dd>
            </div>
            {details.adapter ? (
              <div>
                <dt className="text-muted-foreground text-xs">Adapter</dt>
                <dd className="font-mono text-xs">{details.adapter}</dd>
              </div>
            ) : null}
            {toolCount !== null ? (
              <div>
                <dt className="text-muted-foreground text-xs">Tools</dt>
                <dd className="font-mono text-xs">{toolCount}</dd>
              </div>
            ) : null}
          </dl>
          <Alert variant={status === "complete" ? "default" : "destructive"}>
            <AlertTitle>{setupStatusLabel(status)}</AlertTitle>
            <AlertDescription>
              {setupStatusDescription(status)}
            </AlertDescription>
          </Alert>
        </div>
      ),
      canProceed: true,
    });
    return list;
  }, [
    details,
    needsAuth,
    needsConfig,
    needsSecrets,
    unconfiguredSchemes.length,
    schemeNames.length,
    schemes,
    kind,
    base,
    configView,
    secretsSkeleton,
    presentSet,
    secretsPresence?.outdated,
    toolList,
    status,
    mutateDetails,
  ]);

  if (id === null) return null;

  const detailPath =
    kind === "service" ? `/services/${id}` : `/settings/modules/${id}`;

  return (
    <WizardDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Set up ${details?.name ?? id}`}
      description="Configure authentication and values so the installation is ready to use."
      steps={steps}
      onFinish={() => {
        try {
          onCompleted?.(id);
        } catch (error) {
          setFinishError(errorMessageFrom(error, "Unable to finish setup."));
          return;
        }
        onOpenChange(false);
        navigate(detailPath);
      }}
      finishLabel="Finish"
      finishError={finishError}
    />
  );
}
