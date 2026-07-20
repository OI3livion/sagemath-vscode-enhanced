/**
 * symbolDocs: the single source of truth for symbol documentation consumed by
 * hover, completion, completion-resolve, and signature help.
 *
 * There are two producers of SymbolDoc:
 *   1. `docFromSage()`  - converts a live `sage.misc.sageinspect` result into a
 *      structured SymbolDoc (preferred; version-accurate).
 *   2. `bundledBuiltinDoc()` / `bundledMethodDoc()` - the curated one-line
 *      fallback used when sage is unavailable or a symbol fails to resolve.
 *
 * Two Markdown renderers turn a SymbolDoc into hover text (verbose) or
 * completion-detail text (compact). Both are pure functions.
 */

import type { SageDocResult } from './sageBackend.js';
import { rstToMarkdown } from './rstToMarkdown.js';

export interface ParamDoc {
	name: string;
	type?: string;
	description: string;
	optional?: boolean;
	default?: string;
}

export interface SymbolDoc {
	signature?: string;
	summary: string;
	description?: string;
	params?: ParamDoc[];
	returns?: string;
	example?: string;
	seeAlso?: string[];
	docUrl?: string;
	category?: string;
	source?: 'sage' | 'bundled';
}

export interface RenderOptions {
	verbosity: 'short' | 'full';
	showExample: boolean;
}

/**
 * Build a SymbolDoc from a live sage lookup. Returns undefined when the lookup
 * failed or produced nothing usable.
 */
export function docFromSage(name: string, result: SageDocResult): SymbolDoc | undefined {
	if (!result || result.error) {
		return undefined;
	}
	const hasDoc = typeof result.doc === 'string' && result.doc.trim().length > 0;
	const hasArgs = Array.isArray(result.args);
	if (!hasDoc && !hasArgs) {
		return undefined;
	}

	let summary = '';
	let description: string | undefined;
	let example: string | undefined;
	if (hasDoc) {
		let body = rstToMarkdown(result.doc as string);
		// Split out an EXAMPLES block into a dedicated `example` so the
		// hoverShowExamples setting can toggle it independently.
		const exIdx = body.indexOf('**Examples**');
		if (exIdx >= 0) {
			const after = body.slice(exIdx);
			body = body.slice(0, exIdx).trimEnd();
			const fence = after.match(/```sage\n([\s\S]*?)```/);
			if (fence) {
				example = fence[1].trim();
			}
		}
		const lines = body.split('\n').map(l => l.trimEnd()).filter((l, idx, arr) =>
			!(l.trim() === '' && (idx === 0 || idx === arr.length - 1)));
		const firstNonBlank = lines.findIndex(l => l.trim() !== '');
		if (firstNonBlank >= 0) {
			summary = lines[firstNonBlank].trim();
		}
		if (firstNonBlank >= 0 && lines.length > firstNonBlank + 1) {
			const rest = lines.slice(firstNonBlank + 1).join('\n').trim();
			if (rest) {
				description = rest;
			}
		}
	}

	let signature: string | undefined;
	let params: ParamDoc[] | undefined;
	if (hasArgs) {
		const args = result.args as string[];
		const defaults = result.defaults ?? [];
		const offset = args.length - defaults.length;
		const rendered: string[] = [];
		params = args.map((a, idx) => {
			const dIdx = idx - offset;
			const hasDefault = dIdx >= 0 && dIdx < defaults.length && defaults[dIdx] !== undefined && defaults[dIdx] !== null;
			if (hasDefault) {
				rendered.push(`${a}=${defaults[dIdx]}`);
			} else {
				rendered.push(a);
			}
			return {
				name: a,
				description: '',
				optional: hasDefault,
				default: hasDefault ? String(defaults[dIdx]) : undefined
			};
		});
		if (result.varargs) {
			rendered.push(`*${result.varargs}`);
		}
		if (result.keywords) {
			rendered.push(`**${result.keywords}`);
		}
		signature = `${name}(${rendered.join(', ')})`;
	}

	return {
		signature,
		summary: summary || name,
		description,
		params,
		example,
		source: 'sage'
	};
}

export function renderHoverMarkdown(doc: SymbolDoc, opts: RenderOptions): string {
	const lines: string[] = [];
	if (doc.signature) {
		lines.push('```sage');
		lines.push(doc.signature);
		lines.push('```');
		lines.push('');
	}
	if (doc.summary) {
		lines.push(doc.summary);
	}
	if (opts.verbosity === 'full') {
		if (doc.description) {
			lines.push('');
			lines.push(doc.description);
		}
		if (doc.params && doc.params.length) {
			lines.push('');
			lines.push('**Parameters**');
			lines.push('');
			lines.push('| Name | Description |');
			lines.push('|------|-------------|');
			for (const p of doc.params) {
				const desc = p.description || (p.optional ? '*(optional)*' : '');
				const label = p.default ? `${p.name}=${p.default}` : p.name;
				lines.push(`| \`${label}\` | ${desc} |`);
			}
		}
		if (doc.returns) {
			lines.push('');
			lines.push(`**Returns:** ${doc.returns}`);
		}
		if (opts.showExample && doc.example) {
			lines.push('');
			lines.push('**Example**');
			lines.push('```sage');
			lines.push(doc.example);
			lines.push('```');
		}
	}
	if (doc.docUrl) {
		lines.push('');
		lines.push(`[📖 SageMath docs](${doc.docUrl})`);
	}
	return lines.join('\n').trim();
}

