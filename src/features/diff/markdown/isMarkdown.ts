const MARKDOWN = /\.(?:md|markdown|mdown|mkdn?|mdx)$/i;

/** Files the diff can show rendered (F-089). */
export function isMarkdown(path: string): boolean {
  return MARKDOWN.test(path);
}
