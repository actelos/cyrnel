import {
  ArrowLeft,
  Blocks,
  Braces,
  KeyRound,
  Library,
  ScrollText,
  Server,
  Settings as SettingsIcon,
  Shield,
  ShieldCheck,
} from "lucide-react";
import {
  Link,
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
} from "react-router";
import { Toaster } from "sonner";
import { ModeToggle } from "@/components/mode-toggle";
import { useTheme } from "@/components/theme-provider";
import { Separator } from "@/components/ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import ApprovalsPage from "@/pages/ApprovalsPage";
import AuthCallbackPage from "@/pages/AuthCallbackPage";
import LogsPage from "@/pages/LogsPage";
import ProcessesPage from "@/pages/ProcessesPage";
import ServiceDetailPage from "@/pages/ServiceDetailPage";
import ServicesPage from "@/pages/ServicesPage";
import SettingsAuthenticationPage from "@/pages/SettingsAuthenticationPage";
import SettingsModuleDetailPage from "@/pages/SettingsModuleDetailPage";
import SettingsModulesPage from "@/pages/SettingsModulesPage";
import SettingsPage from "@/pages/SettingsPage";
import SettingsRegistriesPage from "@/pages/SettingsRegistriesPage";
import ToolPermissionsPage from "@/pages/ToolPermissionsPage";

const navItems = [
  { to: "/services", icon: Server, label: "Services" },
  { to: "/processes", icon: Braces, label: "Processes" },
  { to: "/approvals", icon: ShieldCheck, label: "Approvals" },
  { to: "/permissions", icon: Shield, label: "Permissions" },
  { to: "/logs", icon: ScrollText, label: "Logs" },
] as const;

const settingsNavItems = [
  { to: "/settings/modules", icon: Blocks, label: "Modules" },
  { to: "/settings/registries", icon: Library, label: "Registries" },
  { to: "/settings/authentication", icon: KeyRound, label: "Authentication" },
] as const;

function App() {
  const location = useLocation();
  const { theme } = useTheme();

  const isActive = (to: string) =>
    location.pathname === to ||
    location.pathname.startsWith(`${to}/`) ||
    (to === "/services" && location.pathname === "/");

  const isSettingsSection =
    location.pathname === "/settings" ||
    location.pathname.startsWith("/settings/");

  return (
    <TooltipProvider>
      <SidebarProvider>
        <Sidebar collapsible="icon">
          <SidebarHeader className="flex-row items-center justify-between px-4 group-data-[collapsible=icon]:justify-center border-b">
            <Link
              to="/"
              aria-label="Home"
              className="group-data-[collapsible=icon]:hidden"
            >
              <img
                src="/sidebar-logo.svg"
                alt="Cyrnel"
                className="h-5 w-auto invert group-data-[collapsible=icon]:hidden dark:invert-0"
              />
            </Link>
            <SidebarTrigger className="p-4" />
          </SidebarHeader>
          <SidebarContent className="overflow-hidden">
            <div className="relative h-full w-full">
              <div
                inert={isSettingsSection}
                className={cn(
                  "absolute inset-0 overflow-y-auto transition-all duration-300 ease-in-out",
                  isSettingsSection
                    ? "-translate-x-full pointer-events-none opacity-0"
                    : "translate-x-0 opacity-100",
                )}
              >
                <SidebarGroup>
                  <SidebarGroupContent>
                    <SidebarMenu>
                      {navItems.map((item) => (
                        <SidebarMenuItem key={item.to}>
                          <SidebarMenuButton
                            asChild
                            isActive={isActive(item.to)}
                            tooltip={item.label}
                          >
                            <NavLink to={item.to} end>
                              <item.icon />
                              <span>{item.label}</span>
                            </NavLink>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      ))}
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>
              </div>
              <div
                inert={!isSettingsSection}
                className={cn(
                  "absolute inset-0 overflow-y-auto transition-all duration-300 ease-in-out",
                  isSettingsSection
                    ? "translate-x-0 opacity-100"
                    : "translate-x-full pointer-events-none opacity-0",
                )}
              >
                <SidebarGroup className="pb-0">
                  <SidebarGroupContent>
                    <SidebarMenu>
                      <SidebarMenuItem>
                        <SidebarMenuButton asChild tooltip="Back">
                          <Link to="/">
                            <ArrowLeft />
                            <span>Back</span>
                          </Link>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>
                <SidebarGroup className="pt-0">
                  <SidebarGroupLabel className="group-data-[collapsible=icon]:hidden">
                    Settings
                  </SidebarGroupLabel>
                  <SidebarGroupContent>
                    <SidebarMenu>
                      {settingsNavItems.map((item) => (
                        <SidebarMenuItem key={item.to}>
                          <SidebarMenuButton
                            asChild
                            isActive={isActive(item.to)}
                            tooltip={item.label}
                          >
                            <NavLink to={item.to} end>
                              <item.icon />
                              <span>{item.label}</span>
                            </NavLink>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      ))}
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>
              </div>
            </div>
          </SidebarContent>
          <SidebarFooter className="border-t">
            <SidebarMenu>
              <SidebarMenuItem className="flex items-center group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:items-center">
                <SidebarMenuButton
                  asChild
                  isActive={isActive("/settings")}
                  tooltip="Settings"
                  className="min-w-0 flex-1"
                >
                  <NavLink to="/settings">
                    <SettingsIcon />
                    <span>Settings</span>
                  </NavLink>
                </SidebarMenuButton>
                <Separator
                  orientation="vertical"
                  className="block mx-1 group-data-[collapsible=icon]:hidden"
                />
                <Separator className="hidden my-1 group-data-[collapsible=icon]:block" />
                <ModeToggle />
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
          <SidebarRail />
        </Sidebar>
        <SidebarInset>
          <Routes>
            <Route path="/" element={<Navigate to="/services" replace />} />
            <Route path="/processes" element={<ProcessesPage />} />
            <Route path="/services" element={<ServicesPage />} />
            <Route
              path="/services/:serviceId"
              element={<ServiceDetailPage />}
            />
            <Route path="/approvals" element={<ApprovalsPage />} />
            <Route path="/permissions" element={<ToolPermissionsPage />} />
            <Route path="/logs" element={<LogsPage />} />
            <Route path="/settings" element={<SettingsPage />}>
              <Route index element={<Navigate to="modules" replace />} />
              <Route path="modules" element={<SettingsModulesPage />} />
              <Route
                path="modules/:moduleId"
                element={<SettingsModuleDetailPage />}
              />
              <Route path="registries" element={<SettingsRegistriesPage />} />
              <Route
                path="authentication"
                element={<SettingsAuthenticationPage />}
              />
            </Route>
            <Route path="/auth/callback" element={<AuthCallbackPage />} />
          </Routes>
        </SidebarInset>
      </SidebarProvider>
      <Toaster theme={theme} />
    </TooltipProvider>
  );
}

export default App;
