import { spawnSync } from "node:child_process";
import { cpSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const projectRoot = process.cwd();
const publicDirectory = resolve(projectRoot, "public");
const generatedPublicPaths = [
  resolve(publicDirectory, "assets"),
  resolve(publicDirectory, "index.html"),
];

for (const path of generatedPublicPaths) {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
}

const build = process.platform === "win32"
  ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm run build"], {
      cwd: projectRoot,
      stdio: "inherit",
    })
  : spawnSync("npm", ["run", "build"], { cwd: projectRoot, stdio: "inherit" });
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

cpSync(resolve(projectRoot, "dist"), publicDirectory, { recursive: true });
