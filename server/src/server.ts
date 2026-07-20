import * as path from 'path';
import {
	createConnection,
	TextDocuments,
	Diagnostic,
	DiagnosticSeverity,
	ProposedFeatures,
	InitializeParams,
	DidChangeConfigurationNotification,
	CompletionItem,
	CompletionItemKind,
	TextDocumentPositionParams,
	TextDocumentSyncKind,
	InitializeResult,
	Hover,
	MarkupKind,
	DocumentSymbol,
	SymbolKind,
	Range,
	Location,
	ReferenceParams,
	SignatureHelp,
	SignatureInformation,
	ParameterInformation
} from 'vscode-languageserver/node';

import {
	TextDocument
} from 'vscode-languageserver-textdocument';

import { SageBackend } from './sageBackend.js';
import {
	SymbolDoc,
	RenderOptions,
	docFromSage,
	docFromHoverResult,
	renderHoverMarkdown,
	renderCompletionMarkdown,
	bundledBuiltinDoc,
	bundledMethodDoc
} from './symbolDocs.js';
import { getCallContextFromText } from './signatureHelp.js';
import { rstToMarkdown } from './rstToMarkdown.js';

// Create a connection for the server using Node's IPC as a transport.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;

// SageMath built-in functions and classes
const SAGEMATH_BUILTINS = [
	// Rings and Fields
	'ZZ', 'QQ', 'RR', 'CC', 'GF', 'Zmod', 'PolynomialRing', 'NumberField',
	'LaurentPolynomialRing', 'PowerSeriesRing', 'FractionField', 'QuotientRing',
	'FiniteField', 'CyclotomicField', 'QuaternionAlgebra', 'MatrixAlgebra',
	// Basic functions
	'var', 'vars', 'SR', 'solve', 'factor', 'expand', 'simplify', 'diff', 'integrate',
	// Polynomial operations
	'Polynomial', 'poly', 'polynomial', 'polygen', 'PolynomialQuotientRing',
	// Linear algebra
	'matrix', 'vector', 'identity_matrix', 'zero_matrix', 'ones_matrix',
	'random_matrix', 'diagonal_matrix', 'block_matrix',
	// Plotting
	'plot', 'plot3d', 'parametric_plot', 'parametric_plot3d', 'implicit_plot',
	'list_plot', 'scatter_plot', 'contour_plot',
	// Number theory
	'gcd', 'lcm', 'is_prime', 'next_prime', 'prime_range', 'factorial',
	'euler_phi', 'divisors', 'prime_divisors', 'factor_trial_division',
	'legendre_symbol', 'jacobi_symbol', 'kronecker_symbol', 'quadratic_residues',
	'continued_fraction', 'convergents', 'nth_prime', 'prime_pi', 'discrete_log',
	// Lattice algorithms
	'LLL', 'BKZ', 'hermite_form', 'smith_form',
	// Combinatorics
	'Permutations', 'Combinations', 'Partitions', 'binomial',
	'catalan_number', 'fibonacci', 'lucas_number', 'stirling_number1', 'stirling_number2',
	// Graph theory
	'Graph', 'DiGraph', 'graphs',
	// Geometry
	'Point', 'Line', 'Circle', 'Polygon', 'Polyhedron',
	// Calculus
	'limit', 'taylor', 'series', 'laplace', 'inverse_laplace',
	'derivative', 'integral', 'sum', 'product', 'fourier_transform',
	'laplace_transform', 'symbolic_sum', 'symbolic_product',
	// Cryptography
	'RSA', 'ElGamal', 'DiffieHellman', 'AES', 'DES',
	// Elliptic curves
	'EllipticCurve', 'EllipticCurve_from_j',
	// Probability
	'random', 'randint', 'choice', 'shuffle',
	// Special functions
	'sin', 'cos', 'tan', 'exp', 'log', 'sqrt', 'abs', 'floor', 'ceil',
	'gamma', 'beta', 'zeta', 'bessel_J', 'bessel_Y',
	// Constants
	'pi', 'e', 'I', 'infinity', 'oo', 'NaN', 'golden_ratio'
];

