import { useState } from "react";
import type { SyntheticEvent } from "react";
import { Plug, House, Scroll, Braces, Layers, Blocks, Logs, Settings, PanelLeftDashed } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isSidebarExpanded, setIsSidebarExpanded] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [errorMessage, setErrorMessage] = useState("");

  const primaryNavItems = [
    { label: "Overview", ariaLabel: "Open homepage", icon: House },
    { label: "Processes", ariaLabel: "Open processes", icon: Braces },
    { label: "Services", ariaLabel: "Open services", icon: Layers },
    { label: "Modules", ariaLabel: "Open modules", icon: Blocks },
  ];

  const secondaryNavItems = [
    { label: "Connect", ariaLabel: "Open connect menu", icon: Plug },
    { label: "Logs", ariaLabel: "Open logs", icon: Logs },
    { label: "Settings", ariaLabel: "Open settings", icon: Settings },
  ];

  function handleSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();

    const expectedUsername = import.meta.env.VITE_AUTH_USERNAME;
    const expectedPassword = import.meta.env.VITE_AUTH_PASSWORD;

    if (!(expectedUsername && expectedPassword)) {
      setIsAuthenticated(false);
      setErrorMessage("Missing authentication configuration.");
      return;
    }

    const matchesUsername = username === expectedUsername;
    const matchesPassword = password === expectedPassword;

    if (matchesUsername && matchesPassword) {
      setErrorMessage("");
      setIsAuthenticated(true);
      return;
    }

    setIsAuthenticated(false);
    setErrorMessage("Invalid credentials. Please try again.");
  }

  if (!isAuthenticated) {
    return (
      <div className="flex min-h-screen flex-col bg-background">
        <main className="flex flex-1 items-center justify-center p-6">
          <Card className="w-full max-w-sm">
            <CardHeader>
              <CardTitle>Sign in</CardTitle>
              <CardDescription>
                Enter your admin credentials to continue.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form className="space-y-4" onSubmit={handleSubmit}>
                <div className="space-y-2">
                  <Label htmlFor="username">Username</Label>
                  <Input
                    autoComplete="username"
                    id="username"
                    onChange={(event) => setUsername(event.target.value)}
                    required
                    value={username}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="password">Password</Label>
                  <Input
                    autoComplete="current-password"
                    id="password"
                    onChange={(event) => setPassword(event.target.value)}
                    required
                    type="password"
                    value={password}
                  />
                </div>

                {errorMessage ? (
                  <p className="text-destructive text-sm">{errorMessage}</p>
                ) : null}

                <Button className="w-full" type="submit">
                  Login
                </Button>
              </form>
            </CardContent>
            <CardFooter>
              <p className="text-muted-foreground text-xs">
                This dashboard MUST be used in local environments only
              </p>
            </CardFooter>
          </Card>
        </main>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <main className="flex min-h-0 flex-1">
        <aside
          className={cn(
            "flex flex-col border-r border-border transition-all duration-200",
            isSidebarExpanded ? "w-54" : "w-max",
          )}
        >
          <div className="flex-1 flex flex-col p-2">
            {primaryNavItems.map((item) => {
              const Icon = item.icon;

              return (
                <Button
                  key={item.label}
                  aria-label={item.ariaLabel}
                  className={cn(
                    "h-10 gap-2",
                    isSidebarExpanded ? "w-full justify-start" : "w-10 justify-center",
                  )}
                  variant="ghost"
                >
                  <Icon />
                  {isSidebarExpanded ? <span>{item.label}</span> : null}
                </Button>
              );
            })}
          </div>
          <div className="flex flex-col p-2">
            {secondaryNavItems.map((item) => {
              const Icon = item.icon;

              return (
                <Button
                  key={item.label}
                  aria-label={item.ariaLabel}
                  className={cn(
                    "h-10 justify-center gap-2",
                    isSidebarExpanded ? "w-full justify-start" : "w-10 justify-center",
                  )}
                  variant="ghost"
                >
                  <Icon className="size-4" />
                  {isSidebarExpanded ? <span>{item.label}</span> : null}
                </Button>
              );
            })}
            <Separator className="my-1" />
            <Button
              aria-expanded={isSidebarExpanded}
              aria-label={isSidebarExpanded ? "Collapse sidebar" : "Expand sidebar"}
              className={cn(
                "h-10 justify-center gap-2",
                isSidebarExpanded ? "w-full justify-start" : "w-10 justify-center",
              )}
              onClick={() => setIsSidebarExpanded((current) => !current)}
              variant="ghost"
            >
              <PanelLeftDashed />
              {isSidebarExpanded ? <span>Collapse</span> : null}
            </Button>
          </div>
        </aside>

        <section className="flex-1" />
      </main>
    </div>
  );
}

export default App;
