// Types mirrored from server/types.ts (client cannot import server code)
export interface ResolutionTask {
  id: number;
  cluster_id: string;
  status: 'pending' | 'in_progress' | 'resolved' | 'skipped';
  assigned_at: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Decision {
  id: number;
  task_id: number;
  cluster_id: string;
  outcome: 'merged' | 'split' | 'confirmed_duplicate' | 'confirmed_distinct' | 'deferred';
  golden_record: Record<string, unknown> | null;
  confidence: number | null;
  reasoning: string | null;
  decided_by: string;
  created_at: string;
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
  latest_decision: Decision | null;
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

// ── Decisions ─────────────────────────────────────────────────────────────────

export const decisionsApi = {
  list: () => req<(Decision & { cluster_id: string })[]>('/api/decisions'),
  create: (
    taskId: number,
    decision: {
      cluster_id: string;
      outcome: string;
      golden_record?: Record<string, unknown>;
      confidence?: number;
      reasoning?: string;
      decided_by?: string;
    },
  ) =>
    req<Decision>(`/api/tasks/${taskId}/decisions`, {
      method: 'POST',
      body: JSON.stringify(decision),
    }),
};
