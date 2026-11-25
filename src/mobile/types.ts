import type { RunRecord } from '../core/store.js';

export interface MobileNetwork {
  name: string;
  address: string;
}

export interface MobileShareInfo {
  cwd: string;
  sessionId: string;
  title: string;
  url: string;
}

export interface MobileAnswer {
  id: string;
  label: string;
  text: string;
  status: RunRecord['results'][number]['status'];
  error?: string;
}

export interface MobileTurn {
  id: string;
  question: string;
  status: RunRecord['status'];
  busy: boolean;
  canCancel: boolean;
  waitingForInput: boolean;
  error?: string;
  answers: MobileAnswer[];
}

export interface MobileUpdate {
  revision: number;
  full: boolean;
  project: string;
  title: string;
  turns: MobileTurn[];
}
