import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import express, { type Request, type Response } from 'express';
import { WhoopClient } from './whoop-client.js';
import { WhoopDatabase } from './database.js';
import { WhoopSync } from './sync.js';

interface ToolArguments {
	days?: number;
	full?: boolean;
}

const config = {
	clientId: process.env.WHOOP_CLIENT_ID ?? '',
	clientSecret: process.env.WHOOP_CLIENT_SECRET ?? '',
	redirectUri: process.env.WHOOP_REDIRECT_URI ?? 'http://localhost:3000/callback',
	dbPath: process.env.DB_PATH ?? './whoop.db',
	port: Number.parseInt(process.env.PORT ?? '3000', 10),
	mode: process.env.MCP_MODE ?? 'http',
};

const db = new WhoopDatabase(config.dbPath);
const client = new WhoopClient({
	clientId: config.clientId,
	clientSecret: config.clientSecret,
	redirectUri: config.redirectUri,
	onTokenRefresh: tokens => db.saveTokens(tokens),
});

const existingTokens = db.getTokens();
if (existingTokens) {
	client.setTokens(existingTokens);
}

const sync = new WhoopSync(client, db);

// Last sync failure, surfaced on /health. Module scope so the MCP tool path and
// the /data endpoint both report into the same place.
let lastSyncError: string | null = null;

// Pending OAuth 'state' values. /auth and get_auth_url mint one; /callback
// must hand the same one back, so a stranger cannot use our /callback to
// attach their own Whoop account to this server.
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const pendingOauthStates = new Map<string, number>();

function issueOauthState(): string {
	const state = crypto.randomUUID();
	pendingOauthStates.set(state, Date.now() + OAUTH_STATE_TTL_MS);
	return state;
}

function consumeOauthState(state: string | undefined): boolean {
	if (!state) return false;
	const expiresAt = pendingOauthStates.get(state);
	pendingOauthStates.delete(state);
	return expiresAt !== undefined && expiresAt > Date.now();
}

const SESSION_TTL_MS = 30 * 60 * 1000;
const transports = new Map<string, { transport: StreamableHTTPServerTransport; lastAccess: number }>();

function cleanupStaleSessions(): void {
	const now = Date.now();
	for (const [sessionId, session] of transports) {
		if (now - session.lastAccess > SESSION_TTL_MS) {
			session.transport.close().catch(() => {});
			transports.delete(sessionId);
		}
	}
	for (const [state, expiresAt] of pendingOauthStates) {
		if (expiresAt <= now) pendingOauthStates.delete(state);
	}
}

setInterval(cleanupStaleSessions, 5 * 60 * 1000);

function formatDuration(millis: number | null): string {
	if (!millis) return 'N/A';
	const hours = Math.floor(millis / 3_600_000);
	const minutes = Math.floor((millis % 3_600_000) / 60_000);
	return `${hours}h ${minutes}m`;
}

function formatDate(isoString: string): string {
	return new Date(isoString).toLocaleDateString('en-US', {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
	});
}

function getRecoveryZone(score: number): string {
	if (score >= 67) return 'Green (Well Recovered)';
	if (score >= 34) return 'Yellow (Moderate)';
	return 'Red (Needs Rest)';
}

function getStrainZone(strain: number): string {
	if (strain >= 18) return 'All Out (18-21)';
	if (strain >= 14) return 'High (14-17)';
	if (strain >= 10) return 'Moderate (10-13)';
	return 'Light (0-9)';
}

// Rows are only as fresh as the last successful Whoop sync, so anything older
// than this must not be presented as "today".
const STALE_AFTER_HOURS = 36;

function ageInHours(isoString: string | null | undefined): number | null {
	if (!isoString) return null;
	const parsed = Date.parse(isoString);
	if (Number.isNaN(parsed)) return null;
	return (Date.now() - parsed) / 3_600_000;
}

// SQLite writes UTC without a timezone suffix; add one before parsing.
function sqlUtcToIso(value: string | null | undefined): string | null {
	if (!value) return null;
	return value.includes('T') ? value : value.replace(' ', 'T') + 'Z';
}

