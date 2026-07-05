import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// stubs
const stubsFile = path.join(root, "src/cli/workspace/stubs.ts");
let stubs = fs.readFileSync(stubsFile, "utf8");
if (!stubs.includes("slug === 'risks'")) {
  const old = [
    "        const id = slugify(normalizedTitle) || `doc-${Date.now()}`;",
    "        const path = workspaceArtifact(ctx.rootDir, 'docs', id);",
    "        const meta: DocFrontmatter = {",
    "          kind: 'doc',",
    "          id,",
    "          date: new Date().toISOString().slice(0, 10),",
    "          tags,",
    "        };",
    "        ctx.storage.write(path, meta, content);",
    '        return `Document "${title}" created at docs/${id}.md.`;',
  ].join("\n");
  const neu = [
    "        const slug = slugify(normalizedTitle) || `doc-${Date.now()}`;",
    "",
    "        if (slug === 'risks') {",
    "          const risksPath = workspaceFile(ctx.rootDir, 'risks');",
    "          const riskMeta: RiskFrontmatter = {",
    "            kind: 'risk',",
    "            id: 'risks',",
    "            severity: 'medium',",
    "            date: new Date().toISOString().slice(0, 10),",
    "          };",
    "          ctx.storage.write(risksPath, riskMeta, content);",
    '          return `Document "${title}" created at risks.md (workspace root).`;',
    "        }",
    "",
    "        const path = workspaceArtifact(ctx.rootDir, 'docs', slug);",
    "        const meta: DocFrontmatter = {",
    "          kind: 'doc',",
    "          id: slug,",
    "          date: new Date().toISOString().slice(0, 10),",
    "          tags,",
    "        };",
    "        ctx.storage.write(path, meta, content);",
    '        return `Document "${title}" created at docs/${slug}.md.`;',
  ].join("\n");
  if (!stubs.includes(old)) {
    console.error("stubs old block not found");
    process.exit(1);
  }
  stubs = stubs.replace(old, neu);
  fs.writeFileSync(stubsFile, stubs);
  console.log("stubs ok");
} else {
  console.log("stubs already patched");
}

// roles pluton
const rolesFile = path.join(root, "packages/core/src/agents/roles.ts");
let roles = fs.readFileSync(rolesFile, "utf8");
if (!roles.includes("knowledge-map")) {
  roles = roles.replace(
    "Describe the proposed structure (root → branches → leaves) in text and, when building via tool, emit a buildMindMap payload. Stay under 200 words.${CLARIFICATION_PROTOCOL}`",
    'Describe the proposed structure (root → branches → leaves) in text. Stay under 200 words.${CLARIFICATION_PROTOCOL}\n\n## Design-phase artifact (mandatory when running council in design-phase mode)\nPersist the knowledge map as ONE \\`createDocument\\` call:\n\n\\`createDocument({ title: "knowledge-map", content: "<markdown: root concept, branches, leaf nodes, and cross-links>" })\\`\n\nDo NOT rely on buildMindMap — it is not available in the CLI workspace.`',
  );
  roles = roles.replace(
    "    skills: ['mind-mapper', 'research-analyst'],\n  },\n  {\n    id: 'minos',",
    "    skills: ['document-writer', 'research-analyst'],\n  },\n  {\n    id: 'minos',",
  );
}
if (!roles.includes(".zelari/risks.md")) {
  roles = roles.replace(
    "Do NOT emit other workspace artifacts — your role is to evaluate, not to build.`",
    "The artifact is persisted at `.zelari/risks.md` (workspace root), NOT under docs/. Do NOT emit other workspace artifacts — your role is to evaluate, not to build.`",
  );
  roles = roles.replace(
    "    skills: ['research-analyst'],\n  },\n  {\n    id: 'lucifer',",
    "    skills: ['document-writer', 'research-analyst'],\n  },\n  {\n    id: 'lucifer',",
  );
}
fs.writeFileSync(rolesFile, roles);
console.log(
  "roles ok",
  roles.includes("knowledge-map"),
  roles.includes(".zelari/risks.md"),
);
