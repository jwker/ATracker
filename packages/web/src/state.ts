export type View = 'home' | 'today' | 'conv' | 'log';
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
  /** 模型所属厂商。和 model 一起用，同名模型在不同厂商下不会混。 */
  vendor: string | null;
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
  model: null,
  vendor: null
};

export const EMPTY_LOG_FILTER: LogFilter = {
  batch: null,
  lvl: 'all',
  src: 'all',
  q: ''
};
