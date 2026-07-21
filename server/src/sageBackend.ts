/**
 * SageBackend: a lazy, supervised, cached bridge to the SageMath documentation
 * daemon (`server/sage_doc_daemon.py`).
 *
 * - Spawns ONE long-running `sage -python sage_doc_daemon.py` process on first
 *   use (sage startup is ~1-3s, paid once).
 * - Speaks line-delimited JSON over stdio with request/response correlation.
 * - Caches every result in memory keyed by symbol name (warm lookups are free).
 * - Restarts automatically if the daemon dies.
 * - Degrades gracefully: if sage is not installed or the daemon fails to start,
 *   `lookup()` resolves to an error result so callers can fall back to the
 *   bundled documentation.
 */

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';

export interface SageArgspec {
	args: string[] | null;
	varargs: string | null;
	keywords: string | null;
	defaults: string[];
}

export interface SageDocResult {
	doc?: string;
	args?: string[] | null;
	varargs?: string | null;
	keywords?: string | null;
	defaults?: string[];
	file?: string;
	callable?: boolean;
	error?: string;
	startup_error?: string;
	// Position-based (hover/signatures/complete) result fields:
	name?: string;
	signature?: string;
	kind?: string;
	source?: string;
	empty?: boolean;
	signatures?: Array<{ label: string; params: Array<{ name: string; default: string }>; active_parameter: number }>;
	items?: Array<{ label: string; kind: string; detail: string; doc: string; complete?: string }>;
}

interface Pending {
	resolve: (r: SageDocResult) => void;
	timer: NodeJS.Timeout;
}

type State = 'idle' | 'starting' | 'ready' | 'dead';

export class SageBackend {
	private proc: ChildProcess | null = null;
	private buffer = '';
	private pending = new Map<number, Pending>();
	private nextId = 1;
	private cache = new Map<string, SageDocResult>();
	private state: State = 'idle';
	private startPromise: Promise<void> | null = null;
	private sageLoaded = false;
	private startupError: string | null = null;
	private lastStartAttempt = 0;

	private sageCmd: string;
	private pythonCmd: string;
	private daemonPath: string;
	private enabled: boolean;
	private preferredMethod: string | undefined;
	private workingMethod: string | undefined;
	private handshakeTimeoutMs: number;
	private readonly retryCooldownMs = 30000;
	private onLog: ((msg: string) => void) | undefined;

	constructor(opts: {
		sageCmd: string;
		pythonCmd?: string;
		daemonPath: string;
		enabled: boolean;
		preferredMethod?: string;
		handshakeTimeoutMs?: number;
		onLog?: (msg: string) => void;
	}) {
		this.sageCmd = opts.sageCmd;
		this.pythonCmd = opts.pythonCmd ?? '';
		this.daemonPath = opts.daemonPath;
		this.enabled = opts.enabled;
		this.preferredMethod = opts.preferredMethod;
		this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? 30000;
		this.onLog = opts.onLog;
	}

	configure(opts: { sageCmd?: string; pythonCmd?: string; enabled?: boolean; preferredMethod?: string }): void {
		let commandChanged = false;
		if (opts.sageCmd !== undefined && opts.sageCmd !== this.sageCmd) {
			this.sageCmd = opts.sageCmd;
			commandChanged = true;
		}
		if (opts.pythonCmd !== undefined && opts.pythonCmd !== this.pythonCmd) {
			this.pythonCmd = opts.pythonCmd;
			commandChanged = true;
		}
		if (opts.preferredMethod !== undefined) {
			this.preferredMethod = opts.preferredMethod || undefined;
		}
		if (opts.enabled !== undefined) {
			this.enabled = opts.enabled;
		}
		if (commandChanged) {
			this.dispose(); // restart with the new commands on next use
		}
	}

	isAvailable(): boolean {
		return this.enabled && this.state === 'ready' && this.sageLoaded;
	}

	getStartupError(): string | null {
		return this.startupError;
	}

	/** Returns the launch method that successfully started the daemon, if any. */
	getWorkingMethod(): string | undefined {
		return this.workingMethod;
	}

	/** Kick off daemon startup in the background (e.g. on document open) so the
	 *  first hover/completion doesn't pay the sage import latency. */
	prewarm(): Promise<void> {
		if (!this.enabled) {
			return Promise.resolve();
		}
		return this.start();
	}

