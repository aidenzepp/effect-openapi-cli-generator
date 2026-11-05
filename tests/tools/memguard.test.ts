import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const memguard = new URL("../../tools/memguard.sh", import.meta.url).pathname;

const alive = (pid: number): boolean => {
  const stat = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)])
    .stdout.toString()
    .trim();

  return stat !== "" && !stat.startsWith("Z");
};

// polls check every 50 ms until it holds or ms elapse
const settle = async (check: () => boolean | Promise<boolean>, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms;
  const attempt = async (): Promise<boolean> => {
    if (await check()) {
      return true;
    }

    if (Date.now() >= deadline) {
      return false;
    }

    await Bun.sleep(50);

    return await attempt();
  };

  return await attempt();
};

// kill(1) rather than process.kill: a process that is already gone is not an error here
const killQuietly = (pid: number) => Bun.spawnSync(["kill", "-KILL", String(pid)]);

const guarded = (ceiling: string, command: string[]) =>
  Bun.spawn([memguard, ceiling, "--", ...command], { stderr: "pipe", stdout: "pipe" });

describe("memguard", () => {
  test("a command whose RSS passes the ceiling is killed with status 137", async () => {
    const grow =
      "const a = []; for (let i = 0; i < 40; i++) { a.push(Buffer.alloc(16 << 20, 1)); await Bun.sleep(50); } await Bun.sleep(20000);";
    const guard = guarded("200", [process.execPath, "-e", grow]);
    try {
      const code = await guard.exited;
      const out = await new Response(guard.stdout).text();

      expect(code).toBe(137);
      expect(out).toMatch(/^memguard: peak_rss_mib=\d+ killed=yes$/mu);
    } finally {
      guard.kill("SIGKILL");
    }
  }, 15_000);

  test("killing the guard with TERM takes the command's grandchild down with it", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "memguard-"));
    const pidFile = path.join(dir, "pids");
    const guard = guarded("4096", ["sh", "-c", `sleep 20 & echo $$ $! > "${pidFile}"; wait`]);
    let pids: number[] = [];
    try {
      const read = async () => {
        const text = await Bun.file(pidFile)
          .text()
          .catch(() => "");
        pids = text.trim().split(/\s+/u).map(Number);

        return pids.length === 2 && pids.every((pid) => pid > 0);
      };

      expect(await settle(read, 5000)).toBe(true);

      const grandchild = pids[1] ?? 0;

      expect(alive(grandchild)).toBe(true);

      guard.kill("SIGTERM");
      await guard.exited;

      expect(await settle(() => !alive(grandchild), 2000)).toBe(true);
    } finally {
      guard.kill("SIGKILL");
      for (const pid of pids) {
        killQuietly(pid);
      }
      rmSync(dir, { force: true, recursive: true });
    }
  }, 15_000);

  test("a command that ends normally keeps its exit status and reports peak RSS", async () => {
    const guard = guarded("4096", ["sh", "-c", "exit 7"]);
    try {
      const code = await guard.exited;
      const out = await new Response(guard.stdout).text();

      expect(code).toBe(7);
      expect(out).toMatch(/^memguard: peak_rss_mib=\d+ killed=no$/mu);
    } finally {
      guard.kill("SIGKILL");
    }
  }, 15_000);
});
