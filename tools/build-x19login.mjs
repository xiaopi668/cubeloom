#!/usr/bin/env node
/**
 * 构建网易登录助手（tools/x19login，Go，零第三方依赖）。
 *
 *   node tools/build-x19login.mjs                 # 当前平台 → tools/x19login/bin/
 *   node tools/build-x19login.mjs --out build/server --targets win,host
 *
 * 交叉编译只依赖 Go 自身（CGO_ENABLED=0），所以 Linux 上也能产出 x19login.exe。
 * 没装 Go 时返回 false，让调用方（tools/build.mjs）继续打包——网易 mc.cfg 旧方式仍可用。
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "tools", "x19login");

export function hasGo() {
  const r = spawnSync("go", ["version"], { encoding: "utf8" });
  return r.status === 0;
}

/**
 * @param {{ outDir?: string, targets?: Array<"host"|"win"|"linux"|"darwin"> }} opts
 * @returns {boolean} 是否至少产出一个二进制
 */
export function buildX19Login(opts = {}) {
  const outDir = path.resolve(ROOT, opts.outDir || path.join("tools", "x19login", "bin"));
  const wanted = opts.targets && opts.targets.length ? opts.targets : ["host"];
  fs.mkdirSync(outDir, { recursive: true });

  if (!hasGo()) {
    console.warn("  [x19login] 没找到 Go，跳过登录助手构建（仍可用 mc.cfg 旧方式）");
    return false;
  }

  let built = 0;
  const hostArch = process.arch === "arm64" ? "arm64" : "amd64";
  for (const target of wanted) {
    let goos;
    // Windows 引擎固定是 x64，交叉出来的 exe 也必须是 amd64（Apple Silicon 上也一样）
    let goarch = hostArch;
    let name;
    if (target === "host") {
      goos = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
      name = goos === "windows" ? "x19login.exe" : "x19login";
    } else {
      goos = target === "win" ? "windows" : target;
      goarch = goos === "windows" ? "amd64" : hostArch;
      name = goos === "windows" ? "x19login.exe" : "x19login";
    }
    const outfile = path.join(outDir, name);
    const r = spawnSync(
      "go",
      ["build", "-trimpath", "-ldflags", "-s -w", "-o", outfile, "."],
      {
        cwd: SRC,
        env: { ...process.env, CGO_ENABLED: "0", GOOS: goos, GOARCH: goarch },
        encoding: "utf8",
      }
    );
    if (r.status !== 0) {
      console.warn(`  [x19login] ${goos}/${goarch} 构建失败：${(r.stderr || "").trim().split("\n").slice(-2).join(" / ")}`);
      continue;
    }
    const mb = (fs.statSync(outfile).size / 1024 / 1024).toFixed(1);
    console.log(`  ${path.relative(ROOT, outfile)}  ${mb} MB（${goos}/${goarch}）`);
    built++;
  }
  return built > 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : "";
  };
  const out = get("--out");
  const targets = (get("--targets") || "host").split(",").map((s) => s.trim()).filter(Boolean);
  console.log("== 构建网易登录助手 ==");
  const ok = buildX19Login({ outDir: out || undefined, targets });
  process.exit(ok ? 0 : 1);
}
