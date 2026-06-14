import { Blocks, Braces, Server } from "lucide-react";
import { useState } from "react";
import {
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import { Toaster } from "sonner";
import { ModeToggle } from "@/components/mode-toggle";
import { useTheme } from "@/components/theme-provider";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
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
import LoginPage from "@/pages/LoginPage";
import ModuleDetailPage from "@/pages/ModuleDetailPage";
import ModulesPage from "@/pages/ModulesPage";
import ProcessesPage from "@/pages/ProcessesPage";
import ServiceDetailPage from "@/pages/ServiceDetailPage";
import ServicesPage from "@/pages/ServicesPage";

const navItems = [
  { to: "/processes", icon: Braces, label: "Processes" },
  { to: "/services", icon: Server, label: "Services" },
  { to: "/modules", icon: Blocks, label: "Modules" },
] as const;

function App() {
  const location = useLocation();
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const { theme } = useTheme();

  const isActive = (to: string) =>
    location.pathname === to ||
    location.pathname.startsWith(`${to}/`) ||
    (to === "/processes" && location.pathname === "/");

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
    <TooltipProvider>
      <SidebarProvider>
        <Sidebar collapsible="icon">
          <SidebarHeader>
            <SidebarTrigger className="p-4" />
          </SidebarHeader>
          <SidebarContent>
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
          </SidebarContent>
          <SidebarFooter>
            <SidebarMenu>
              <SidebarMenuItem>
                <ModeToggle />
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
          <SidebarRail />
        </Sidebar>
        <SidebarInset>
          <div className="flex flex-1 flex-col">
            <Routes>
              <Route path="/" element={<Navigate to="/processes" replace />} />
              <Route path="/processes" element={<ProcessesPage />} />
              <Route path="/services" element={<ServicesPage />} />
              <Route
                path="/services/:serviceId"
                element={<ServiceDetailPage />}
              />
              <Route path="/modules" element={<ModulesPage />} />
              <Route path="/modules/:moduleId" element={<ModuleDetailPage />} />
              <Route
                path="/login"
                element={<Navigate to="/processes" replace />}
              />
            </Routes>
          </div>
        </SidebarInset>
      </SidebarProvider>
      <Toaster theme={theme} />
    </TooltipProvider>
  );
}

export default App;
