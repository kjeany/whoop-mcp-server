export interface WhoopTokens {
	access_token: string;
	refresh_token: string;
	expires_at: number;
}

export interface WhoopUser {
	user_id: number;
	email: string;
	first_name: string;
	last_name: string;
}

export interface WhoopBodyMeasurement {
	height_meter: number;
	weight_kilogram: number;
	max_heart_rate: number;
}

export interface WhoopCycle {
	id: number;
	user_id: number;
	start: string;
	end: string | null;
	timezone_offset: string;
	score_state: 'SCORED' | 'PENDING_SCORE' | 'UNSCORABLE';
	score?: {
		strain: number;
		kilojoule: number;
		average_heart_rate: number;
		max_heart_rate: number;
	};
}

export interface WhoopRecovery {
	cycle_id: number;
	sleep_id: string;
	user_id: number;
	created_at: string;
	updated_at: string;
	score_state: 'SCORED' | 'PENDING_SCORE' | 'UNSCORABLE';
	score?: {
		user_calibrating: boolean;
		recovery_score: number;
		resting_heart_rate: number;
		hrv_rmssd_milli: number;
		spo2_percentage?: number;
		skin_temp_celsius?: number;
	};
}

export interface WhoopSleep {
	id: string;
	user_id: number;
	created