	private log(msg: string): void {
		if (this.onLog) {
			this.onLog(msg);
		}
	}

	/** Synchronous cache-only read. Returns undefined when not yet cached. */
	lookupCached(name: string): SageDocResult | undefined {
		return this.cache.get(name);
	}

	/** Async lookup; caches the outcome (including error results). */
	lookup(name: string, timeoutMs = 15000): Promise<SageDocResult> {
		const cached = this.cache.get(name);
		if (cached) {
			return Promise.resolve(cached);
		}
		return this.lookupUncached(name, timeoutMs);
	}

	/**
	 * Fire-and-forget namespace sync (debounced by the caller). Sends the
	 * document text so the daemon can execute eligible assignments/imports and
	 * build a live namespace for constructed-object completion (M.det on
	 * M = matrix(...)). No-op when the backend is disabled/unavailable.
	 */
	syncNamespace(text: string, enabled: boolean, timeoutMs = 30000): void {
		if (!this.enabled || (this.state !== 'ready' && this.state !== 'starting')) {
			return;
		}
		// Don't await; namespace sync is best-effort and must never block the
		// language server. Fire-and-forget with its own timeout.
		this.start().then(() => {
			if (this.state !== 'ready' || !this.proc || !this.proc.stdin) {
				return;
			}
			const id = this.nextId++;
			const timer = setTimeout(() => { this.pending.delete(id); }, timeoutMs);
			this.pending.set(id, { resolve: () => undefined, timer });
			try {
				this.proc!.stdin!.write(JSON.stringify({ id, op: 'sync_namespace', text, enabled }) + '\n');
			} catch {
				clearTimeout(timer);
				this.pending.delete(id);
			}
		}).catch(() => { /* ignore */ });
	}

	/**
	 * Position-based analysis (hover/signatures/complete). NOT cached -- the
	 * result depends on document text + cursor, which change constantly.
	 * Returns an error result when the backend is unavailable so callers can
	 * fall back.
	 */
	analyze(op: 'hover' | 'signatures' | 'complete', text: string, line: number, col: number, timeoutMs = 15000): Promise<SageDocResult> {
		return this.analyzeUncached(op, text, line, col, timeoutMs);
	}

	private async analyzeUncached(op: string, text: string, line: number, col: number, timeoutMs: number): Promise<SageDocResult> {
		if (!this.enabled) {
			return { error: 'sage backend disabled' };
		}
		if (this.state !== 'ready') {
			await this.start();
		}
		if (this.state !== 'ready' || !this.proc || !this.proc.stdin) {
			return { error: this.startupError ?? 'sage backend not ready' };
		}
		return new Promise<SageDocResult>((resolve) => {
			const id = this.nextId++;
			const settle = (r: SageDocResult) => resolve(r);
			const timer = setTimeout(() => {
				this.pending.delete(id);
				settle({ error: 'timeout' });
			}, timeoutMs);
			this.pending.set(id, { resolve: settle, timer });
			try {
				this.proc!.stdin!.write(JSON.stringify({ id, op, text, line, col }) + '\n');
			} catch (err) {
				clearTimeout(timer);
				this.pending.delete(id);
				settle({ error: `write failed: ${(err as Error).message}` });
			}
		});
	}

	private async lookupUncached(name: string, timeoutMs: number): Promise<SageDocResult> {
		if (!this.enabled) {
			const r: SageDocResult = { error: 'sage backend disabled' };
			this.cache.set(name, r);
			return r;
		}
		if (this.state !== 'ready') {
			await this.start();
		}
		if (this.state !== 'ready' || !this.proc || !this.proc.stdin) {
			const r: SageDocResult = { error: this.startupError ?? 'sage backend not ready' };
			this.cache.set(name, r);
			return r;
		}

		return new Promise<SageDocResult>((resolve) => {
			const id = this.nextId++;
			const settle = (r: SageDocResult) => {
				this.cache.set(name, r);
				resolve(r);
			};
			const timer = setTimeout(() => {
				this.pending.delete(id);
				settle({ error: 'timeout' });
			}, timeoutMs);
			this.pending.set(id, { resolve: settle, timer });

			try {
				this.proc!.stdin!.write(JSON.stringify({ id, op: 'lookup', name }) + '\n');
			} catch (err) {
				clearTimeout(timer);
				this.pending.delete(id);
				settle({ error: `write failed: ${(err as Error).message}` });
			}
		});
	}
	private start(): Promise<void> {
		if (this.state === 'ready') {
			return Promise.resolve();
		}
		if (this.startPromise) {
			return this.startPromise;
		}
		// Cooldown: after a failure, don't re-run the (slow) launch attempts on
		// every single lookup. Lets the next attempt through after retryCooldownMs.
		if (this.state === 'dead' && (Date.now() - this.lastStartAttempt) < this.retryCooldownMs) {
			return Promise.resolve();
		}
		this.lastStartAttempt = Date.now();
		this.startPromise = this.doStart().then(() => {
			if (this.state !== 'ready') {
				this.startPromise = null; // allow retry on a later call
			}
		});
		return this.startPromise;
	}

