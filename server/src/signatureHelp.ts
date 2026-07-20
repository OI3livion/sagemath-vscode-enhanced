/**
 * Signature-help call-context parser.
 *
 * Given the text immediately preceding the cursor, determine which function is
 * being called and which positional argument the cursor is on. Pure and
 * dependency-free so it can be unit-tested in plain Node.
 *
 * The algorithm:
 *   1. Forward-scan the window once to build a "masked" array marking every
 *      character that lies inside a string literal or a `#` line comment. This
 *      makes the subsequent backwards scan correct even when parentheses or
 *      commas appear inside strings/comments.
 *   2. Walk backwards from the cursor tracking nesting over () [] {}. The first
 *      unmatched '(' at depth 0 is the opening of the current call; the token
 *      immediately to its left is the callee.
 *   3. Count top-level (depth-1) commas between that '(' and the cursor to get
 *      the active argument index (0-based).
 */

export interface CallContext {
	callee: string;
	argIndex: number;
}

const OPEN = new Set(['(', '[', '{']);
const CLOSE = new Set([')', ']', '}']);
const IDENT = /[A-Za-z0-9_.]/;
const WS = /\s/;

function computeMask(text: string): boolean[] {
	const mask: boolean[] = new Array(text.length).fill(false);
	let inStr: string | null = null;
	let inComment = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		const prev = i > 0 ? text[i - 1] : '';
		if (inComment) {
			mask[i] = true;
			if (c === '\n') {
				inComment = false;
			}
			continue;
		}
		if (inStr) {
			mask[i] = true;
			if (c === inStr && prev !== '\\') {
				inStr = null;
			}
			continue;
		}
		mask[i] = false;
		if (c === '#') {
			inComment = true;
		} else if (c === '"' || c === "'") {
			inStr = c;
		}
	}
	return mask;
}

function countTopLevelCommas(text: string, mask: boolean[], from: number, to: number): number {
	let depth = 1; // we are inside the opening '('
	let commas = 0;
	for (let k = from; k < to; k++) {
		if (mask[k]) {
			continue;
		}
		const c = text[k];
		if (OPEN.has(c)) {
			depth++;
		} else if (CLOSE.has(c)) {
			depth--;
			if (depth === 0) {
				break;
			}
		} else if (c === ',' && depth === 1) {
			commas++;
		}
	}
	return commas;
}

export function getCallContextFromText(before: string): CallContext | undefined {
	const mask = computeMask(before);
	let depth = 0;
	let i = before.length - 1;

	while (i >= 0) {
		if (mask[i]) {
			i--;
			continue;
		}
		const ch = before[i];

		if (CLOSE.has(ch)) {
			depth++;
			i--;
			continue;
		}

		if (OPEN.has(ch)) {
			if (depth > 0) {
				depth--;
				i--;
				continue;
			}
			// This is the unmatched '(' opening the current call.
			if (ch !== '(') {
				// Current scope opens with '[' or '{' (e.g. indexing) - no signature help.
				return undefined;
			}
			// Grab the callee identifier immediately to the left.
			let j = i - 1;
			while (j >= 0 && WS.test(before[j])) {
				j--;
			}
			const end = j + 1;
			while (j >= 0 && IDENT.test(before[j])) {
				j--;
			}
			const callee = before.slice(j + 1, end).trim();
			if (!callee) {
				return undefined;
			}
			const argIndex = countTopLevelCommas(before, mask, i + 1, before.length);
			return { callee, argIndex };
		}

		i--;
	}

	return undefined;
}
