export type View = 'home' | 'conv' | 'log';
export type Unit = 'zh' | 'abbr' | 'full';
export type Theme = 'light' | 'dark';

export interface Selection {
  a: string;
  b: string;
}

export interface ConversationFilter {
  dir: string | null;
  agent: string | null;
  model: string | null;
}

export interface LogFilter {
  batch: number | null;
  lvl: string;
  src: string;
  q: string;
}

export const EMPTY_CONV_FILTER: ConversationFilter = {
  dir: null,
  agent: null,
  model: null
};

export const EMPTY_LOG_FILTER: LogFilter = {
  batch: null,
  lvl: 'all',
  src: 'all',
  q: ''
};
