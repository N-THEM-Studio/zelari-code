/** Shared coding skill categories (SKILL.md frontmatter). */
export const CODING_CATEGORIES_LIST = [
  'plan',
  'refactor',
  'debug',
  'review',
  'test',
  'docs',
  'ops',
  'git',
  'db',
  'maint',
] as const;

export type CodingCategory = (typeof CODING_CATEGORIES_LIST)[number];

export const CODING_CATEGORIES = new Set<string>(CODING_CATEGORIES_LIST);
