import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/components/theme-provider";
import { SidebarMenuButton } from "@/components/ui/sidebar";

export function ModeToggle() {
  const { theme, setTheme } = useTheme();

  return (
    <SidebarMenuButton
      tooltip={theme === "dark" ? "Light mode" : "Dark mode"}
      onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
      aria-label={
        theme === "dark" ? "Switch to light mode" : "Switch to dark mode"
      }
      className="w-8 shrink-0 justify-center"
    >
      {theme === "dark" ? <Sun /> : <Moon />}
    </SidebarMenuButton>
  );
}
