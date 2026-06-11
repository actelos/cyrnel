import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/components/theme-provider";
import { SidebarMenuButton } from "@/components/ui/sidebar";

export function ModeToggle() {
  const { theme, setTheme } = useTheme();

  return (
    <SidebarMenuButton
      tooltip={theme === "dark" ? "Light mode" : "Dark mode"}
      onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
    >
      {theme === "dark" ? <Sun /> : <Moon />}
      <span>{theme === "dark" ? "Light mode" : "Dark mode"}</span>
    </SidebarMenuButton>
  );
}
