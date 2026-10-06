import { Link } from "react-router";
import { EntityIcon } from "@/components/entity-icon";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";

export type InstalledModule = {
  id: string;
  name: string;
  type: "adapter" | "environment";
  summary: string;
  description: string;
  isBuiltin: boolean;
  missing: boolean;
  hasIcon: boolean;
  enabled: boolean;
};

export function InstalledModuleCard({
  installedModule,
  onToggle,
  isToggling = false,
}: {
  installedModule: InstalledModule;
  onToggle: () => void;
  isToggling?: boolean;
}) {
  return (
    <div className="flex flex-col justify-between border border-border bg-card">
      <div className="flex items-center gap-3 p-4">
        <Link
          to={`/settings/modules/${installedModule.id}`}
          className="flex min-w-0 flex-1 items-start gap-3"
        >
          <EntityIcon
            kind="module"
            id={installedModule.id}
            label={installedModule.name}
            hasIcon={installedModule.hasIcon}
          />
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex items-center gap-2">
              <h3
                className="min-w-0 flex-1 truncate text-sm font-semibold"
                title={installedModule.name}
              >
                {installedModule.name}
              </h3>
              {installedModule.missing ? (
                <Badge variant="destructive" className="shrink-0">
                  missing
                </Badge>
              ) : null}
            </div>
            <p
              className="max-w-full truncate font-mono text-xs text-muted-foreground"
              title={installedModule.id}
            >
              {installedModule.id}
            </p>
          </div>
        </Link>
        <Switch
          checked={installedModule.enabled}
          onCheckedChange={() => onToggle()}
          disabled={isToggling || installedModule.missing}
          aria-label={
            installedModule.enabled ? "Disable module" : "Enable module"
          }
          className="mt-0.5 rounded-none [&_span]:rounded-none"
        />
      </div>
    </div>
  );
}
