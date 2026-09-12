import { Check, Copy } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useNotification } from "@/hooks/use-notification";
import { apiFetchJson, buildUrl, errorMessageFrom } from "@/lib/api";
import { copyToClipboard } from "@/lib/copy";

const callbackResponseSchema = z.object({
  ok: z.boolean(),
  credentialId: z.string(),
});

export default function AuthCallbackPage() {
  const [searchParams] = useSearchParams();
  const { addNotification } = useNotification();
  const [status, setStatus] = useState<
    "idle" | "working" | "success" | "error"
  >("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [credentialId, setCredentialId] = useState<string | null>(null);
  const [copied, setCopied] = useState<"code" | "state" | null>(null);
  const autoAttempted = useRef(false);

  const code = searchParams.get("code") ?? "";
  const state = searchParams.get("state") ?? "";
  const providerError =
    searchParams.get("error_description") ?? searchParams.get("error") ?? "";
  const isPopup =
    typeof window !== "undefined" &&
    window.opener !== null &&
    window.opener !== undefined;

  const complete = useCallback(async () => {
    if (!code || !state) return;
    setStatus("working");
    setMessage(null);
    try {
      const result = await apiFetchJson(
        buildUrl("/auth/callback", { code, state }),
        callbackResponseSchema,
      );
      setCredentialId(result.credentialId);
      setStatus("success");
      setMessage("Authorization completed. This credential is now active.");
      addNotification({
        type: "success",
        title: "Success",
        message: "OAuth authorization completed.",
      });
    } catch (error) {
      setStatus("error");
      setMessage(errorMessageFrom(error, "Failed to complete authorization."));
    }
  }, [code, state, addNotification]);

  useEffect(() => {
    if (autoAttempted.current) return;
    if (!code || !state) return;
    if (providerError) return;
    autoAttempted.current = true;
    void complete();
  }, [code, state, providerError, complete]);

  async function handleCopy(value: string, which: "code" | "state") {
    const ok = await copyToClipboard(value);
    if (ok) {
      setCopied(which);
      window.setTimeout(() => setCopied(null), 2000);
    } else {
      addNotification({
        type: "error",
        title: "Error",
        message: "Unable to copy. Select the value manually.",
      });
    }
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-6 p-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">OAuth callback</h1>
        <p className="text-muted-foreground text-sm">
          Completes the authorization-code flow when this page is configured as
          the OAuth redirect URI.
        </p>
      </header>

      <Card>
        <CardContent className="space-y-4">
          {providerError ? (
            <p className="text-destructive text-sm">
              Provider returned an error: {providerError}
            </p>
          ) : null}

          {!code || !state ? (
            <div className="space-y-2">
              <p className="text-sm">
                No authorization code found in this URL.
              </p>
              <p className="text-muted-foreground text-xs">
                Expected{" "}
                <span className="font-mono">?code=...&amp;state=...</span>. If
                your provider issued a code manually, paste it into the
                scheme&apos;s &quot;Manual code entry&quot; form on the owning
                service, module, or registry instead.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="callback-code">Authorization code</Label>
                <div className="flex gap-2">
                  <Input
                    id="callback-code"
                    readOnly
                    value={code}
                    className="flex-1 font-mono text-xs"
                    onFocus={(e) => e.target.select()}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="gap-1"
                    onClick={() => void handleCopy(code, "code")}
                  >
                    {copied === "code" ? (
                      <Check className="size-3.5" />
                    ) : (
                      <Copy className="size-3.5" />
                    )}
                    {copied === "code" ? "Copied" : "Copy"}
                  </Button>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="callback-state">State</Label>
                <div className="flex gap-2">
                  <Input
                    id="callback-state"
                    readOnly
                    value={state}
                    className="flex-1 font-mono text-xs"
                    onFocus={(e) => e.target.select()}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="gap-1"
                    onClick={() => void handleCopy(state, "state")}
                  >
                    {copied === "state" ? (
                      <Check className="size-3.5" />
                    ) : (
                      <Copy className="size-3.5" />
                    )}
                    {copied === "state" ? "Copied" : "Copy"}
                  </Button>
                </div>
              </div>

              {status === "success" ? (
                <p className="text-sm text-green-600">
                  {message} Credential:{" "}
                  <span className="font-mono text-xs">{credentialId}</span>
                </p>
              ) : status === "error" ? (
                <p className="text-destructive text-sm">{message}</p>
              ) : status === "working" ? (
                <p className="text-muted-foreground text-sm">
                  Completing authorization...
                </p>
              ) : null}

              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  disabled={status === "working" || status === "success"}
                  onClick={() => void complete()}
                >
                  {status === "working"
                    ? "Completing..."
                    : status === "success"
                      ? "Completed"
                      : "Complete authorization"}
                </Button>
                {isPopup ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => window.close()}
                  >
                    Close window
                  </Button>
                ) : null}
              </div>

              {status === "error" ? (
                <p className="text-muted-foreground text-xs">
                  Automatic completion failed (the code may have expired or
                  already been used). Copy the code and state above into the
                  scheme&apos;s manual code form instead.
                </p>
              ) : null}
              {isPopup && status === "success" ? (
                <p className="text-muted-foreground text-xs">
                  You can close this window — the originating tab polls for
                  completion automatically.
                </p>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
