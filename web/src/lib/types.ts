export type JobStatus = "PENDING" | "ANALYZING" | "RENDERING" | "MIXING" | "COMPLETED";

export type Blueprint = {
  id?: string;
  style?: string;
  tempo_bpm?: number;
  key?: string;
  time_signature?: string;
  lyrics?: string;
  voice?: Record<string, unknown>;
  sections?: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
};

export type StatusResponse = {
  id: string;
  status: JobStatus;
  original_audio_url: string;
  blueprint_json?: Blueprint | null;
  final_audio_url?: string | null;
};

export type CreateMomentResponse = {
  job_id: string;
};
