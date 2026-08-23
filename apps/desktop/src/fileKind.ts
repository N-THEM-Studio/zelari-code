/**
 * Reference-mock palette for the Files tree.
 * Folders get a stable per-name hue (green / orange / purple / blue / pink /
 * yellow), mirroring the reference mock; files get a per-extension tint
 * (VS Code Material-like).
 */

const FOLDER_HUES: Record<string, string> = {
  green: "#4ade80",
  orange: "#e8875a",
  purple: "#b18cd9",
  blue: "#58a6ff",
  pink: "#e879b9",
  yellow: "#e3c46b",
};

const FOLDER_HUES_OPEN: Record<string, string> = {
  green: "#7ef0a4",
  orange: "#f4a37c",
  purple: "#c9a9e8",
  blue: "#82bfff",
  pink: "#f297cb",
  yellow: "#f0d789",
};

/** Folder name → hue, mirroring the reference mock. */
const FOLDER_HUE_BY_NAME: Record<string, string> = {
  ".claude": "green",
  ".git-msg-trash": "orange",
  ".github": "purple",
  ".git": "orange",
  ".tmp": "blue",
  ".zcode": "pink",
  ".zelari": "blue",
  ".zed": "blue",
  ".vscode": "blue",
  ".idea": "blue",
  apps: "purple",
  bin: "blue",
  build: "orange",
  coverage: "orange",
  dist: "orange",
  docs: "purple",
  eval: "yellow",
  mcps: "orange",
  packages: "blue",
  packagas: "blue", // typo kept from the mock
  public: "blue",
  scripts: "orange",
  src: "blue",
  test: "green",
  tests: "green",
  tools: "yellow",
  node_modules: "blue",
};

const HUE_ORDER = ["blue", "purple", "green", "orange", "yellow", "pink"] as const;

function hueForFolderName(name: string): string {
  const key = name.toLowerCase().replace(/\/+$/, "");
  const known = FOLDER_HUE_BY_NAME[key];
  if (known) return known;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return HUE_ORDER[h % HUE_ORDER.length];
}

/** Folder icon tint; slightly brighter when the folder is expanded. */
export function folderIconColor(name: string, open = false): string {
  const hue = hueForFolderName(name);
  return (open ? FOLDER_HUES_OPEN : FOLDER_HUES)[hue] ?? FOLDER_HUES.blue;
}

const BY_EXT: Record<string, string> = {
  ts: "#4fc1ff",
  tsx: "#4fc1ff",
  mts: "#4fc1ff",
  cts: "#4fc1ff",
  js: "#e5c07b",
  jsx: "#e5c07b",
  mjs: "#e5c07b",
  cjs: "#e5c07b",
  json: "#e5c07b",
  jsonc: "#e5c07b",
  css: "#61afef",
  scss: "#c678dd",
  sass: "#c678dd",
  less: "#c678dd",
  html: "#e59866",
  htm: "#e59866",
  md: "#56d364",
  mdx: "#56d364",
  rst: "#56d364",
  txt: "#94a3b8",
  py: "#4fc1ff",
  pyi: "#4fc1ff",
  rs: "#e8875a",
  go: "#89d185",
  java: "#e8875a",
  kt: "#c678dd",
  rb: "#e07070",
  php: "#b18cd9",
  vue: "#7ee787",
  svelte: "#e8875a",
  astro: "#e8875a",
  sql: "#e5c07b",
  graphql: "#e879b9",
  gql: "#e879b9",
  sh: "#89d185",
  bash: "#89d185",
  zsh: "#89d185",
  ps1: "#89d185",
  bat: "#89d185",
  yml: "#89d185",
  yaml: "#89d185",
  toml: "#89d185",
  ini: "#89d185",
  env: "#89d185",
  png: "#c678dd",
  jpg: "#c678dd",
  jpeg: "#c678dd",
  gif: "#c678dd",
  webp: "#c678dd",
  svg: "#e5c07b",
  ico: "#e5c07b",
  lock: "#94a3b8",
  zip: "#e879b9",
  gz: "#e879b9",
  tar: "#e879b9",
};

const BY_NAME: Record<string, string> = {
  ".gitignore": "#89d185",
  ".gitattributes": "#89d185",
  ".gitmessage": "#89d185",
  ".env": "#89d185",
  ".env.local": "#89d185",
  ".env.example": "#89d185",
  "dockerfile": "#61afef",
  "makefile": "#89d185",
  "license": "#94a3b8",
  "package.json": "#e5c07b",
  "package-lock.json": "#94a3b8",
  "tsconfig.json": "#4fc1ff",
};

/** File icon tint by extension (name-level overrides first). */
export function fileIconColor(name: string): string {
  const base = name.toLowerCase().replace(/.*[\\/]/, "");
  const byName = BY_NAME[base];
  if (byName) return byName;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "#94a3b8";
  const ext = base.slice(dot + 1);
  return BY_EXT[ext] ?? "#94a3b8";
}
