import { RotateCcw } from "lucide-react";
import { Link } from "react-router";
import { EntityIcon } from "@/components/entity-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

export type InstalledService = {
  id: string;
  name: string;
  summary: string;
  description: string;
  adapter: string;
  stale: boolean;
  hasIcon: boolean;
  enabled: boolean;
};

export function InstalledServiceCard({
  service,
  onSync,
  onToggle,
  isToggling = false,
}: {
  service: InstalledService;
  onSync: () => void;
  onToggle: () => void;
  isToggling?: boolean;
}) {
  return (
    <div className="flex flex-col justify-between border border-border bg-card">
      <div className="flex items-center gap-3 p-4">
        <Link
          to={`/services/${service.id}`}
          className="flex min-w-0 flex-1 items-start gap-3"
        >
          <EntityIcon
            kind="service"
            id={service.id}
            label={service.name}
            hasIcon={service.hasIcon}
          />
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex items-center gap-2">
              <h3
                className="min-w-0 flex-1 truncate text-sm font-semibold"
                title={service.name}
              >
                {service.name}
              </h3>
              {service.stale ? (
                <Badge variant="destructive" className="shrink-0">
                  Stale
                </Badge>
              ) : null}
            </div>
            <p
              className="max-w-full truncate font-mono text-xs text-muted-foreground"
              title={service.id}
            >
              {service.id}
            </p>
          </div>
        </Link>
        <Switch
          checked={service.enabled}
          onCheckedChange={() => onToggle()}
          disabled={isToggling}
          aria-label={service.enabled ? "Disable service" : "Enable service"}
          className="mt-0.5 rounded-none [&_span]:rounded-none"
        />
      </div>
      {service.stale ? (
        <div className="px-4 pb-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full gap-2"
            onClick={onSync}
          >
            <RotateCcw />
            Sync
          </Button>
        </div>
      ) : null}
    </div>
  );
}