// SageMath methods that are commonly used
const SAGEMATH_METHODS = [
	'parent', 'base_ring', 'characteristic', 'degree', 'gen', 'gens',
	'nrows', 'ncols', 'rank', 'det', 'trace', 'transpose', 'inverse',
	'eigenvalues', 'eigenvectors', 'charpoly', 'minimal_polynomial',
	'norm', 'conjugate', 'real_part', 'imag_part', 'numerator', 'denominator',
	'collect', 'coefficient', 'substitute', 'subs', 'variables',
	'is_zero', 'is_one', 'is_unit', 'is_nilpotent', 'is_invertible',
	'save', 'load', 'show', 'latex', 'pretty_print'
];
// ---------------------------------------------------------------------------
// Sage runtime documentation backend
// ---------------------------------------------------------------------------
// A lazy, cached bridge to `server/sage_doc_daemon.py`, which uses
// sage.misc.sageinspect to pull live docstrings + argspecs from the user's
// installed SageMath. When sage is unavailable, lookups resolve to an error and
// callers fall back to the bundled one-line docs (see symbolDocs.ts).
const sageDaemonPath = path.join(__dirname, '..', '..', '..', 'server', 'sage_doc_daemon.py');
const sageBackend = new SageBackend({
	sageCmd: 'sage',
	pythonCmd: '',
	daemonPath: sageDaemonPath,
	enabled: true,
	onLog: (msg: string) => connection.console.info(`[sage-docs] ${msg}`)
});

function lookupKey(word: string): string {
	// The jedi/getattr daemon resolves any bare or dotted name directly;
	// method names not present on sage.all simply fail to resolve and fall
	// back to the bundled docs, so no "method:" prefix is needed.
	return word;
}

function isKnownSageSymbol(word: string): boolean {
	return SAGEMATH_BUILTINS.includes(word) || SAGEMATH_METHODS.includes(word);
}

function isMethodWord(word: string): boolean {
	return !SAGEMATH_BUILTINS.includes(word) && SAGEMATH_METHODS.includes(word);
}

/** Synchronous cache-only doc read (used for completion `detail`). */
function getCachedDoc(word: string): SymbolDoc | undefined {
	const cached = sageBackend.lookupCached(lookupKey(word));
	if (cached) {
		const d = docFromSage(word, cached);
		if (d) {
			return d;
		}
	}
	return isMethodWord(word) ? bundledMethodDoc(word) : bundledBuiltinDoc(word);
}

/** Async doc read: live sage lookup with bundled fallback. Configures the
 *  backend from current settings (a cheap no-op when unchanged). */
async function resolveDoc(word: string, settings: SageMathSettings): Promise<SymbolDoc | undefined> {
	lastKnownSettings = settings;
	sageBackend.configure({
		sageCmd: settings.interpreterPath,
		pythonCmd: settings.sagePythonPath,
		enabled: settings.enableSageDocs,
		preferredMethod: settings.sageDocLaunchMethod
	});
	if (isKnownSageSymbol(word)) {
		const result = await sageBackend.lookup(lookupKey(word));
		const live = docFromSage(word, result);
		if (live) {
			return live;
		}
	}
	return isMethodWord(word) ? bundledMethodDoc(word) : bundledBuiltinDoc(word);
}




connection.onInitialize((params: InitializeParams) => {
	const capabilities = params.capabilities;

	// Does the client support the `workspace/configuration` request?
	hasConfigurationCapability = !!(
		capabilities.workspace && !!capabilities.workspace.configuration
	);
	hasWorkspaceFolderCapability = !!(
		capabilities.workspace && !!capabilities.workspace.workspaceFolders
	);
	hasDiagnosticRelatedInformationCapability = !!(
		capabilities.textDocument &&
		capabilities.textDocument.publishDiagnostics &&
		capabilities.textDocument.publishDiagnostics.relatedInformation
	);

	const result: InitializeResult = {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			// Tell the client that this server supports code completion.
			completionProvider: {
				resolveProvider: true,
				triggerCharacters: ['.', '(', '[', ' ']
			},
			// Tell the client that this server supports hover information.
			hoverProvider: true,
			// Tell the client that this server supports definition lookup.
			definitionProvider: true,
			// Tell the client that this server supports find references.
			referencesProvider: true,
			// Tell the client that this server supports document symbols.
			documentSymbolProvider: true,
			// Tell the client that this server supports signature help
			// (parameter hints while typing inside a call).
			signatureHelpProvider: {
				triggerCharacters: ['(', ','],
				retriggerCharacters: [',']
			}
		}
	};
	if (hasWorkspaceFolderCapability) {
		result.capabilities.workspace = {
			workspaceFolders: {
				supported: true
			}
		};
	}
	return result;
});

connection.onDocumentSymbol(params => {
	const document = documents.get(params.textDocument.uri);
	if (!document) {
		return [];
	}

	return parseDocumentSymbols(document);
});

connection.onInitialized(() => {
	if (hasConfigurationCapability) {
		// Register for all configuration changes.
		connection.client.register(DidChangeConfigurationNotification.type, undefined);
	}
	if (hasWorkspaceFolderCapability) {
		connection.workspace.onDidChangeWorkspaceFolders(_event => {
			connection.console.log('Workspace folder change event received.');
		});
	}
});

