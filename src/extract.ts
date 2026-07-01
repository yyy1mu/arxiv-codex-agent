// Unpack tar.gz sources so the reviewing agent can Read the .tex files.
import { $ } from "bun";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

/** Extract <saveDir>/<id>.tar.gz into <saveDir>/<id>/ (idempotent). */
export async function extractArchive(id: string, saveDir: string): Promise<boolean> {
  const tar = join(saveDir, `${id}.tar.gz`);
  if (!(await Bun.file(tar).exists())) return false;
  const out = join(saveDir, id);
  await mkdir(out, { recursive: true });
  try {
    await $`tar xzf ${tar} -C ${out}`.quiet();
    return true;
  } catch {
    return false; // some "tar.gz" are bare .tex; ignore, the agent can still read the dir
  }
}
