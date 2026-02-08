import type { CreateMomentResponse, StatusResponse } from "./types";

export function getApiBase(): string {
  return process.env.NEXT_PUBLIC_API_BASE || "http://127.0.0.1:8001";
}

export function buildProxyAudioUrl(rawUrl: string, apiBase = getApiBase()): string {
  return `${apiBase.replace(/\/+$/, "")}/v1/proxy-audio?url=${encodeURIComponent(rawUrl)}`;
}

export async function createMoment(args: {
  file: Blob;
  filename: string;
  apiBase?: string;
  outputKind?: "song" | "preview";
}): Promise<string> {
  const apiBase = (args.apiBase ?? getApiBase()).replace(/\/+$/, "");
  const outputKind = args.outputKind ?? "song";

  const form = new FormData();
  form.append("file", args.file, args.filename);
  form.append("output_kind", outputKind);

  const response = await fetch(`${apiBase}/v1/create-moment`, {
    method: "POST",
    body: form,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Upload failed (${response.status}): ${body}`.trim());
  }
  const data = (await response.json()) as CreateMomentResponse;
  if (!data?.job_id) {
    throw new Error("Missing job_id from API.");
  }
  return data.job_id;
}

export async function fetchStatus(jobId: string, apiBase?: string): Promise<StatusResponse> {
  const base = (apiBase ?? getApiBase()).replace(/\/+$/, "");
  const response = await fetch(`${base}/v1/status/${jobId}`);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Status failed (${response.status}): ${body}`.trim());
  }
  return (await response.json()) as StatusResponse;
}
