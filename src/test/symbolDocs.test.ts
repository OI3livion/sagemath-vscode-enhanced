import * as assert from 'assert';
import type { SageDocResult } from '../../server/src/sageBackend.js';
import {
	docFromSage,
	renderHoverMarkdown,
	renderCompletionMarkdown,
	bundledBuiltinDoc,
	bundledMethodDoc
} from '../../server/src/symbolDocs.js';

suite('docFromSage + renderers', () => {
	const sageResult: SageDocResult = {
		doc: 'Construct a polynomial ring.\n\nINPUT:\n\n- ``base_ring`` -- the base ring\n\nEXAMPLES::\n\n    sage: R = PolynomialRing(QQ, "x")',
		args: ['base_ring', 'name', 'order'],
		varargs: null,
		keywords: null,
		defaults: ["None", "'degrevlex'"],
		callable: true
	};

	test('builds signature with defaults', () => {
		const doc = docFromSage('PolynomialRing', sageResult);
		assert.strictEqual(doc?.signature, "PolynomialRing(base_ring, name=None, order='degrevlex')");
	});

	test('marks optional parameters and defaults', () => {
		const doc = docFromSage('PolynomialRing', sageResult);
		assert.strictEqual(doc?.params?.length, 3);
		assert.strictEqual(doc?.params?.[0].optional, false);
		assert.strictEqual(doc?.params?.[1].optional, true);
		assert.strictEqual(doc?.params?.[2].default, "'degrevlex'");
	});

	test('extracts EXAMPLES into the example field', () => {
		const doc = docFromSage('PolynomialRing', sageResult);
		assert.ok(doc?.example?.includes('R = PolynomialRing'), 'expected example code');
	});

	test('returns undefined for error results', () => {
		assert.strictEqual(docFromSage('X', { error: 'boom' }), undefined);
	});

	test('returns undefined when there is nothing usable', () => {
		assert.strictEqual(docFromSage('X', {}), undefined);
	});

	test('full hover markdown includes signature, params table and example', () => {
		const doc = docFromSage('PolynomialRing', sageResult)!;
		const md = renderHoverMarkdown(doc, { verbosity: 'full', showExample: true });
		assert.ok(md.includes('```sage'));
		assert.ok(md.includes('PolynomialRing(base_ring'));
		assert.ok(md.includes('**Parameters**'));
		assert.ok(md.includes('**Example**'));
	});

	test('short verbosity omits params table and example', () => {
		const doc = docFromSage('PolynomialRing', sageResult)!;
		const md = renderHoverMarkdown(doc, { verbosity: 'short', showExample: true });
		assert.ok(!md.includes('**Parameters**'));
		assert.ok(!md.includes('**Example**'));
	});

	test('showExample=false hides the example block', () => {
		const doc = docFromSage('PolynomialRing', sageResult)!;
		const md = renderHoverMarkdown(doc, { verbosity: 'full', showExample: false });
		assert.ok(!md.includes('**Example**'));
	});

	test('completion markdown is compact', () => {
		const doc = docFromSage('PolynomialRing', sageResult)!;
		const md = renderCompletionMarkdown(doc, { verbosity: 'full', showExample: true });
		assert.ok(md.includes('Construct a polynomial ring'));
		assert.ok(md.includes('```sage'));
	});
});

suite('bundled fallback', () => {
	test('returns a built-in summary', () => {
		const doc = bundledBuiltinDoc('ZZ');
		assert.ok(doc?.summary.includes('ring of integers'));
		assert.strictEqual(doc?.source, 'bundled');
	});

	test('returns a method summary', () => {
		const doc = bundledMethodDoc('det');
		assert.ok(doc?.summary.includes('Determinant'));
	});

	test('returns undefined for unknown symbols', () => {
		assert.strictEqual(bundledBuiltinDoc('nope'), undefined);
	});
});