function stalenessNote(label: string, isoString: string | null | undefined): string {
	if (!isoString) return '> Note: the latest ' + label + ' record has no usable timestamp.\n';
	const age = ageInHours(isoString);
	if (age === null) return '> Note: the latest ' + label + ' timestamp could not be read.\n';
	if (age <= STALE_AFTER_HOURS) return '';
	return '> Note: the latest ' + label + ' record is ' + Math.round(age) + 'h old (' + formatDate(isoString) + '), so it is not from today.\n';
}

function validateDays(value: unknown): number {
	if (value === undefined || value === null) return 14;
	const num = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
	if (Number.isNaN(num) || num < 1) return 14;
	return Math.min(num, 90);
}

function validateBoolean(value: unknown): boolean {
	if (typeof value === 'boolean') return value;
	if (value === 'true') return true;
	return false;
}

function createMcpServer(): Server {
	const server = new Server(
		{ name: 'whoop-mcp-server', version: '1.0.0' },
		{ capabilities: { tools: {} } }
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: [
			{
				name: 'get_today',
				description: "Get today's Whoop data including recovery score, last night's sleep, and current strain.",
				inputSchema: { type: 'object', properties: {}, required: [] },
			},
			{
				name: 'get_recovery_trends',
				description: 'Get recovery score trends over time, including HRV and resting heart rate patterns.',
				inputSchema: {
					type: 'object',
					properties: { days: { type: 'number', description: 'Number of days to analyze (default: 14, max: 90)' } },
					required: [],
				},
			},
			{
				name: 'get_sleep_analysis',
				description: 'Get detailed sleep analysis including duration, stages, efficiency, and sleep debt.',
				inputSchema: {
					type: 'object',
					properties: { days: { type: 'number', description: 'Number of days to analyze (default: 14, max: 90)' } },
					required: [],
				},
			},
			{
				name: 'get_strain_history',
				description: 'Get training strain history and workout data.',
				inputSchema: {
					type: 'object',
					properties: { days: { type: 'number', description: 'Number of days to analyze (default: 14, max: 90)' } },
					required: [],
				},
			},
			{
				name: 'sync_data',
				description: 'Manually trigger a data sync from Whoop.',
				inputSchema: {
					type: 'object',
					properties: { full: { type: 'boolean', description: 'Force a full 90-day sync (default: false)' } },
					required: [],
				},
			},
			{
				name: 'get_auth_url',
				description: 'Get the Whoop authorization URL to connect your account.',
				inputSchema: { type: 'object', properties: {}, required: [] },
			},
		],
	}));

	server.setRequestHandler(CallToolRequestSchema, async request => {
		const { name, arguments: args } = request.params;
		const typedArgs = (args ?? {}) as ToolArguments;

		try {
			const dataTools = ['get_today', 'get_recovery_trends', 'get_sleep_analysis', 'get_strain_history'];
			if (dataTools.includes(name)) {
				const tokens = db.getTokens();
				if (!tokens) {
					return { content: [{ type: 'text', text: 'Not authenticated with Whoop. Use get_auth_url to authorize first.' }] };
				}
				client.setTokens(tokens);
				try {
					await sync.smartSync();
					lastSyncError = null;
				} catch (error) {
					// Continue with cached data, but make the failure visible on /health.
					lastSyncError = error instanceof Error ? error.message : String(error);
				}
			}

			switch (name) {
				case 'get_today': {
					const recovery = db.getLatestRecovery();
					const sleep = db.getLatestSleep();
					const cycle = db.getLatestCycle();

					if (!recovery && !sleep && !cycle) {
						return { content: [{ type: 'text', text: 'No data available. Try running sync_data first.' }] };
					}

					let response = "# Today's Whoop Summary\n\n";
					const notes = [recovery ? stalenessNote('recovery', recovery.created_at) : '', cycle ? stalenessNote('cycle', cycle.start_time) : ''].filter(Boolean).join('');
					if (notes) response += notes + '\n';

					if (recovery) {
						response += `## Recovery: ${recovery.recovery_score ?? 'N/A'}% ${recovery.recovery_score ? getRecoveryZone(recovery.recovery_score) : ''}\n`;
						response += `- **HRV**: ${recovery.hrv_rmssd?.toFixed(1) ?? 'N/A'} ms\n`;
						response += `- **Resting HR**: ${recovery.resting_hr ?? 'N/A'} bpm\n`;
						if (recovery.spo2) response += `- **SpO2**: ${recovery.spo2.toFixed(1)}%\n`;
						if (recovery.skin_temp) response += `- **Skin Temp**: ${recovery.skin_temp.toFixed(1)}°C\n`;
						response += '\n';
					}

					if (sleep) {
						const totalSleep = (sleep.total_in_bed_milli ?? 0) - (sleep.total_awake_milli ?? 0);
						response += `## Last Night's Sleep\n`;
						response += `- **Total Sleep**: ${formatDuration(totalSleep)}\n`;
						response += `- **Performance**: ${sleep.sleep_performance?.toFixed(0) ?? 'N/A'}%\n`;
						response += `- **Efficiency**: ${sleep.sleep_efficiency?.toFixed(0) ?? 'N/A'}%\n`;
						response += `- **Stages**: Light ${formatDuration(sleep.total_light_milli)}, Deep ${formatDuration(sleep.total_deep_milli)}, REM ${formatDuration(sleep.total_rem_milli)}\n`;
						if (sleep.respiratory_rate) response += `- **Respiratory Rate**: ${sleep.respiratory_rate.toFixed(1)} breaths/min\n`;
						response += '\n';
					}

					if (cycle) {
						response += `## Current Strain\n`;
						response += `- **Day Strain**: ${cycle.strain?.toFixed(1) ?? 'N/A'} ${cycle.strain ? getStrainZone(cycle.strain) : ''}\n`;
						if (cycle.kilojoule) response += `- **Calories**: ${Math.round(cycle.kilojoule / 4.184)} kcal\n`;
						if (cycle.avg_hr) response += `- **Avg HR**: ${cycle.avg_hr} bpm\n`;
						if (cycle.max_hr) response += `- **Max HR**: ${cycle.max_hr} bpm\n`;
					}

					return { content: [{ type: 'text', text: response }] };
				}

				case 'get_recovery_trends': {
					const days = validateDays(typedArgs.days);
					const trends = db.getRecoveryTrends(days);

					if (trends.length === 0) {
						return { content: [{ type: 'text', text: 'No recovery data available for the requested period.' }] };
					}

					let response = `# Recovery Trends (Last ${days} Days)\n\n`;
					response += '| Date | Recovery | HRV | RHR |\n|------|----------|-----|-----|\n';

					for (const day of trends) {
						response += `| ${formatDate(day.date)} | ${day.recovery_score}% | ${day.hrv?.toFixed(1) ?? 'N/A'} ms | ${day.rhr ?? 'N/A'} bpm |\n`;
					}

					const avgRecovery = trends.reduce((sum, d) => sum + (d.recovery_score || 0), 0) / trends.length;
					const avgHrv = trends.reduce((sum, d) => sum + (d.hrv || 0), 0) / trends.length;
					const avgRhr = trends.reduce((sum, d) => sum + (d.rhr || 0), 0) / trends.length;

					response += `\n## Averages\n- **Recovery**: ${avgRecovery.toFixed(0)}%\n- **HRV**: ${avgHrv.toFixed(1)} ms\n- **RHR**: ${avgRhr.toFixed(0)} bpm\n`;

					return { content: [{ type: 'text', text: response }] };
				}

				case 'get_sleep_analysis': {
					const days = validateDays(typedArgs.days);
					const trends = db.getSleepTrends(days);

					if (trends.length === 0) {
						return { content: [{ type: 'text', text: 'No sleep data available for the requested period.' }] };
					}

					let response = `# Sleep Analysis (Last ${days} Days)\n\n`;
					response += '| Date | Duration | Performance | Efficiency |\n|------|----------|-------------|------------|\n';

					for (const day of trends) {
						response += `| ${formatDate(day.date)} | ${day.total_sleep_hours?.toFixed(1) ?? 'N/A'}h | ${day.performance?.toFixed(0) ?? 'N/A'}% | ${day.efficiency?.toFixed(0) ?? 'N/A'}% |\n`;
					}

					const avgDuration = trends.reduce((sum, d) => sum + (d.total_sleep_hours || 0), 0) / trends.length;
					const avgPerf = trends.reduce((sum, d) => sum + (d.performance || 0), 0) / trends.length;
					const avgEff = trends.reduce((sum, d) => sum + (d.efficiency || 0), 0) / trends.length;

					response += `\n## Averages\n- **Duration**: ${avgDuration.toFixed(1)} hours\n- **Performance**: ${avgPerf.toFixed(0)}%\n- **Efficiency**: ${avgEff.toFixed(0)}%\n`;

					return { content: [{ type: 'text', text: response }] };
				}

				case 'get_strain_history': {
					const days = validateDays(typedArgs.days);
					const trends = db.getStrainTrends(days);

					if (trends.length === 0) {
						return { content: [{ type: 'text', text: 'No strain data available for the requested period.' }] };
					}

					let response = `# Strain History (Last ${days} Days)\n\n`;
					response += '| Date | Strain | Calories |\n|------|--------|----------|\n';

					for (const day of trends) {
						response += `| ${formatDate(day.date)} | ${day.strain?.toFixed(1) ?? 'N/A'} | ${day.calories ?? 'N/A'} kcal |\n`;
					}

					// Individual workouts live in their own table. The README promises this,
					// and nothing was reading it, so the rows were being synced for nothing.
					const workoutEnd = new Date().toISOString();
					const workoutStart = new Date(Date.now() - days * 86_400_000).toISOString();
					const workouts = db.getWorkoutsByDateRange(workoutStart, workoutEnd);
					if (workouts.length === 0) {
						response += '\nNo individual workouts recorded in this period.\n';
					} else {
						response += '\n## Workouts (' + workouts.length + ')\n\n';
						response += '| Date | Sport ID | Duration | Strain | Avg HR | Max HR | Calories |\n|------|----------|----------|--------|--------|--------|----------|\n';
						for (const w of workouts.slice(0, 40)) {
							const duration = formatDuration(Date.parse(w.end_time) - Date.parse(w.start_time));
							const calories = w.kilojoule === null ? 'N/A' : Math.round(w.kilojoule / 4.184) + ' kcal';
							response += '| ' + formatDate(w.start_time) + ' | ' + w.sport_id + ' | ' + duration + ' | ' + (w.strain === null ? 'N/A' : w.strain.toFixed(1)) + ' | ' + (w.avg_hr ?? 'N/A') + ' | ' + (w.max_hr ?? 'N/A') + ' | ' + calories + ' |\n';
						}
					}

					const avgStrain = trends.reduce((sum, d) => sum + (d.strain || 0), 0) / trends.length;
					const avgCalories = trends.reduce((sum, d) => sum + (d.calories || 0), 0) / trends.length;

					response += `\n## Averages\n- **Daily Strain**: ${avgStrain.toFixed(1)}\n- **Daily Calories**: ${Math.round(avgCalories)} kcal\n`;

					return { content: [{ type: 'text', text: response }] };
				}

				case 'sync_data': {
					const tokens = db.getTokens();
					if (!tokens) {
						return { content: [{ type: 'text', text: 'Not authenticated with Whoop. Use get_auth_url to authorize first.' }] };
					}
					client.setTokens(tokens);

					const full = validateBoolean(typedArgs.full);
					let stats;

					if (full) {
						stats = await sync.syncDays(90);
					} else {
						const result = await sync.smartSync();
						if (result.type === 'skip') {
							return { content: [{ type: 'text', text: 'Data is already up to date (synced within the last hour).' }] };
						}
						stats = result.stats;
					}

					return {
						content: [{
							type: 'text',
							text: `Sync complete!\n- Cycles: ${stats?.cycles}\n- Recoveries: ${stats?.recoveries}\n- Sleeps: ${stats?.sleeps}\n- Workouts: ${stats?.workouts}`,
						}],
					};
				}

				case 'get_auth_url': {
					const scopes = ['read:profile', 'read:body_measurement', 'read:cycles', 'read:recovery', 'read:sleep', 'read:workout', 'offline'];
					const url = client.getAuthorizationUrl(scopes, issueOauthState());
					return {
						content: [{
							type: 'text',
							text: `To authorize with Whoop:\n\n1. Visit: ${url}\n2. Log in and authorize\n3. You'll be redirected back automatically\n\nRedirect URI: ${config.redirectUri}`,
						}],
					};
				}

				default:
					throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
		}
	});

	return server;
}

