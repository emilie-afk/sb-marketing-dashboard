// Fails if the built site or tracked source contains secrets, private links, real emails or private terms.
// Runs in the Netlify build before publishing. PRIVATE_TERMS_FILE (local, git-ignored) adds confidential words.
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { execSync } from "node:child_process";

const root = join(import.meta.dirname, "..");
const RULES: [string, RegExp][] = [
  ["Google Sheets or Drive link", /(docs\.google\.com\/spreadsheets\/d\/|drive\.google\.com\/(file|drive)\/)(?!FAKE)[A-Za-z0-9_-]{20,}/],
  ["Shopify admin link for a real store", /admin\.shopify\.com\/store\/(?!demo-store)[a-z0-9-]+/],
  ["private Claude link", /claude\.ai\/(chat|code|artifact|project)/],
  ["email address", /\b(?!noreply@anthropic\.com)[\w.+-]+@(?!example\.(test|com)\b)[\w-]+\.[\w.-]+\b/],
  ["connection string", /postgres(ql)?:\/\/[^\s"'`]*@(?!\/)/],
  ["automation token", /\bmkd_[A-Za-z0-9_-]{40,}/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["Google OAuth secret", /GOCSPX-[A-Za-z0-9_-]{10,}/],
  ["source map", /sourceMappingURL=/],
];
const extra = process.env.PRIVATE_TERMS_FILE && existsSync(process.env.PRIVATE_TERMS_FILE)
  ? readFileSync(process.env.PRIVATE_TERMS_FILE, "utf8").split("\n").map((s) => s.trim()).filter(Boolean) : [];

const files: string[] = [];
const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : files.push(p); } };
if (existsSync(join(root, "dist"))) walk(join(root, "dist"));
try { files.push(...execSync("git ls-files", { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean).map((f) => join(root, f))); } catch { /* not a git checkout */ }

const ALLOW = new Set(["scripts/check-public-build.ts"]);
const problems: string[] = [];
for (const f of files) {
  const rel = relative(root, f);
  if (ALLOW.has(rel) || /\.(png|jpe?g|webp|ico|woff2?)$/.test(f) || rel === "package-lock.json") continue;
  const text = readFileSync(f, "utf8");
  for (const [name, re] of RULES) { const m = re.exec(text); if (m) problems.push(`${rel}: ${name} (${m[0].slice(0, 24)}...)`); }
  for (const t of extra) if (text.toLowerCase().includes(t.toLowerCase())) problems.push(`${rel}: private term`);
}
if (problems.length) { console.error("Public build check failed:\n" + problems.join("\n")); process.exit(1); }
console.log(`Public build check passed (${files.length} files).`);