	/** Build the ordered list of launch methods to try. */
	private buildLaunchMethods(): { name: string; command: string; args: string[] }[] {
		const d = this.daemonPath;
		const methods: { name: string; command: string; args: string[] }[] = [
			{ name: 'sage -python', command: this.sageCmd, args: ['-python', d] },
			{ name: 'sage --python', command: this.sageCmd, args: ['--python', d] },
		];
		if (this.pythonCmd) {
			methods.push({ name: this.pythonCmd, command: this.pythonCmd, args: [d] });
		}
		methods.push({ name: 'python', command: 'python', args: [d] });
		methods.push({ name: 'python3', command: 'python3', args: [d] });

		// De-duplicate by command+args signature.
		const seen = new Set<string>();
		const deduped = methods.filter(m => {
			const sig = m.command + '\0' + m.args.join('\0');
			if (seen.has(sig)) { return false; }
			seen.add(sig);
			return true;
		});

		// Prefer the user-pinned method, then the last known-good method.
		const preferred = this.preferredMethod ?? this.workingMethod;
		if (preferred) {
			const idx = deduped.findIndex(m => m.name === preferred);
			if (idx > 0) {
				const [m] = deduped.splice(idx, 1);
				deduped.unshift(m);
			}
		}
		return deduped;
	}

