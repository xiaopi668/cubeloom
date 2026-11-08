// 生成 / 更新管理页登录口令（只保存 scrypt 哈希，不保存明文）
// 用法：
//   node tools/set-password.mjs '我的口令'
//   echo -n '我的口令' | node tools/set-password.mjs --stdin
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ADMIN_DIR = path.join(ROOT, "admin");
const AUTH_FILE = path.join(ADMIN_DIR, "auth.json");

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 64);
  return `scrypt$16384$8$1$${salt.toString("base64")}$${key.toString("base64")}`;
}

async function readPassword() {
  const args = process.argv.slice(2);
  if (args[0] === "--stdin") {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  }
  if (args[0]) return args[0];
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("请输入新的管理页口令：", (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

const password = await readPassword();
if (!password || password.length < 6) {
  console.error("口令不能为空且至少 6 位");
  process.exit(1);
}

let existing = {};
try {
  existing = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
} catch {}

const config = {
  passwordHash: hashPassword(password),
  secret: existing.secret || crypto.randomBytes(32).toString("base64url"),
  sessionHours: existing.sessionHours ?? 12,
};
fs.mkdirSync(ADMIN_DIR, { recursive: true });
fs.writeFileSync(AUTH_FILE, JSON.stringify(config, null, 2) + "\n", "utf8");
try {
  fs.chmodSync(AUTH_FILE, 0o600);
} catch {}
console.log(`已写入 ${AUTH_FILE}`);
console.log(`口令哈希：${config.passwordHash.slice(0, 40)}…（scrypt，不可逆）`);
