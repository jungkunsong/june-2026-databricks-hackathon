// Types mirrored from server/types.ts (client cannot import server code)
export interface ResolutionTask {
  id: number;
  raw_row_id: number;
  facility_name: string | null;
  status: 'pending' | 'in_progress' | 'resolved' | 'skipped';
  assigned_at: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DecisionLogEntry {
  id: number;
  task_id: number | null;
  resolved_id: number | null;
  raw_row_id: number | null;
  cluster_id: string | null;
  facility_name: string | null;
  outcome: 'verified' | 'corrected' | 'partial' | 'deferred';
  confidence: number | null;
  reasoning: string;
  agents_consulted: string[] | null;
  verifications: Array<{
    field: string;
    status: 'verified' | 'corrected' | 'unverifiable' | 'skipped';
    old_value?: string | null;
    new_value?: string | null;
    agent?: string;
    supervisor_reasoning?: string;
  }> | null;
  human_notes: string | null;
  agent_scores?: Array<{ agent: string; score: number; rationale: string }> | null;
  decided_at: string;
}

export interface Message {
  id: number;
  task_id: number;
  role: 'user' | 'supervisor' | 'sub_agent';
  agent_name: string | null;
  content: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface FacilityRecord {
  row_id: number;
  unique_id: string;
  name: string;
  organization_type: string | null;
  facilityTypeId: string | null;
  specialties: string | null;
  procedure: string | null;
  equipment: string | null;
  capability: string | null;
  address_line1: string | null;
  address_city: string | null;
  address_stateOrRegion: string | null;
  address_country: string | null;
  address_zipOrPostcode: string | null;
  latitude: number | null;
  longitude: number | null;
  source_types: string | null;
  source_urls: string | null;
  cluster_id: string | null;
  phone_numbers: string | null;
  email: string | null;
  websites: string | null;
  numberDoctors: string | null;
  capacity: string | null;
  description: string | null;
  yearEstablished: string | null;
  acceptsVolunteers: string | null;
}

export interface ClusterSummary {
  cluster_id: string;
  record_count: number;
  representative_name: string;
  city: string | null;
  state: string | null;
  country: string | null;
  facility_type: string | null;
  sources: string[];
  latitude: number | null;
  longitude: number | null;
}

export interface TaskWithThread {
  task: ResolutionTask & { decision_count: number; message_count: number };
  messages: Message[];
  latest_decision: DecisionLogEntry | null;
}

async function req<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error: string }).error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

// ── Clusters (read from SQL warehouse) ────────────────────────────────────────

export const clustersApi = {
  list: (params?: { limit?: number; offset?: number; search?: string }) => {
    const qs = new URLSearchParams();
    if (params?.limit) qs.set('limit', String(params.limit));
    if (params?.offset) qs.set('offset', String(params.offset));
    if (params?.search) qs.set('search', params.search);
    return req<ClusterSummary[]>(`/api/facilities/clusters?${qs}`);
  },
  count: () => req<{ total: number }>('/api/facilities/clusters/count'),
  records: (clusterId: string) =>
    req<FacilityRecord[]>(`/api/facilities/cluster/${encodeURIComponent(clusterId)}`),
};

// ── Tasks (read/write from Lakebase) ──────────────────────────────────────────

export const tasksApi = {
  list: (status?: string) =>
    req<(ResolutionTask & { decision_count: number; message_count: number })[]>(
      `/api/tasks${status ? `?status=${status}` : ''}`,
    ),
  get: (id: number) => req<TaskWithThread>(`/api/tasks/${id}`),
  create: (cluster_id: string) =>
    req<ResolutionTask>('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ cluster_id }),
    }),
  updateStatus: (id: number, status: string) =>
    req<ResolutionTask>(`/api/tasks/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),
};

// ── Messages ──────────────────────────────────────────────────────────────────

export const messagesApi = {
  create: (
    taskId: number,
    msg: { role: string; agent_name?: string; content: string; metadata?: Record<string, unknown> },
  ) =>
    req<Message>(`/api/tasks/${taskId}/messages`, {
      method: 'POST',
      body: JSON.stringify(msg),
    }),
};

// ── Decision log ──────────────────────────────────────────────────────────────

export const decisionLogApi = {
  list: () => req<DecisionLogEntry[]>('/api/decision-log'),
};

// ── Promote ───────────────────────────────────────────────────────────────────

export interface PromotePayload {
  task_id: number;
  raw_row_id: number;
  facility_name?: string | null;
  outcome: 'verified' | 'corrected' | 'partial' | 'deferred';
  confidence?: number | null;
  reasoning: string;
  agents_consulted?: string[] | null;
  verifications?: unknown[] | null;
  human_notes?: string | null;
  agent_scores?: Array<{ agent: string; score: number; rationale: string }> | null;
  resolved_fields?: Record<string, unknown>;
}

export interface PromoteResult {
  resolved_id: number;
  task_id: number;
  outcome: string;
}

export const promoteApi = {
  promote: (payload: PromotePayload) =>
    req<PromoteResult>('/api/promote', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
};
