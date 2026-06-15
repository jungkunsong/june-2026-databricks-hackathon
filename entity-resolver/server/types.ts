import type { Application } from 'express';

export interface AppKitWithLakebase {
  lakebase: {
    query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  };
  server: {
    extend(fn: (app: Application) => void): void;
  };
}

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
}
