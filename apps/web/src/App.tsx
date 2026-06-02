import { Blocks, Braces, Check, Copy, Plug, Server, X } from "lucide-react";
import { useState } from "react";
import {
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { copyToClipboard } from "@/lib/copy";
import LoginPage from "@/pages/LoginPage";
import ModulesPage from "@/pages/ModulesPage";
import ProcessesPage from "@/pages/ProcessesPage";
import ServicesPage from "@/pages/ServicesPage";

function App() {
  const location = useLocation();
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isConnectMenuOpen, setIsConnectMenuOpen] = useState(false);
  const [copiedField, setCopiedField] = useState<"apiUrl" | "apiKey" | null>(
    null,
  );

  const isProcessesRoute =
    location.pathname === "/processes" || location.pathname === "/";
  const isServicesRoute = location.pathname === "/services";
  const isModulesRoute = location.pathname === "/modules";

  const mciApiUrl =
    import.meta.env.VITE_MCI_API_URL ??
    "Configure VITE_MCI_API_URL to expose the API URL here.";
  const mciApiKey =
    import.meta.env.VITE_MCI_API_KEY ??
    "Configure VITE_MCI_API_KEY to expose your key here.";

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

  if (!isAuthenticated) {
    return (
      <Routes>
        <Route
          path="/login"
          element={
            <LoginPage onAuthenticated={() => setIsAuthenticated(true)} />
          }
        />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <main className="flex min-h-0 flex-1 overflow-hidden">
        <aside className="flex flex-col border-r">
          <div className="flex flex-1 flex-col p-2">
            <Button
              aria-label="Open processes"
              className="w-10 h-10 gap-2 justify-center"
              variant={isProcessesRoute ? "secondary" : "ghost"}
              asChild
            >
              <NavLink end to="/processes">
                <Braces />
              </NavLink>
            </Button>
            <Button
              aria-label="Open services"
              className="w-10 h-10 gap-2 justify-center"
              variant={isServicesRoute ? "secondary" : "ghost"}
              asChild
            >
              <NavLink end to="/services">
                <Server />
              </NavLink>
            </Button>
            <Button
              aria-label="Open modules"
              className="w-10 h-10 gap-2 justify-center"
              variant={isModulesRoute ? "secondary" : "ghost"}
              asChild
            >
              <NavLink end to="/modules">
                <Blocks />
              </NavLink>
            </Button>
          </div>
          <div className="flex flex-col p-2">
            <Button
              aria-label="Open connect menu"
              className="w-10 h-10 gap-2 justify-center"
              onClick={() => setIsConnectMenuOpen((current) => !current)}
              variant="ghost"
            >
              <Plug />
            </Button>
          </div>
        </aside>
        <Routes>
          <Route path="/" element={<Navigate to="/processes" replace />} />
          <Route path="/processes" element={<ProcessesPage />} />
          <Route path="/services" element={<ServicesPage />} />
          <Route path="/modules" element={<ModulesPage />} />
          <Route path="/login" element={<Navigate to="/processes" replace />} />
        </Routes>
      </main>

      {isConnectMenuOpen ? (
        <>
          <button
            aria-label="Close connect menu"
            className="fixed inset-0 z-40 bg-background/50"
            onClick={() => setIsConnectMenuOpen(false)}
            type="button"
          />
          <aside className="fixed top-0 right-0 bottom-0 z-50 w-md max-w-screen h-screen flex flex-col text-popover-foreground bg-popover border-l">
            <div className="flex items-center justify-between p-4 border-b">
              <div className="space-y-1">
                <h3 className="text-sm font-medium">Connect</h3>
                <p className="text-muted-foreground text-xs">
                  Choose one of the supported connection methods.
                </p>
              </div>
              <Button
                aria-label="Close connect menu"
                onClick={() => setIsConnectMenuOpen(false)}
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
                      <p>
                        Copy the MCI API connection URL and paste it where
                        needed.
                      </p>
                      <div className="flex items-center gap-2">
                        <Input readOnly value={mciApiUrl} />
                        <Button
                          aria-label="Copy MCI API URL"
                          onClick={() => void handleCopy(mciApiUrl, "apiUrl")}
                          type="button"
                          variant="outline"
                        >
                          {copiedField === "apiUrl" ? <Check /> : <Copy />}
                        </Button>
                      </div>
                    </li>
                    <li className="space-y-2">
                      <p>Copy the MCI API key and paste it too.</p>
                      <div className="flex items-center gap-2">
                        <Input type="password" readOnly value={mciApiKey} />
                        <Button
                          aria-label="Copy MCI API key"
                          onClick={() => void handleCopy(mciApiKey, "apiKey")}
                          type="button"
                          variant="outline"
                        >
                          {copiedField === "apiKey" ? <Check /> : <Copy />}
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
