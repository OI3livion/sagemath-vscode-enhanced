/**
 * Pragmatic reStructuredText -> Markdown converter for SageMath docstrings.
 *
 * Sage docstrings (returned by `sage.misc.sageinspect.sage_getdoc`) are Sphinx
 * reST. VS Code hover renders Markdown. This module covers the common Sage
 * conventions well enough to produce readable hover cards without pulling in a
 * heavy dependency like pandoc:
 *
 *   - `EXAMPLES::` / `TESTS::` / `<HEADER>::` (double-colon) -> a fenced
 *     ```sage code block consuming the following indented region.
 *   - `INPUT:` / `OUTPUT:` / `<ALLCAPS>:` section headers -> **bold** headers.
 *   - `:func:`x`` / `:class:`x`` / `:meth:`x`` / `:obj:`x`` ... -> `x`
 *   - `:trac:`12345`` -> trac #12345
 *   - ``` ``code`` ``` (double backticks) -> `` `code` `` (single backticks).
 *   - `:math:`x`` -> `x` (loses LaTeX rendering but stays readable).
 *   - reST hyperlink `` `text <url>`_ `` -> Markdown `[text](url)`.
 *   - collapse 3+ blank lines.
 *
 * The function is pure and dependency-free so it can be unit-tested in plain
 * Node without VS Code or Sage.
 */

const RST_SECTION_HEADERS = new Set([
	'INPUT', 'OUTPUT', 'EXAMPLES', 'EXAMPLE', 'TESTS', 'TEST',
	'SEEALSO', 'SEE ALSO', 'NOTE', 'NOTES', 'WARNING', 'WARNINGS',
	'ALGORITHM', 'AUTHORS', 'AUTHOR', 'REFERENCES', 'REFERENCE',
	'TODO', 'THEORY', 'PLOT', 'PLOTS',
]);

function capitalize(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

export function rstToMarkdown(doc: string): string {
	if (!doc) {
		return '';
	}

	const text = doc.replace(/\r\n/g, '\n');
	const inLines = text.split('\n');
	const out: string[] = [];
	let inCodeBlock = false;
	let codeIndent = 0;
	let codeStarted = false;

	for (let i = 0; i < inLines.length; i++) {
		const line = inLines[i];
		const trimmed = line.trim();
		const indent = line.length - line.trimStart().length;

		if (inCodeBlock) {
			// A literal block ends when a non-blank line dedents below its indent.
			if (trimmed !== '' && indent < codeIndent) {
				out.push('```');
				out.push('');
				inCodeBlock = false;
				codeStarted = false;
				// fall through to process this line normally
			} else {
				// Skip blank lines before the first line of actual content so the
				// fenced block does not start with an empty line.
				if (!codeStarted && trimmed === '') {
					continue;
				}
				codeStarted = true;
				// Preserve relative indentation inside the block.
				out.push(line.slice(codeIndent));
				continue;
			}
		}

		// "<ALLCAPS>::" -> header + opening of a literal code block.
		const literalMatch = trimmed.match(/^([A-Z][A-Z ]+?)::\s*$/);
		if (literalMatch) {
			out.push(`**${capitalize(literalMatch[1].trim())}**`);
			out.push('');
			out.push('```sage');
			inCodeBlock = true;
			codeStarted = false;
			// Determine the block's indent from the next non-empty line.
			codeIndent = 0;
			for (let j = i + 1; j < inLines.length; j++) {
				if (inLines[j].trim() !== '') {
					codeIndent = inLines[j].length - inLines[j].trimStart().length;
					break;
				}
			}
			if (codeIndent === 0) {
				codeIndent = 4; // sensible fallback if nothing follows
			}
			continue;
		}

		// "<ALLCAPS>:" (single colon) -> bold header (inline list/paragraph follows).
		const headerMatch = trimmed.match(/^([A-Z][A-Z ]+?):\s*(.*)$/);
		if (headerMatch && RST_SECTION_HEADERS.has(headerMatch[1].trim())) {
			const header = headerMatch[1].trim();
			const rest = headerMatch[2].trim();
			out.push(`**${capitalize(header)}**${rest ? ': ' + rest : ''}`);
			continue;
		}

		// reST admonition directives like ".. NOTE::", ".. WARNING::",
		// ".. SEEALSO::" -> bold header (content rendered as normal text).
		const admonitionMatch = trimmed.match(/^\.\.\s+([A-Za-z][A-Za-z ]+)::\s*$/);
		if (admonitionMatch) {
			out.push(`**${capitalize(admonitionMatch[1].trim())}**`);
			continue;
		}

		out.push(line);
	}

	if (inCodeBlock) {
		out.push('```');
	}

	let result = out.join('\n');

	// Inline role / markup conversion (order matters). The negated classes also
	// exclude newlines so a span can never reach across a fenced code block.
	result = result.replace(/:trac:`(\d+)`/g, 'trac #$1');
	result = result.replace(/:(?:func|class|meth|obj|data|mod|const|attr|exc):`([^`\n]+)`/g, '`$1`');
	result = result.replace(/`([^`<\n]+)<([^>\n]+)>`_/g, '[$1]($2)');
	result = result.replace(/``([^`\n]+)``/g, '`$1`');
	result = result.replace(/:math:`([^`\n]+)`/g, '`$1`');

	// Collapse runs of blank lines.
	result = result.replace(/\n{3,}/g, '\n\n');

	return result.trim();
}
