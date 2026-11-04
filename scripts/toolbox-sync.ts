// Regenerates src/toolbox.json from the public toolbox page so the dashboard's Toolbox page matches it.
// Usage: npm run toolbox:sync [path-to-toolbox-index.html]   (default: fetches https://sb-marketing.netlify.app/)
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const src = process.argv[2] ? readFileSync(process.argv[2], "utf8") : await (await fetch("https://sb-marketing.netlify.app/")).text();
const m = /const\s+SECTIONS\s*=\s*(\[[\s\S]*?\n\s*\]);/.exec(src);
if (!m) throw new Error("SECTIONS array not found in the toolbox page");
const sections = vm.runInNewContext(`(${m[1]})`, {}, { timeout: 1000 }) as any[];
const out = sections.map((s) => ({ title: s.title, icon: s.icon, tint: s.tint,
  tools: s.tools.map((t: any) => ({ emoji: t.emoji, name: t.name, description: t.description, tag: t.tag, url: t.url })) }));
if (!out.length || out.some((s) => !s.tools.every((t: any) => /^https:\/\//.test(t.url)))) throw new Error("Unexpected toolbox content");
writeFileSync(join(import.meta.dirname, "..", "src", "toolbox.json"), JSON.stringify({ source: "https://sb-marketing.netlify.app/", sections: out }, null, 2) + "\n");
console.log(`toolbox.json: ${out.reduce((a, s) => a + s.tools.length, 0)} tools in ${out.length} sections`);
