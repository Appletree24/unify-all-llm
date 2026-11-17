/** Where a scan looks. Everything is injected so tests never touch the real home directory. */
export interface MemoryContext {
  cwd: string;
  home: string;
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
}

export type Scope = 'managed' | 'user' | 'project' | 'local' | 'nested' | 'auto' | 'agent';
/** startup: in context from the first turn. on-demand: read only when the harness decides to. */
export type LoadTiming = 'startup' | 'on-demand';
export type Writer = 'human' | 'agent' | 'admin';

export interface Commit {
  hash: string;
  author: string;
  time: number;
  summary: string;
}

/** How one remembered item came to exist, as far as the files can tell. */
export interface Origin {
  kind: 'git' | 'uncommitted' | 'untracked';
  commit?: Commit;
  /** A harness-specific writer, e.g. Gemini's save_memory tool. */
  via?: string;
}

export interface Entry {
  /** 1-based inclusive line range in the file. */
  start: number;
  end: number;
  kind: 'bullet' | 'text' | 'code';
  heading: string[];
  text: string;
  origin?: Origin;
}

export interface Issue {
  level: 'error' | 'warn' | 'info';
  code: 'broken-import' | 'import-depth' | 'oversize' | 'truncated' | 'empty' | 'duplicate' | 'shadowed' | 'unreadable';
  message: string;
  path?: string;
  line?: number;
}

export interface MemoryFile {
  path: string;
  /** Shortened for display: ~/… or relative to the working directory. */
  display: string;
  exists: boolean;
  writable: boolean;
  load: LoadTiming;
  /** Present but not read, because a sibling takes precedence. */
  shadowedBy?: string;
  /** Pulled in by an @import in this file rather than discovered by location. */
  importedBy?: string;
  /** Path globs from rule frontmatter: the rule applies only to matching files. */
  appliesTo?: string[];
  meta?: Record<string, string>;
  bytes: number;
  lines: number;
  tokens: number;
  mtime?: number;
  hash?: string;
  content?: string;
  entries: Entry[];
  imports: { target: string; line: number; exists: boolean }[];
  tracked?: boolean;
  history?: Commit[];
  /** Other harnesses that read this very file. */
  sharedWith?: string[];
}

export interface Layer {
  id: string;
  title: string;
  scope: Scope;
  load: LoadTiming;
  writer: Writer;
  /** What this layer is for, how it is loaded and who writes it. */
  note: string;
  readonly?: boolean;
  /** Directories in which new files may be created. */
  dirs: string[];
  files: MemoryFile[];
}

export interface Harness {
  id: string;
  name: string;
  /** Whether the harness has left any trace on this machine or project. */
  detected: boolean;
  /** How the layers combine. */
  summary: string;
  /** Layers in load order: later layers are read later and win conflicts. */
  layers: Layer[];
  effective: { bytes: number; tokens: number; files: number; limitBytes?: number };
  issues: Issue[];
}

export interface MemoryState {
  cwd: string;
  home: string;
  root: string;
  harnesses: Harness[];
}