export function renderCompletionMarkdown(doc: SymbolDoc, _opts: RenderOptions): string {
	const lines: string[] = [];
	if (doc.summary) {
		lines.push(doc.summary);
	}
	if (doc.signature) {
		lines.push('');
		lines.push('```sage');
		lines.push(doc.signature);
		lines.push('```');
	}
	if (doc.description) {
		const firstPara = doc.description.split('\n\n')[0];
		if (firstPara) {
			lines.push('');
			lines.push(firstPara);
		}
	}
	return lines.join('\n').trim();
}
/**
 * Bundled fallback documentation. Used when sage is unavailable or a symbol
 * fails to resolve against the live runtime. Only `summary` is populated, so
 * the fallback reproduces the pre-feature (one-line) hover/completion UX.
 */
export const BUILTIN_FALLBACK: Record<string, string> = {
	'ZZ': 'The ring of integers. Example: `ZZ(5)` creates the integer 5 in the integer ring.',
	'QQ': 'The field of rational numbers. Example: `QQ(1/2)` creates the rational number 1/2.',
	'RR': 'The field of real numbers with arbitrary precision. Example: `RR(pi)`.',
	'CC': 'The field of complex numbers. Example: `CC(1, 2)` creates `1 + 2*I`.',
	'SR': 'The symbolic ring. Example: `var("x"); f = x^2 + 1` keeps `f` symbolic.',
	'PolynomialRing': 'Creates a polynomial ring. Example: `R = PolynomialRing(QQ, "x"); x = R.gen()`.',
	'LaurentPolynomialRing': 'Creates a Laurent polynomial ring. Example: `R = LaurentPolynomialRing(QQ, "x")`.',
	'PowerSeriesRing': 'Creates a power series ring. Example: `R = PowerSeriesRing(QQ, "x")`.',
	'FractionField': 'Creates the fraction field of a ring. Example: `FractionField(QQ["x"])`.',
	'QuotientRing': 'Creates a quotient ring. Example: `QuotientRing(ZZ, 6*ZZ)`.',
	'NumberField': 'Creates a number field. Example: `K = NumberField(x^2 - 2, "a")`.',
	'GF': 'Creates a finite field (Galois field). Example: `F = GF(7)` or `F = GF(2^8)`.',
	'FiniteField': 'Alias for `GF`; creates a finite field. Example: `FiniteField(7)`.',
	'Zmod': 'Creates the ring of integers modulo n. Example: `Zmod(12)`.',
	'CyclotomicField': 'Creates a cyclotomic field. Example: `CyclotomicField(12)`.',
	'EllipticCurve': 'Creates an elliptic curve. Example: `E = EllipticCurve([0, 0, 0, -1, 0])`.',
	'EllipticCurve_from_j': 'Creates an elliptic curve from a j-invariant. Example: `EllipticCurve_from_j(0)`.',
	'var': 'Creates symbolic variables. Example: `var("x y z")` creates symbolic variables x, y, z.',
	'vars': 'Creates symbolic variables (plural helper). Example: `x, y = var("x y")`.',
	'matrix': 'Creates a matrix. Example: `matrix([[1, 2], [3, 4]])` creates a 2x2 matrix.',
	'vector': 'Creates a vector. Example: `vector([1, 2, 3])`.',
	'identity_matrix': 'Creates an identity matrix. Example: `identity_matrix(3)`.',
	'zero_matrix': 'Creates a zero matrix. Example: `zero_matrix(2, 3)`.',
	'ones_matrix': 'Creates a matrix of ones. Example: `ones_matrix(2, 3)`.',
	'random_matrix': 'Creates a random matrix. Example: `random_matrix(ZZ, 3, 3)`.',
	'diagonal_matrix': 'Creates a diagonal matrix. Example: `diagonal_matrix([1, 2, 3])`.',
	'block_matrix': 'Creates a block matrix. Example: `block_matrix([[A, B], [C, D]])`.',
	'plot': 'Plots functions. Example: `plot(sin(x), (x, 0, 2*pi))`.',
	'plot3d': '3D plotting. Example: `plot3d(lambda x, y: x^2 + y^2, (-2, 2), (-2, 2))`.',
	'parametric_plot': 'Parametric 2D plot. Example: `parametric_plot((cos(t), sin(t)), (t, 0, 2*pi))`.',
	'list_plot': 'Plots a list of points. Example: `list_plot([1, 4, 9, 16])`.',
	'solve': 'Solves equations. Example: `solve(x^2 - 4 == 0, x)`.',
	'factor': 'Factors polynomials or integers. Example: `factor(x^2 - 4)`.',
	'expand': 'Expands expressions. Example: `expand((x + 1)^3)`.',
	'simplify': 'Simplifies expressions. Example: `simplify(sin(x)^2 + cos(x)^2)`.',
	'diff': 'Computes derivatives. Example: `diff(sin(x), x)`.',
	'integrate': 'Computes integrals. Example: `integrate(sin(x), x)`.',
	'limit': 'Computes a limit. Example: `limit(sin(x)/x, x=0)`.',
	'taylor': 'Taylor series expansion. Example: `taylor(cos(x), x, 0, 6)`.',
	'gcd': 'Greatest common divisor. Example: `gcd(12, 18)`.',
	'lcm': 'Least common multiple. Example: `lcm(4, 6)`.',
	'is_prime': 'Primality test. Example: `is_prime(17)`.',
	'next_prime': 'Returns the next prime. Example: `next_prime(10)`.',
	'prime_range': 'Returns a list of primes in a range. Example: `prime_range(10)`.',
	'factorial': 'Computes factorial. Example: `factorial(5)`.',
	'euler_phi': "Euler's totient function. Example: `euler_phi(12)`.",
	'divisors': 'Returns the divisors of an integer. Example: `divisors(12)`.',
	'binomial': 'Binomial coefficient. Example: `binomial(5, 2)`.',
	'fibonacci': 'Fibonacci number. Example: `fibonacci(10)`.',
	'discrete_log': 'Computes a discrete logarithm. Example: `discrete_log(4, 2, 7)`.',
	'continued_fraction': 'Computes a continued fraction. Example: `continued_fraction(e)`.',
	'Graph': 'Creates a graph. Example: `G = Graph(); G.add_edges([(1, 2), (2, 3)])`.',
	'DiGraph': 'Creates a directed graph. Example: `G = DiGraph()`.',
	'Permutations': 'Generates permutations. Example: `Permutations(3).list()`.',
	'Combinations': 'Generates combinations. Example: `Combinations([1, 2, 3], 2).list()`.',
	'Partitions': 'Generates integer partitions. Example: `Partitions(5).list()`.',
	'LLL': 'Lenstra-Lenstra-Lovasz lattice reduction. Example: `M.LLL()`.',
	'Polynomial': 'Base polynomial type in SageMath.',
	'polygen': 'Generates a polynomial generator. Example: `x = polygen(QQ)`.',
	'pi': 'The mathematical constant pi (~3.14159).',
	'e': 'The mathematical constant e (~2.71828).',
	'I': 'The imaginary unit. Example: `CC(0, 1) == I`.',
	'infinity': 'Represents infinity. Alias: `oo`.',
	'oo': 'Represents infinity. Alias of `infinity`.'
};
export const METHOD_FALLBACK: Record<string, string> = {
	'parent': 'Returns the parent structure of an object. Example: `parent(5)` -> `Integer Ring`.',
	'base_ring': 'Returns the base ring. Example: `M.base_ring()`.',
	'characteristic': 'Returns the characteristic. Example: `GF(7).characteristic()` -> `7`.',
	'degree': 'Returns the degree. Example: `K.degree()` for a number field.',
	'gen': 'Returns a generator. Example: `R.gen()` for a polynomial ring.',
	'gens': 'Returns the generators. Example: `R.gens()`.',
	'nrows': 'Number of rows of a matrix. Example: `M.nrows()`.',
	'ncols': 'Number of columns of a matrix. Example: `M.ncols()`.',
	'rank': 'Rank of a matrix. Example: `M.rank()`.',
	'det': 'Determinant of a matrix. Example: `M.det()`.',
	'trace': 'Trace of a matrix. Example: `M.trace()`.',
	'transpose': 'Transpose of a matrix. Example: `M.transpose()`.',
	'inverse': 'Inverse of a matrix. Example: `M.inverse()`.',
	'eigenvalues': 'Eigenvalues of a matrix. Example: `M.eigenvalues()`.',
	'charpoly': 'Characteristic polynomial. Example: `M.charpoly()`.',
	'norm': 'Norm of an element. Example: `v.norm()`.',
	'substitute': 'Substitutes variables in an expression. Example: `f.substitute(x=2)`.',
	'subs': 'Substitutes variables (alias of substitute). Example: `f.subs(x=2)`.',
	'latex': 'Returns the LaTeX representation. Example: `latex(x^2 + 1)`.',
	'show': 'Pretty-prints an object. Example: `show(M)`.',
	'save': 'Saves an object to a file. Example: `M.save("matrix.sobj")`.',
	'load': 'Loads an object from a file. Example: `load("matrix.sobj")`.'
};

export function bundledBuiltinDoc(name: string): SymbolDoc | undefined {
	const s = BUILTIN_FALLBACK[name];
	return s ? { summary: s, source: 'bundled' } : undefined;
}

export function bundledMethodDoc(name: string): SymbolDoc | undefined {
	const s = METHOD_FALLBACK[name];
	return s ? { summary: s, source: 'bundled' } : undefined;
}


