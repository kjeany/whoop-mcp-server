import { WhoopClient } from './whoop-client.js';
import { WhoopDatabase } from './database.js';

interface SyncStats {
	cycles: number;
	recoveries: number;
	sleeps: number;
	workouts: number;
}

interface SmartSyncResult {
	type: 'full' | 'quick' | 'skip';
	stats?: SyncStats;
}

// SQLite CURRENT_TIMESTAMP is UTC but carries no timezone suffix, so passing it
// straight to new Date() would read it as local time. Normalise before comparing.
function parseSyncTimestamp(value: string): number {
	const iso = value.includes('T') ? value : value.replace(' ', 'T') + 'Z';
	return Date.parse(iso);
}

export class WhoopSync {
	private readonly client: WhoopClient;
	private readonly db: WhoopDatabase;
	private inFlight: Promise<SyncStats> | null = null;
	private inFlightDays = 0;

	constructor(client: WhoopClient, db: WhoopDatabase) {
		this.client = client;
		this.db = db;
	}

	async syncDays(days = 90): Promise<SyncStats> {
		// Whoop rate-limits hard and two overlapping syncs would write the same rows
		// twice. Join a sync already running when it covers at least as many days,
		// otherwise wait for it to finish before starting the wider one.
		while (this.inFlight) {
			if (this.inFlightDays >= days) return this.inFlight;
			await this.inFlight.catch(() => undefined);
		}

		this.inFlightDays = days;
		this.inFlight = this.runSync(days).finally(() => {
			this.inFlight = null;
			this.inFlightDays = 0;
		});
		return this.inFlight;
	}

	private async runSync(days: number): Promise<SyncStats> {
		const endDate = new Date();
		const startDate = new Date();
		startDate.setDate(startDate.getDate() - days);

		const start = startDate.toISOString();
		const end = endDate.toISOString();

		const [cycles, recoveries, sleeps, workouts] = await Promise.all([
			this.client.getAllCycles({ start, end }),
			this.client.getAllRecoveries({ start, end }),
			this.client.getAllSleeps({ start, end }),
			this.client.getAllWorkouts({ start, end }),
		]);

		// Each table is written independently: one bad record set must not
		// discard the other three, and must not skip updateSyncState() below.
		const errors: string[] = [];
		const save = (label: string, write: () => void): void => {
			try {
				write();
			} catch (error) {
				errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
			}
		};

		save('cycles', () => {
			if (cycles.length > 0) this.db.upsertCycles(cycles);
		});
		save('recoveries', () => {
			if (recoveries.length > 0) this.db.upsertRecoveries(recoveries);
		});
		save('sleeps', () => {
			if (sleeps.length > 0) this.db.upsertSleeps(sleeps);
		});
		save('workouts', () => {
			if (workouts.length > 0) this.db.upsertWorkouts(workouts);
		});

		// Always recorded, even after a partial failure, so the next run can do a
		// 7-day quick sync instead of falling back to a 90-day full sync forever.
		this.db.updateSyncState(
			startDate.toISOString().split('T')[0],
			endDate.toISOString().split('T')[0]
		);

		if (errors.length > 0) {
			throw new Error(`Partial sync: ${errors.join(' | ')}`);
		}

		return {
			cycles: cycles.length,
			recoveries: recoveries.length,
			sleeps: sleeps.length,
			workouts: workouts.length,
		};
	}

	async quickSync(): Promise<SyncStats> {
		return this.syncDays(7);
	}

	needsFullSync(): boolean {
		const state = this.db.getSyncState();
		if (!state.lastSyncAt) return true;

		const lastSync = parseSyncTimestamp(state.lastSyncAt);
		if (Number.isNaN(lastSync)) return true;

		const hoursSinceSync = (Date.now() - lastSync) / (1000 * 60 * 60);
		return hoursSinceSync > 24;
	}

	async smartSync(): Promise<SmartSyncResult> {
		const state = this.db.getSyncState();

		if (!state.lastSyncAt) {
			const stats = await this.syncDays(90);
			return { type: 'full', stats };
		}

		const lastSync = parseSyncTimestamp(state.lastSyncAt);
		if (Number.isNaN(lastSync)) {
			const stats = await this.syncDays(90);
			return { type: 'full', stats };
		}

		const hoursSinceSync = (Date.now() - lastSync) / (1000 * 60 * 60);

		if (hoursSinceSync < 1) {
			return { type: 'skip' };
		}

		const stats = await this.quickSync();
		return { type: 'quick', stats };
	}
}