// The global settings, used when the `workspace/configuration` request is not supported by the client.
interface SageMathSettings {
	maxNumberOfProblems: number;
	enableDiagnostics: boolean;
	enableCompletion: boolean;
	enableHover: boolean;
	interpreterPath: string;
	enableSageDocs: boolean;
	hoverVerbosity: 'short' | 'full';
	hoverShowExamples: boolean;
	sagePythonPath: string;
	sageDocLaunchMethod: string;
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
const defaultSettings: SageMathSettings = {
	maxNumberOfProblems: 1000,
	enableDiagnostics: true,
	enableCompletion: true,
	enableHover: true,
	interpreterPath: 'sage',
	enableSageDocs: true,
	hoverVerbosity: 'full',
	hoverShowExamples: true,
	sagePythonPath: '',
	sageDocLaunchMethod: 'auto'
};
let globalSettings: SageMathSettings = defaultSettings;
// Most recently observed document settings; used by handlers (like
// completionItem/resolve) that do not receive a document URI.
let lastKnownSettings: SageMathSettings = defaultSettings;

// Cache the settings of all open documents
const documentSettings: Map<string, Thenable<SageMathSettings>> = new Map();

connection.onDidChangeConfiguration(change => {
	if (hasConfigurationCapability) {
		// Reset all cached document settings
		documentSettings.clear();
	} else {
		globalSettings = <SageMathSettings>(
			(change.settings.sagemathEnhanced || defaultSettings)
		);
	}

	// Revalidate all open text documents
	documents.all().forEach(validateTextDocument);
});

function getDocumentSettings(resource: string): Thenable<SageMathSettings> {
	if (!hasConfigurationCapability) {
		lastKnownSettings = globalSettings;
		return Promise.resolve(globalSettings);
	}
	let result = documentSettings.get(resource);
	if (!result) {
		result = connection.workspace.getConfiguration({
			scopeUri: resource,
			section: 'sagemathEnhanced'
		});
		documentSettings.set(resource, result);
	}
	// Keep lastKnownSettings fresh for handlers (e.g. completionItem/resolve)
	// that do not receive a document URI.
	result.then(s => { lastKnownSettings = s; }, () => { /* ignore */ });
	return result;
}

// Only keep settings for open documents
documents.onDidClose(e => {
	documentSettings.delete(e.document.uri);
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
let prewarmed = false;
documents.onDidChangeContent(change => {
	validateTextDocument(change.document);
	// Kick off the sage daemon import in the background on the first sage
	// document activity, so the first hover/completion isn't slow.
	if (!prewarmed) {
		prewarmed = true;
		sageBackend.prewarm().catch(() => { /* ignore */ });
	}
});

async function validateTextDocument(textDocument: TextDocument): Promise<void> {
	const settings = await getDocumentSettings(textDocument.uri);
	
	if (!settings.enableDiagnostics) {
		return;
	}

	const text = textDocument.getText();
	const problems = 0;
	const diagnostics: Diagnostic[] = [];

	// Basic syntax checking for SageMath
	const lines = text.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		
		// Check for common SageMath syntax issues
		// Check for unmatched parentheses, brackets, braces
		const openParens = (line.match(/\(/g) || []).length;
		const closeParens = (line.match(/\)/g) || []).length;
		if (openParens !== closeParens) {
			const diagnostic: Diagnostic = {
				severity: DiagnosticSeverity.Warning,
				range: {
					start: { line: i, character: 0 },
					end: { line: i, character: line.length }
				},
				message: `Unmatched parentheses on line ${i + 1}`,
				source: 'sagemath-enhanced'
			};
			diagnostics.push(diagnostic);
		}

		// Check for undefined variables that might be typos
		const varPattern = /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*(?!=)/g;
		let match;
		while ((match = varPattern.exec(line)) !== null) {
			const varName = match[1];
			// Skip if it's a known SageMath builtin
			if (!SAGEMATH_BUILTINS.includes(varName) && 
				!['var', 'x', 'y', 'z', 't', 'n', 'i', 'j', 'k'].includes(varName)) {
				// This could be enhanced with proper scope analysis
			}
		}
	}

	// Send the computed diagnostics to VS Code.
	connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

connection.onDidChangeWatchedFiles(_change => {
	// Monitored files have change in VS Code
	connection.console.log('We received a file change event');
});

// Helper function to get the word being typed at the cursor position
function getWordAtPosition(document: TextDocument, position: { line: number; character: number }): string {
	const line = document.getText({
		start: { line: position.line, character: 0 },
		end: { line: position.line, character: position.character }
	});
	
	// Match word characters at the end of the line up to cursor position
	const match = line.match(/[a-zA-Z_][a-zA-Z0-9_]*$/);
	return match ? match[0] : '';
}

// Helper function to check if a string matches a partial input (fuzzy matching)
function isPartialMatch(input: string, target: string): boolean {
	if (!input) {
		return true; // Empty input matches everything
	}
	
	const inputLower = input.toLowerCase();
	const targetLower = target.toLowerCase();
	
	// Direct substring match (highest priority)
	if (targetLower.includes(inputLower)) {
		return true;
	}
	
	// Prefix match (very high priority) 
	if (targetLower.startsWith(inputLower)) {
		return true;
	}
	
	// Fuzzy match - check if all characters in input appear in order in target
	// But only if the input is reasonably short to avoid too many false positives
	// Allow fuzzy matching only if input length is at most 60% of target length, minimum 3
	const maxFuzzyLength = Math.max(3, Math.floor(targetLower.length * 0.6));
	if (inputLower.length <= maxFuzzyLength && inputLower.length >= 2) {
		let targetIndex = 0;
		for (let i = 0; i < inputLower.length; i++) {
			const char = inputLower[i];
			const foundIndex = targetLower.indexOf(char, targetIndex);
			if (foundIndex === -1) {
				return false;
			}
			targetIndex = foundIndex + 1;
		}
		return true;
	}
	
	return false;
}

// Map jedi completion "type" strings to LSP CompletionItemKind.
function jediKindToLspKind(kind: string): CompletionItemKind {
	switch (kind) {
		case 'function': return CompletionItemKind.Function;
		case 'class': return CompletionItemKind.Class;
		case 'method': return CompletionItemKind.Method;
		case 'module': return CompletionItemKind.Module;
		case 'instance': return CompletionItemKind.Value;
		case 'property': return CompletionItemKind.Property;
		case 'keyword': return CompletionItemKind.Keyword;
		case 'param': return CompletionItemKind.Field;
		case 'statement': return CompletionItemKind.Variable;
		default: return CompletionItemKind.Text;
	}
}

// Returns true if the cursor is in a dotted-access context (e.g. `obj.` or
// `obj.par`), based on the current line text up to the cursor.
function isDottedContext(lineBeforeCursor: string, currentWord: string): boolean {
	const idx = lineBeforeCursor.length - currentWord.length - 1;
	if (idx < 0) {
		return false;
	}
	return lineBeforeCursor[idx] === '.';
}

// Find keyword arguments already used in the current call (before the cursor),
// so we don't re-offer them. Returns a Set of lowercase names.
function findUsedKwargs(lineBeforeCursor: string): Set<string> {
	const used = new Set<string>();
	const re = /([A-Za-z_]\w*)\s*=/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(lineBeforeCursor)) !== null) {
		used.add(m[1].toLowerCase());
	}
	return used;
}

// This handler provides the initial list of the completion items.
connection.onCompletion(
	async (textDocumentPosition: TextDocumentPositionParams): Promise<CompletionItem[]> => {
		const document = documents.get(textDocumentPosition.textDocument.uri);
		if (!document) {
			return [];
		}

		const settings = await getDocumentSettings(textDocumentPosition.textDocument.uri);
		if (!settings.enableCompletion) {
			return [];
		}

		const pos = textDocumentPosition.position;
		const lineText = document.getText({
			start: { line: pos.line, character: 0 },
			end: pos
		});
		const currentWord = getWordAtPosition(document, pos);
		const items: CompletionItem[] = [];
		const sageReady = sageBackend.isAvailable();

		// ---- Context 1: inside a function call -> keyword-argument completion.
		// Jedi's complete() returns globals here (useless); instead we offer the
		// callee's parameters from signature analysis, minus already-used kwargs.
		const callCtx = getCallContextFromText(lineText);
		if (callCtx) {
			if (sageReady) {
				const sigRes = await sageBackend.analyze('signatures', document.getText(), pos.line, pos.character, 5000);
				if (sigRes && !sigRes.error && sigRes.signatures && sigRes.signatures.length > 0) {
					const params = sigRes.signatures[0].params || [];
					const used = findUsedKwargs(lineText);
					for (const p of params) {
						if (!p.name || used.has(p.name.toLowerCase())) {
							continue;
						}
						items.push({
							label: p.name,
							kind: CompletionItemKind.Field,
							detail: p.default ? `keyword argument (default ${p.default})` : 'keyword argument',
							insertText: `${p.name}=`,
							filterText: p.name,
							sortText: '0' + p.name.toLowerCase()
						});
					}
				}
			}
			return items;
		}
		// ---- Context 2: dotted access (obj. or obj.par) -> attribute/method
		// completion via jedi. Falls back to the static method list when jedi
		// cannot infer the receiver type (e.g. cython singletons / constructors).
		if (isDottedContext(lineText, currentWord)) {
			if (sageReady) {
				const res = await sageBackend.analyze('complete', document.getText(), pos.line, pos.character, 5000);
				if (res && !res.error && res.items && res.items.length > 0) {
					for (const it of res.items) {
						const summary = it.doc ? rstToMarkdown(it.doc).split('\n').find(l => l.trim()) ?? '' : '';
						items.push({
							label: it.label,
							kind: jediKindToLspKind(it.kind),
							detail: it.kind,
							documentation: summary ? { kind: MarkupKind.Markdown, value: summary } : undefined,
							insertText: it.label,
							sortText: it.label
						});
					}
					return items;
				}
			}
			// Fallback: static common-method list (still useful when jedi gives up).
			SAGEMATH_METHODS.forEach((method) => {
				if (isPartialMatch(currentWord, method)) {
					const cachedMethod = getCachedDoc(method);
					items.push({
						label: method,
						kind: CompletionItemKind.Method,
						detail: cachedMethod?.signature ?? 'SageMath method',
						insertText: method,
						filterText: method,
						sortText: method.toLowerCase()
					});
				}
			});
			return items;
		}

		// ---- Context 3: general -> static prioritized list merged with jedi
		// extras (covers names not in our hardcoded list, e.g. MatrixSpace).
		const seen = new Set<string>();

		SAGEMATH_BUILTINS.forEach((builtin, index) => {
			if (isPartialMatch(currentWord, builtin)) {
				let sortPriority = '1';
				if (currentWord && builtin.toLowerCase().startsWith(currentWord.toLowerCase())) {
					sortPriority = '0';
				} else if (currentWord && builtin.toLowerCase().includes(currentWord.toLowerCase())) {
					sortPriority = '0.5';
				}
				const importantFunctions = ['PolynomialRing', 'matrix', 'plot', 'EllipticCurve', 'Graph'];
				if (importantFunctions.includes(builtin) && isPartialMatch(currentWord, builtin)) {
					sortPriority = '0' + sortPriority;
				}
				const cachedBuiltin = getCachedDoc(builtin);
				items.push({
					label: builtin,
					kind: CompletionItemKind.Function,
					data: index + 1,
					detail: cachedBuiltin?.signature ?? 'SageMath built-in',
					documentation: `SageMath built-in function or class: ${builtin}`,
					insertText: builtin,
					filterText: builtin,
					sortText: sortPriority + builtin.toLowerCase()
				});
				seen.add(builtin.toLowerCase());
			}
		});

		SAGEMATH_METHODS.forEach((method, index) => {
			if (isPartialMatch(currentWord, method)) {
				let sortPriority = '2';
				if (currentWord && method.toLowerCase().startsWith(currentWord.toLowerCase())) {
					sortPriority = '1.5';
				}
				const cachedMethod = getCachedDoc(method);
				items.push({
					label: method,
					kind: CompletionItemKind.Method,
					data: SAGEMATH_BUILTINS.length + index + 1,
					detail: cachedMethod?.signature ?? 'SageMath method',
					documentation: `Common SageMath method: ${method}`,
					insertText: method,
					filterText: method,
					sortText: sortPriority + method.toLowerCase()
				});
				seen.add(method.toLowerCase());
			}
		});

		// Jedi extras (e.g. MatrixSpace, NumberField variants, user imports).
		if (sageReady) {
			const res = await sageBackend.analyze('complete', document.getText(), pos.line, pos.character, 3000);
			if (res && !res.error && res.items) {
				for (const it of res.items) {
					const key = it.label.toLowerCase();
					if (seen.has(key)) {
						continue;
					}
					if (currentWord && !isPartialMatch(currentWord, it.label)) {
						continue;
					}
					const summary = it.doc ? rstToMarkdown(it.doc).split('\n').find(l => l.trim()) ?? '' : '';
					items.push({
						label: it.label,
						kind: jediKindToLspKind(it.kind),
						detail: it.kind,
						documentation: summary ? { kind: MarkupKind.Markdown, value: summary } : undefined,
						insertText: it.label,
						filterText: it.label,
						sortText: '3' + it.label.toLowerCase()
					});
					seen.add(key);
				}
			}
		}

		return items;
	}
);

// This handler resolves additional information for the item selected in
// the completion list. It is deliberately NON-BLOCKING: it renders from the
// cache (or the bundled fallback) so the completion widget never waits on a
// slow first-time sage startup. When sage is already available, it warms the
// cache in the background so the next resolve returns the live signature/docs.
connection.onCompletionResolve(
	(item: CompletionItem): CompletionItem => {
		const label = item.label;
		if (typeof label !== 'string' || !isKnownSageSymbol(label)) {
			return item;
		}
		// Fast path: cache-only (instant). Falls back to bundled one-liner.
		const cached = sageBackend.lookupCached(lookupKey(label));
		const doc = cached ? docFromSage(label, cached) : undefined;
		const final = doc ?? (isMethodWord(label) ? bundledMethodDoc(label) : bundledBuiltinDoc(label));
		if (final) {
			const md = renderCompletionMarkdown(final, {
				verbosity: lastKnownSettings.hoverVerbosity,
				showExample: lastKnownSettings.hoverShowExamples
			});
			if (md) {
				item.documentation = {
					kind: MarkupKind.Markdown,
					value: md
				};
			}
			if (final.signature) {
				item.detail = final.signature;
			}
		}

		// Warm the cache in the background ONLY when sage is already up, so this
		// never triggers or blocks on startup. Hover/prewarm are responsible for
		// the initial daemon start.
		if (!cached && sageBackend.isAvailable()) {
			resolveDoc(label, lastKnownSettings).catch(() => { /* ignore */ });
		}

		return item;
	}
);

// Provide hover information - context-aware, returns documentation for the
// symbol under the cursor (built-in, method, or user-defined).
connection.onHover(
	async (textDocumentPosition: TextDocumentPositionParams): Promise<Hover | undefined> => {
		const document = documents.get(textDocumentPosition.textDocument.uri);
		if (!document) {
			return undefined;
		}

		const settings = await getDocumentSettings(textDocumentPosition.textDocument.uri);
		// Only disable hover when the setting is explicitly false; this keeps
		// hover working even when the client omits the field entirely.
		if (settings.enableHover === false) {
			return undefined;
		}

		const wordRange = getWordRangeAtPosition(document, textDocumentPosition.position);
		if (!wordRange || !wordRange.word) {
			return undefined;
		}

		const word = wordRange.word;
		const lines: string[] = [];

		// 1. Live documentation: prefer position-based jedi analysis (rich,
		//    in-context, resolves user code + dotted names), then fall back to a
		//    name lookup, then to the bundled one-line docs.
		let sageDoc: SymbolDoc | undefined;
		const hoverResult = await sageBackend.analyze(
			'hover', document.getText(), textDocumentPosition.position.line, textDocumentPosition.position.character
		);
		if (hoverResult && !hoverResult.error && !hoverResult.empty) {
			sageDoc = docFromHoverResult(hoverResult.name || word, hoverResult);
		}
		if (!sageDoc) {
			sageDoc = await resolveDoc(word, settings);
		}
		if (sageDoc) {
			const kind = isMethodWord(word) ? 'method' : 'built-in';
			lines.push(`**${word}** *(SageMath ${kind})*`);
			lines.push('');
			lines.push(renderHoverMarkdown(sageDoc, {
				verbosity: settings.hoverVerbosity,
				showExample: settings.hoverShowExamples
			}));
		}

		// 2. User-defined symbol (function / class / variable in this document)
		const userSymbol = findUserSymbolInfo(document, word);
		if (userSymbol) {
			if (lines.length > 0) {
				lines.push('');
				lines.push('---');
				lines.push('');
			}
			lines.push('```sage');
			lines.push(userSymbol.detail);
			lines.push('```');
		}

		if (lines.length === 0) {
			return undefined;
		}

		return {
			contents: {
				kind: MarkupKind.Markdown,
				value: lines.join('\n')
			},
			range: wordRange.range
		};
	}
);

// Provide definition lookup - searches the current document for user-defined
// symbols (def / class / assignment). Built-in SageMath symbols have no local
// definition, so undefined is returned (VS Code shows "No definition found").
connection.onDefinition(
	(textDocumentPosition: TextDocumentPositionParams): Location | Location[] | undefined => {
		const document = documents.get(textDocumentPosition.textDocument.uri);
		if (!document) {
			return undefined;
		}

		const wordRange = getWordRangeAtPosition(document, textDocumentPosition.position);
		if (!wordRange || !wordRange.word) {
			return undefined;
		}

		return findDefinitionLocations(document, wordRange.word);
	}
);

// Provide find references - searches the current document for all occurrences
// of the symbol under the cursor (whole-word, case-sensitive matching).
connection.onReferences(
	(params: ReferenceParams): Location[] | undefined => {
		const document = documents.get(params.textDocument.uri);
		if (!document) {
			return undefined;
		}

		const wordRange = getWordRangeAtPosition(document, params.position);
		if (!wordRange || !wordRange.word) {
			return undefined;
		}

		const word = wordRange.word;
		const includeDeclaration = params.context.includeDeclaration;

		// Find the declaration line (if any) so we can skip it when requested.
		let declarationLine = -1;
		if (!includeDeclaration) {
			const declInfo = findUserSymbolInfo(document, word);
			if (declInfo) {
				declarationLine = declInfo.range.start.line;
			}
		}

		const locations: Location[] = [];
		const escapedWord = escapeRegExp(word);
		const referencePattern = new RegExp(`\\b${escapedWord}\\b`, 'g');

		for (let line = 0; line < document.lineCount; line++) {
			if (line === declarationLine) {
				continue;
			}
			const lineText = document.getText({
				start: { line, character: 0 },
				end: { line: line + 1, character: 0 }
			}).replace(/\n$/, '');

			let match: RegExpExecArray | null;
			referencePattern.lastIndex = 0;
			while ((match = referencePattern.exec(lineText)) !== null) {
				const char = match.index;
				locations.push({
					uri: document.uri,
					range: {
						start: { line, character: char },
						end: { line, character: char + word.length }
					}
				});
			}
		}

		return locations.length > 0 ? locations : undefined;
	}
);

// Provide signature help: parameter hints while typing inside a call. Uses
// position-based jedi analysis for rich, in-context signatures; falls back to
// the resolved-name signature when jedi cannot infer the call.
connection.onSignatureHelp(
	async (params): Promise<SignatureHelp | undefined> => {
		const document = documents.get(params.textDocument.uri);
		if (!document) {
			return undefined;
		}
		const settings = await getDocumentSettings(params.textDocument.uri);
		if (settings.enableCompletion === false) {
			return undefined;
		}

		// 1. Position-based jedi signatures (best -- resolves the actual call).
		const sigResult = await sageBackend.analyze(
			'signatures', document.getText(), params.position.line, params.position.character
		);
		if (sigResult && !sigResult.error && sigResult.signatures && sigResult.signatures.length > 0) {
			const jsig = sigResult.signatures[0];
			const parameters = jsig.params.map(p =>
				ParameterInformation.create(p.default ? `${p.name}=${p.default}` : p.name, '')
			);
			const sig = SignatureInformation.create(jsig.label, '', ...parameters);
			sig.activeParameter = Math.min(jsig.active_parameter, Math.max(0, parameters.length - 1));
			return {
				signatures: [sig],
				activeSignature: 0,
				activeParameter: sig.activeParameter
			};
		}

		// 2. Fallback: resolve the callee via the call-context parser + lookup.
		const offset = document.offsetAt(params.position);
		const before = document.getText().slice(Math.max(0, offset - 2000), offset);
		const ctx = getCallContextFromText(before);
		if (!ctx || !isKnownSageSymbol(ctx.callee)) {
			return undefined;
		}
		const doc = await resolveDoc(ctx.callee, settings);
		if (!doc || !doc.params || doc.params.length === 0) {
			return undefined;
		}
		const parameters = doc.params.map(p =>
			ParameterInformation.create(
				p.default ? `${p.name}=${p.default}` : p.name,
				p.description || (p.optional ? 'optional' : '')
			)
		);
		const sig = SignatureInformation.create(
			doc.signature ?? `${ctx.callee}(...)`, doc.summary, ...parameters
		);
		sig.activeParameter = Math.min(ctx.argIndex, parameters.length - 1);
		return {
			signatures: [sig],
			activeSignature: 0,
			activeParameter: sig.activeParameter
		};
	}
);

// Tear down the sage daemon when the connection shuts down.
connection.onShutdown(() => {
	sageBackend.dispose();
});


// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();

interface SymbolMatch {
	name: string;
	detail: string;
	kind: SymbolKind;
}

function matchSymbol(line: string): SymbolMatch | undefined {
	const defMatch = line.match(/^def\s+([\w\.]+)\s*\(([^)]*)\)\s*:?/);
	if (defMatch) {
		const [, name, params] = defMatch;
		return {
			name,
			detail: `(${params.trim()})`,
			kind: SymbolKind.Function
		};
	}

