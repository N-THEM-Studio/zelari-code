// Note: FileTreeNode is defined in this file (see bottom of file). The
// pre-monorepo monolithic types file imported it from './index' which
// created a circular reference; we declare it locally now.

/**
 * Supported document formats in the Knowledge Vault.
 * Markdown is the primary format; other text-based formats are also supported.
 */
export type DocumentFormat = 'markdown' | 'text' | 'json' | 'yaml' | 'html' | 'csv' | 'other';

/**
 * A parsed YAML-like frontmatter block (key/value) at the top of a document.
 * Keys are lowercased strings; values are strings.
 */
export type Frontmatter = Record<string, string>;

/**
 * A directed link between two documents, derived from a `[[wikilink]]`.
 */
export interface WikiLink {
  /** id/path of the source document that contains the link */
  source: string;
  /** id/path of the target document (or alias used if unresolved) */
  target: string;
  /** optional display alias used inside the brackets: [[target|alias]] */
  alias?: string;
}

/**
 * A document in the Knowledge Vault (Obsidian-style).
 */
export interface KnowledgeDocument {
  id: string;
  /** stable path used for [[wikilinks]], e.g. "notes/architecture" */
  path: string;
  title: string;
  content: string;
  format: DocumentFormat;
  tags: string[];
  category?: string;
  frontmatter: Frontmatter;
  /** workspace this document belongs to */
  workspaceId: string;
  /** optional parent folder id */
  folderId?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * A folder in the vault for hierarchical organization.
 */
export interface DocumentFolder {
  id: string;
  name: string;
  /** parent folder id (null/undefined for root) */
  parentId?: string;
  workspaceId: string;
  createdAt: number;
}

/**
 * Tag metadata with usage count and optional color.
 */
export interface KnowledgeTag {
  name: string;
  color?: string;
  count: number;
}

/**
 * A backlink entry: a document that links to a target document,
 * together with a snippet of the surrounding context.
 */
export interface BacklinkEntry {
  document: KnowledgeDocument;
  /** excerpt of content around the link */
  context: string;
}

/**
 * A node in a project file tree (used by the workspace file manager).
 * Minimal shape — extend with `children`, `size`, `mtime`, etc. as needed.
 */
export interface FileTreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
}