	private async doStart(): Promise<void> {
		this.state = 'starting';
		if (!this.enabled) {
			this.state = 'dead';
			this.startupError = 'sage backend disabled';
			return;
		}
		if (!fs.existsSync(this.daemonPath)) {
			this.state = 'dead';
			this.startupError = `daemon script not found: ${this.daemonPath}`;
			return;
		}

		const methods = this.buildLaunchMethods();
		let lastError = 'no launch methods available';
		for (const method of methods) {
			this.log(`trying launch method: ${method.name}`);
			const outcome = await this.tryLaunch(method.command, method.args, this.handshakeTimeoutMs);
			if (outcome.ok && outcome.proc) {
				this.proc = outcome.proc;
				this.buffer = outcome.leftover ?? '';
				this.state = 'ready';
				this.sageLoaded = true;
				this.startupError = null;
				this.workingMethod = method.name;
				this.cache.clear(); // flush stale error-cached entries
				this.log(`sage backend ready via "${method.name}"`);
				this.attachPersistentHandlers();
				return;
			}
			lastError = outcome.error ?? lastError;
		}
		this.state = 'dead';
		this.startupError = lastError;
		this.log(`all launch methods failed: ${lastError}`);
	}
	/** Try a single launch method; resolves on first handshake (or failure/timeout). */
	private tryLaunch(
		command: string,
		args: string[],
		timeoutMs: number
	): Promise<{ ok: boolean; proc?: ChildProcess; leftover?: string; error?: string }> {
		return new Promise((resolve) => {
			let proc: ChildProcess;
			try {
				proc = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
			} catch (err) {
				resolve({ ok: false, error: `spawn ${command} failed: ${(err as Error).message}` });
				return;
			}

			const stdout = proc.stdout;
			const stderr = proc.stderr;
			if (!stdout || !stderr) {
				try { proc.kill(); } catch { /* ignore */ }
				resolve({ ok: false, error: `${command} produced no stdio` });
				return;
			}

			let settled = false;
			let buf = '';
			let leftover = '';
			const finish = (outcome: { ok: boolean; proc?: ChildProcess; leftover?: string; error?: string }) => {
				if (settled) { return; }
				settled = true;
				clearTimeout(timer);
				resolve(outcome);
			};

			const timer = setTimeout(() => {
				try { proc.kill(); } catch { /* ignore */ }
				finish({ ok: false, error: `handshake timeout after ${timeoutMs}ms` });
			}, timeoutMs);

			const onErr = (err: Error) => {
				try { proc.kill(); } catch { /* ignore */ }
				finish({ ok: false, error: `${command} spawn error: ${err.message}` });
			};
			const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
				finish({ ok: false, error: `${command} exited before handshake (code=${code} signal=${signal})` });
			};
			const onData = (chunk: string) => {
				buf += chunk;
				let nl: number;
				while ((nl = buf.indexOf('\n')) >= 0) {
					const line = buf.slice(0, nl).trim();
					buf = buf.slice(nl + 1);
					if (!line) { continue; }
					let parsed: any;
					try { parsed = JSON.parse(line); } catch { continue; }
					if (parsed && parsed.ready !== undefined) {
						leftover = buf;
						stdout.removeListener('data', onData);
						proc.removeListener('error', onErr);
						proc.removeListener('exit', onExit);
						if (parsed.sage === true) {
							finish({ ok: true, proc, leftover });
						} else {
							try { proc.kill(); } catch { /* ignore */ }
							finish({ ok: false, error: parsed.error || 'sage not importable via this method' });
						}
						return;
					}
				}
			};

			stdout.setEncoding('utf8');
			stdout.on('data', onData);
			stderr.on('data', () => { /* swallow startup noise */ });
			proc.on('error', onErr);
			proc.on('exit', onExit);
		});
	}

	/** Attach the long-lived handlers to a successfully-started daemon process. */
	private attachPersistentHandlers(): void {
		const proc = this.proc;
		if (!proc) { return; }
		const stdout = proc.stdout;
		const stderr = proc.stderr;
		if (stdout) {
			stdout.setEncoding('utf8');
			stdout.on('data', (chunk: string) => this.onStdout(chunk));
		}
		if (stderr) {
			stderr.on('data', () => { /* swallow */ });
		}
		proc.on('error', (err) => this.handleProcError(err));
		proc.on('exit', (code, signal) => this.handleProcExit(code, signal));
	}

	private handleProcError(err: Error): void {
		this.startupError = `sage daemon error: ${err.message}`;
		this.state = 'dead';
		this.failAll(new Error(this.startupError));
		this.proc = null;
		this.startPromise = null; // allow restart on next lookup
		this.log(`sage daemon error: ${err.message}`);
	}

	private handleProcExit(code: number | null, signal: NodeJS.Signals | null): void {
		if (this.state !== 'dead') {
			this.startupError = `sage daemon exited (code=${code} signal=${signal})`;
		}
		this.state = 'dead';
		this.failAll(new Error('sage daemon exited'));
		this.proc = null;
		this.startPromise = null; // allow restart on next lookup
		this.log(`sage daemon exited (code=${code} signal=${signal})`);
	}


	private onStdout(chunk: string): void {
		this.buffer += chunk;
		let idx: number;
		while ((idx = this.buffer.indexOf('\n')) >= 0) {
			const line = this.buffer.slice(0, idx).trim();
			this.buffer = this.buffer.slice(idx + 1);
			if (!line) {
				continue;
			}
			let parsed: any;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue;
			}
			// Ignore any stray handshake lines (handshake is consumed in tryLaunch).
			if (parsed && parsed.ready !== undefined) {
				continue;
			}
			const id = parsed && parsed.id;
			if (typeof id !== 'number') {
				continue;
			}
			const entry = this.pending.get(id);
			if (!entry) {
				continue;
			}
			this.pending.delete(id);
			clearTimeout(entry.timer);
			const result: SageDocResult = parsed.result ?? { error: parsed.error ?? 'no result' };
			entry.resolve(result);
		}
	}

	private failAll(err: Error): void {
		for (const [, entry] of this.pending) {
			clearTimeout(entry.timer);
			entry.resolve({ error: err.message });
		}
		this.pending.clear();
	}

	dispose(): void {
		this.failAll(new Error('disposed'));
		if (this.proc) {
			try {
				this.proc.kill();
			} catch {
				// ignore
			}
			this.proc = null;
		}
		this.state = 'idle';
		this.startPromise = null;
		this.startupError = null;
		this.sageLoaded = false;
		// workingMethod intentionally retained so a restart reuses the known-good method
		// cache intentionally retained across restarts
	}

}