	const classMatch = line.match(/^class\s+([\w\.]+)\s*(\([^)]*\))?\s*:?/);
	if (classMatch) {
		const [, name, bases = ''] = classMatch;
		return {
			name,
			detail: bases.trim(),
			kind: SymbolKind.Class
		};
	}

	const assignmentMatch = line.match(/^([A-Za-z_]\w*)\s*=\s*.+/);
	if (assignmentMatch) {
		const [, name] = assignmentMatch;
		return {
			name,
			detail: 'assignment',
			kind: SymbolKind.Variable
		};
	}

	return undefined;
}

function buildRange(line: number, indent: number, length: number): Range {
	return {
		start: { line, character: indent },
		end: { line, character: length }
	};
}

function parseDocumentSymbols(textDocument: TextDocument): DocumentSymbol[] {
	const rootSymbols: DocumentSymbol[] = [];
	const stack: Array<{ indent: number; symbol: DocumentSymbol }> = [];

	for (let line = 0; line < textDocument.lineCount; line++) {
		const lineText = textDocument.getText({
			start: { line, character: 0 },
			end: { line: line + 1, character: 0 }
		});
		const content = lineText.replace(/\n$/, '');
		const trimmed = content.trim();

		if (!trimmed || trimmed.startsWith('#')) {
			continue;
		}

		const symbolMatch = matchSymbol(trimmed);
		if (!symbolMatch) {
			continue;
		}

		const indent = content.length - content.trimStart().length;
		const range = buildRange(line, indent, content.length);
		const symbol: DocumentSymbol = {
			name: symbolMatch.name,
			detail: symbolMatch.detail,
			kind: symbolMatch.kind,
			range,
			selectionRange: range,
			children: []
		};

		while (stack.length && indent <= stack[stack.length - 1].indent) {
			stack.pop();
		}

		if (stack.length) {
			stack[stack.length - 1].symbol.children?.push(symbol);
		} else {
			rootSymbols.push(symbol);
		}

		stack.push({ indent, symbol });
	}

	return rootSymbols;
}

