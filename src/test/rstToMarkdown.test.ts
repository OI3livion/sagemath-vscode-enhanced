import * as assert from 'assert';
import { rstToMarkdown } from '../../server/src/rstToMarkdown.js';

suite('rstToMarkdown', () => {
	const sample = [
		'Return the ``n``-th Fibonacci number.',
		'',
		'INPUT:',
		'',
		'- ``n`` -- integer',
		'',
		'OUTPUT: integer',
		'',
		'EXAMPLES::',
		'',
		'    sage: fibonacci(10)',
		'    55',
		'',
		'.. SEEALSO::',
		'',
		'    :func:`lucas_number`',
		'',
		':trac:`12345`'
	].join('\n');

	test('converts double backticks to single', () => {
		const md = rstToMarkdown(sample);
		assert.ok(md.includes('`n`'), 'expected `n`');
		assert.ok(!md.includes('``n``'), 'did not expect ``n``');
	});

	test('converts EXAMPLES:: to a fenced code block', () => {
		const md = rstToMarkdown(sample);
		assert.ok(md.includes('```sage'), 'expected ```sage fence');
		assert.ok(md.includes('sage: fibonacci(10)'), 'expected example code');
		// fences must remain balanced (the inline ``..`` regex must not eat them)
		assert.strictEqual(md.split('```').length % 2, 1, 'unbalanced code fences');
	});

	test('converts ALLCAPS section headers to bold', () => {
		const md = rstToMarkdown(sample);
		assert.ok(md.includes('**Input**'));
		assert.ok(md.includes('**Output**: integer'));
	});

	test('handles admonition directives like .. SEEALSO::', () => {
		const md = rstToMarkdown(sample);
		assert.ok(md.includes('**Seealso**'), 'expected **Seealso**');
	});

	test('strips :func: roles and converts :trac: roles', () => {
		const md = rstToMarkdown(sample);
		assert.ok(md.includes('`lucas_number`'));
		assert.ok(md.includes('trac #12345'));
	});

	test('returns empty string for empty input', () => {
		assert.strictEqual(rstToMarkdown(''), '');
	});
});