async function main(): Promise<void> {
	if (config.mode === 'stdio') {
		const server = createMcpServer();
		const transport = new StdioServerTransport();
		await server.connect(transport);
		process.stderr.write('Whoop MCP server running on stdio\n');
	} else {
		const app = express();
		app.use(express.json());

		app.get('/callback', async (req: Request, res: Response) => {
			const code = req.query.code as string | undefined;
			if (!code) {
				res.status(400).send('Missing authorization code');
				return;
			}

			// Only accept callbacks we started ourselves: without this, anyone who
			// knows the URL could attach their own Whoop account to this server.
			const state = typeof req.query.state === 'string' ? req.query.state : undefined;
			if (!consumeOauthState(state)) {
				res.status(400).send('Invalid or expired state. Start again at /auth.');
				return;
			}

			try {
				const tokens = await client.exchangeCodeForTokens(code);
				db.saveTokens(tokens);
				sync.syncDays(90).catch(() => {});
				res.send('Authorization successful! You can close this window.');
			} catch {
				res.status(500).send('Authorization failed. Please try again.');
			}
		});

		app.get('/health', (_req: Request, res: Response) => {
			const cyc = db.getLatestCycle();
			const rec = db.getLatestRecovery();
			const syncState = db.getSyncState();
			let authenticated = false;
			let tokenExpiresAt: string | null = null;
			let tokenError: string | null = null;
			try {
				const tokens = db.getTokens();
				authenticated = Boolean(tokens);
				tokenExpiresAt = tokens ? new Date(tokens.expires_at).toISOString() : null;
			} catch (error) {
				tokenError = error instanceof Error ? error.message : String(error);
			}
			// One-glance summary: problems is empty when nothing needs attention.
			const problems: string[] = [];
			if (!authenticated) problems.push('Not connected to Whoop. Open /auth to reconnect.');
			if (tokenError) problems.push('Stored token could not be read: ' + tokenError);
			if (lastSyncError) problems.push('Last sync failed: ' + lastSyncError);
			if (!syncState.lastSyncAt) problems.push('Never synced yet. Call /data or use an MCP tool once.');
			const syncAgeHours = ageInHours(sqlUtcToIso(syncState.lastSyncAt));
			if (syncAgeHours !== null && syncAgeHours > 48) problems.push('Last sync was ' + Math.round(syncAgeHours) + 'h ago.');
			const recoveryAgeHours = ageInHours(rec?.created_at ?? null);
			if (recoveryAgeHours !== null && recoveryAgeHours > STALE_AFTER_HOURS) problems.push('Newest recovery record is ' + Math.round(recoveryAgeHours) + 'h old.');

			res.json({
				ok: problems.length === 0,
				problems,
				status: 'ok',
				authenticated,
				token_expires_at: tokenExpiresAt,
				token_expired: tokenExpiresAt ? Date.parse(tokenExpiresAt) < Date.now() : null,
				token_error: tokenError,
				last_sync_at: syncState.lastSyncAt,
				last_sync_error: lastSyncError,
				latest_recovery_created_at: rec?.created_at ?? null,
				latest_cycle_synced_at: cyc?.synced_at ?? null,
				latest_cycle_start: cyc?.start_time ?? null,
				latest_cycle_strain: cyc?.strain ?? null,
			});
		});

		// Browser re-auth: open this URL to reconnect Whoop (fresh OAuth tokens).
		// Works even when the MCP connector tools are unavailable.
		app.get('/auth', (_req: Request, res: Response) => {
			const scopes = ['read:profile', 'read:body_measurement', 'read:cycles', 'read:recovery', 'read:sleep', 'read:workout', 'offline'];
			res.redirect(client.getAuthorizationUrl(scopes, issueOauthState()));
		});

		// JSON data endpoint for the briefing "brain" server to pull Whoop data.
		// Protected by WHOOP_DATA_KEY, sent as an X-Whoop-Key header or ?key=... param.
		app.get('/data', async (req: Request, res: Response) => {
			const dataKey = process.env.WHOOP_DATA_KEY ?? '';
			const queryKey = typeof req.query.key === 'string' ? req.query.key : undefined;
			// Header is preferred: query strings leak into access logs and referrers.
			const providedKey = req.get('x-whoop-key') ?? queryKey;
			// Fail closed: with no key configured this endpoint would hand out health
			// data to anyone who knows the URL, so refuse instead of skipping the check.
			if (!dataKey) {
				res.status(503).json({ error: 'WHOOP_DATA_KEY is not configured on the server' });
				return;
			}
			if (providedKey !== dataKey) {
				res.status(403).json({ error: 'bad key' });
				return;
			}
			const tokens = db.getTokens();
			if (!tokens) {
				res.status(401).json({ error: 'not authenticated with Whoop' });
				return;
			}
			try {
				client.setTokens(tokens);
				try { await sync.quickSync(); lastSyncError = null; }
				catch (e) { lastSyncError = e instanceof Error ? e.message : String(e); }
				const latestRecovery = db.getLatestRecovery();
				const recoveryAgeHours = ageInHours(latestRecovery?.created_at ?? null);
				res.json({
					ok: true,
					generated_at: new Date().toISOString(),
					last_sync_at: db.getSyncState().lastSyncAt,
					last_sync_error: lastSyncError,
					stale_after_hours: STALE_AFTER_HOURS,
					recovery_age_hours: recoveryAgeHours === null ? null : Math.round(recoveryAgeHours * 10) / 10,
					stale: recoveryAgeHours === null || recoveryAgeHours > STALE_AFTER_HOURS,
					recovery: latestRecovery,
					sleep: db.getLatestSleep(),
					cycle: db.getLatestCycle(),
					recovery_trends: db.getRecoveryTrends(7),
					sleep_trends: db.getSleepTrends(7),
					strain_trends: db.getStrainTrends(7),
				});
			} catch (error) {
				res.status(500).json({ error: error instanceof Error ? error.message : 'unknown' });
			}
		});

		app.all('/mcp', async (req: Request, res: Response) => {
			// Optional gate: set WHOOP_MCP_KEY in Railway to require a key here.
			// Left unset the endpoint stays open, so the variable is the only switch.
			const mcpKey = process.env.WHOOP_MCP_KEY ?? '';
			if (mcpKey) {
				const bearer = (req.get('authorization') ?? '').replace(/^Bearer /i, '');
				const queryKey = typeof req.query.key === 'string' ? req.query.key : '';
				const provided = bearer || req.get('x-whoop-key') || queryKey;
				if (provided !== mcpKey) {
					res.status(401).json({ error: 'unauthorized' });
					return;
				}
			}

			const sessionId = req.headers['mcp-session-id'] as string | undefined;

			if (req.method === 'DELETE' && sessionId && transports.has(sessionId)) {
				const session = transports.get(sessionId)!;
				await session.transport.close();
				transports.delete(sessionId);
				res.status(200).send('Session closed');
				return;
			}

			if (req.method === 'POST') {
				let transport: StreamableHTTPServerTransport;

				if (sessionId && transports.has(sessionId)) {
					const session = transports.get(sessionId)!;
					session.lastAccess = Date.now();
					transport = session.transport;
				} else {
					transport = new StreamableHTTPServerTransport({
						sessionIdGenerator: () => crypto.randomUUID(),
						onsessioninitialized: newSessionId => {
							transports.set(newSessionId, { transport, lastAccess: Date.now() });
						},
					});

					const server = createMcpServer();
					await server.connect(transport);
				}

				await transport.handleRequest(req, res, req.body);
				return;
			}

			res.status(405).send('Method not allowed');
		});

		app.get('/sse', (_req: Request, res: Response) => {
			res.status(410).send('SSE endpoint deprecated. Use /mcp with Streamable HTTP transport.');
		});

		const server = app.listen(config.port, '0.0.0.0', () => {
			process.stdout.write(`Whoop MCP server running on http://0.0.0.0:${config.port}\n`);
		});

		const shutdown = (): void => {
			process.stdout.write('\nShutting down...\n');
			for (const [, session] of transports) {
				session.transport.close().catch(() => {});
			}
			transports.clear();
			db.close();
			server.close(() => process.exit(0));
		};

		process.on('SIGTERM', shutdown);
		process.on('SIGINT', shutdown);
	}
}

main().catch(error => {
	process.stderr.write(`Fatal error: ${error}\n`);
	process.exit(1);
});
