import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { type ReactNode, useEffect, useState } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import type { BundledLanguage } from "shiki";
import { useTheme } from "@/components/theme-provider";

const PLAINTEXT_LANGUAGES = new Set(["", "plaintext", "text", "txt"]);

interface SyntaxHighlightProps {
  code: string;
  language?: string;
}

function SyntaxHighlight({ code, language }: SyntaxHighlightProps) {
  const { theme } = useTheme();
  const [highlighted, setHighlighted] = useState<ReactNode | null>(null);

  useEffect(() => {
    let cancelled = false;

    const lang = language?.trim();
    if (!lang || PLAINTEXT_LANGUAGES.has(lang)) {
      setHighlighted(null);
      return () => {
        cancelled = true;
      };
    }

    setHighlighted(null);
    void (async () => {
      try {
        const { codeToHast } = await import("shiki");
        const root = await codeToHast(code, {
          lang: lang as BundledLanguage,
          theme: theme === "dark" ? "github-dark" : "github-light",
        });
        const node = toJsxRuntime(root, { Fragment, jsx, jsxs });
        if (!cancelled) {
          setHighlighted(node);
        }
      } catch {
        if (!cancelled) {
          setHighlighted(null);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [code, language, theme]);

  if (highlighted !== null) {
    return highlighted;
  }
  return <pre className="text-xs font-mono whitespace-pre">{code}</pre>;
}

export { SyntaxHighlight };
