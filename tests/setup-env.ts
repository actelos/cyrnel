import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const current = process.env.MCI_DATA_DIR?.trim();

if (!current) {
  const directory = mkdtempSync(path.join(tmpdir(), "mci-test-"));
  process.env.MCI_DATA_DIR = directory;

  process.on("exit", () => {
    rmSync(directory, { recursive: true, force: true });
  });
}