// ---------------------------------------------------------------------------
// Helpers shared by hover, definition, and references handlers
// ---------------------------------------------------------------------------

function escapeRegExp(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isWordCharacter(ch: string): boolean {
	return /[a-zA-Z0-9_]/.test(ch);
}

// Returns the word at the given position along with its range, scanning both
// backwards and forwards from the cursor (unlike getWordAtPosition which only
// scans backwards). Returns undefined when the cursor is not on a word.
function getWordRangeAtPosition(document: TextDocument, position: { line: number; character: number }): { word: string; range: Range } | undefined {
	const lineText = document.getText({
		start: { line: position.line, character: 0 },
		end: { line: position.line + 1, character: 0 }
	}).replace(/\n$/, '');

	let start = position.character;
	let end = position.character;

	// Scan backwards to the start of the word
	while (start > 0 && isWordCharacter(lineText[start - 1])) {
		start--;
	}

	// Scan forwards to the end of the word
	while (end < lineText.length && isWordCharacter(lineText[end])) {
		end++;
	}

	if (start === end) {
		return undefined;
	}

	return {
		word: lineText.substring(start, end),
		range: {
			start: { line: position.line, character: start },
			end: { line: position.line, character: end }
		}
	};
}

// Searches the document for a user-defined symbol (function, class, or
// variable assignment) and returns its detail text and location.
function findUserSymbolInfo(document: TextDocument, word: string): { detail: string; range: Range } | undefined {
	const escapedWord = escapeRegExp(word);
	const defPattern = new RegExp(`^\\s*def\\s+(${escapedWord})\\s*\\(([^)]*)\\)`);
	const classPattern = new RegExp(`^\\s*class\\s+(${escapedWord})\\s*(\\([^)]*\\))?\\s*:`);
	// Assignment: word = value (but NOT == or :=)
	const assignPattern = new RegExp(`^\\s*(${escapedWord})\\s*=(?![=:])\\s*(.+)`);

	for (let line = 0; line < document.lineCount; line++) {
		const lineText = document.getText({
			start: { line, character: 0 },
			end: { line: line + 1, character: 0 }
		}).replace(/\n$/, '');

		let match = lineText.match(defPattern);
		if (match) {
			return {
				detail: `def ${word}(${match[2].trim()}):`,
				range: { start: { line, character: 0 }, end: { line, character: lineText.length } }
			};
		}

		match = lineText.match(classPattern);
		if (match) {
			const bases = match[2] ? match[2].trim() : '';
			return {
				detail: `class ${word}${bases}:`,
				range: { start: { line, character: 0 }, end: { line, character: lineText.length } }
			};
		}

		match = lineText.match(assignPattern);
		if (match) {
			return {
				detail: `${word} = ${match[2].trim()}`,
				range: { start: { line, character: 0 }, end: { line, character: lineText.length } }
			};
		}
	}

	return undefined;
}

// Returns definition locations for a user-defined symbol. Returns undefined
// when no definition is found (e.g. for built-in SageMath symbols).
function findDefinitionLocations(document: TextDocument, word: string): Location[] | undefined {
	const info = findUserSymbolInfo(document, word);
	if (!info) {
		return undefined;
	}
	return [{
		uri: document.uri,
		range: info.range
	}];
}