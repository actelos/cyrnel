export async function copyToClipboard(value: string): Promise<boolean> {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "absolute";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();

    const wasCopied = document.execCommand("copy");
    document.body.removeChild(textarea);

    return wasCopied;
  }
}