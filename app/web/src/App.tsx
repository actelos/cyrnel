import {
  Blocks,
  Braces,
  Check,
  Copy,
  House,
  Layers,
  Logs,
  PanelLeftDashed,
  Plug,
  Settings,
  X,
} from "lucide-react";
import type { SyntheticEvent } from "react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "@/utils/copy.util";

function getDefaultApiUrl(): string {
  if (typeof window === "undefined") {
    return "http://localhost:7687";
  }

  return `${window.location.protocol}//${window.location.hostname}:7687`;
}

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isSidebarExpanded, setIsSidebarExpanded] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [isConnectMenuOpen, setIsConnectMenuOpen] = useState(false);
  const [copiedField, setCopiedField] = useState<"apiUrl" | "apiKey" | null>(
    null,
  );

  const mciApiUrl = import.meta.env.VITE_MCI_API_URL ?? getDefaultApiUrl();
  const mciApiKey =
    import.meta.env.VITE_MCI_API_KEY ??
    "Configure VITE_MCI_API_KEY to expose your key here.";

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

  async function handleCopy(
    value: string,
    field: "apiUrl" | "apiKey",
  ): Promise<void> {
    const didCopy = await copyToClipboard(value);

    if (!didCopy) {
      return;
    }

    setCopiedField(field);
    setTimeout(() => {
      setCopiedField((current) => (current === field ? null : current));
    }, 1500);
  }

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
                    isSidebarExpanded
                      ? "w-full justify-start"
                      : "w-10 justify-center",
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

              if (item.label === "Connect") {
                return (
                  <Button
                    key={item.label}
                    aria-label={item.ariaLabel}
                    className={cn(
                      "h-10 justify-center gap-2",
                      isSidebarExpanded
                        ? "w-full justify-start"
                        : "w-10 justify-center",
                    )}
                    onClick={() => setIsConnectMenuOpen((current) => !current)}
                    variant="ghost"
                  >
                    <Icon className="size-4" />
                    {isSidebarExpanded ? <span>{item.label}</span> : null}
                  </Button>
                );
              }

              return (
                <Button
                  key={item.label}
                  aria-label={item.ariaLabel}
                  className={cn(
                    "h-10 justify-center gap-2",
                    isSidebarExpanded
                      ? "w-full justify-start"
                      : "w-10 justify-center",
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
              aria-label={
                isSidebarExpanded ? "Collapse sidebar" : "Expand sidebar"
              }
              className={cn(
                "h-10 justify-center gap-2",
                isSidebarExpanded
                  ? "w-full justify-start"
                  : "w-10 justify-center",
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

      {isConnectMenuOpen ? (
        <>
          <button
            aria-label="Close connect menu"
            className="fixed inset-0 z-40 bg-black/20"
            onClick={() => setIsConnectMenuOpen(false)}
            type="button"
          />
          <aside className="fixed top-0 right-0 bottom-0 z-50 flex h-screen w-[28rem] max-w-[calc(100vw-1rem)] flex-col border-l bg-popover text-popover-foreground shadow-lg">
            <div className="flex items-center justify-between border-b p-4">
              <div className="space-y-1">
                <h3 className="text-sm font-medium">Connect to MCI</h3>
                <p className="text-muted-foreground text-xs">
                  Choose one of the supported connection methods.
                </p>
              </div>
              <Button
                aria-label="Close connect menu"
                onClick={() => setIsConnectMenuOpen(false)}
                size="sm"
                type="button"
                variant="ghost"
              >
                <X />
              </Button>
            </div>

            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
              <Tabs className="h-full" defaultValue="manual">
                <TabsList className="w-full">
                  <TabsTrigger value="manual">Manual</TabsTrigger>
                  <TabsTrigger value="mcp">MCP</TabsTrigger>
                </TabsList>

                <TabsContent className="space-y-3 pt-4" value="manual">
                  <h4 className="text-xs font-medium">Manual method</h4>
                  <ol className="text-muted-foreground list-decimal space-y-4 pl-4 text-xs">
                    <li className="space-y-2">
                      <p>Copy the MCI API connection URL and paste it where needed.</p>
                      <div className="flex items-center gap-2">
                        <Input readOnly value={mciApiUrl} />
                        <Button
                          aria-label="Copy MCI API URL"
                          onClick={() => void handleCopy(mciApiUrl, "apiUrl")}
                          size="icon-sm"
                          type="button"
                          variant="outline"
                        >
                          {copiedField === "apiUrl" ? (
                            <Check className="size-4" />
                          ) : (
                            <Copy className="size-4" />
                          )}
                        </Button>
                      </div>
                    </li>
                    <li className="space-y-2">
                      <p>Copy the MCI API key from and paste it too.</p>
                      <div className="flex items-center gap-2">
                        <Input type="password" readOnly value={mciApiKey} />
                        <Button
                          aria-label="Copy MCI API key"
                          onClick={() => void handleCopy(mciApiKey, "apiKey")}
                          size="icon-sm"
                          type="button"
                          variant="outline"
                        >
                          {copiedField === "apiKey" ? (
                            <Check className="size-4" />
                          ) : (
                            <Copy className="size-4" />
                          )}
                        </Button>
                      </div>
                    </li>
                  </ol>
                </TabsContent>
                <TabsContent className="space-y-1 pt-4" value="mcp">
                  <h4 className="text-xs font-medium">MCP method</h4>
                  <p className="text-muted-foreground text-xs">Coming soon.</p>
                </TabsContent>
              </Tabs>
            </div>
          </aside>
        </>
      ) : null}
    </div>
  );
}

export default App;
