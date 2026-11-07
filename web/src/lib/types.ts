export type Layer = "national" | "municipal";

export interface Axis {
  id: string;
  name: string;
  negative_pole: string;
  positive_pole: string;
  layer: Layer | "both";
}

export interface Question {
  id: string;
  layer: Layer;
  axis: string | null;
  direction: number;
  text: string;
  note?: string;
  topics?: string[];
  /** 反思題：不計分、不比對 */
  reflection?: boolean;
}

export interface Discussion {
  id: string;
  title: string;
  opening: string;
  guidance: string;
  reflection_questions?: string[];
}

export type BudgetKind = "expense" | "revenue" | "surplus";

export interface BudgetItem {
  id: string;
  kind: BudgetKind;
  name: string;
  detail?: string;
  cost_per_step: number;
  axis: string | null;
  direction: number;
  min_step?: number;
}

export interface BudgetConfig {
  version: string;
  start_balance: number;
  min_final_balance: number;
  steps: number[];
  cities: { id: string; name: string }[];
  items: BudgetItem[];
}

export interface Entity {
  id: string;
  type: "party" | "person";
  name: string;
  short?: string;
  party?: string;
  inclusion_reason?: string;
  links?: Record<string, string>;
}

export interface Evidence {
  grade: "A" | "B" | "C";
  kind: string;
  title?: string;
  url: string;
  date?: string;
  venue?: string | null;
  quote?: string;
  context?: string;
  timestamp?: number | null;
}

export interface Stance {
  question: string;
  value: number;
  interpretation: string;
  grade: "A" | "B" | "C";
  last_reviewed?: string;
  evidence: Evidence[];
}

export interface AppData {
  version: string;
  axes: Axis[];
  questions: Question[];
  supplementary: Question[];
  discussions: Discussion[];
  budget: BudgetConfig;
  entities: Entity[];
  stances: Record<string, Stance[]>;
}

/** -2..2，null 表示「不知道 / 無意見」 */
export interface Answer {
  v: number | null;
  imp: boolean;
}

export type Answers = Record<string, Answer>;
export type BudgetSteps = Record<string, number>;

export type Adjustment =
  | { type: "answer_change"; question: string; from: number | null; to: number; reason: string }
  | { type: "importance_change"; question: string; to: boolean; reason: string }
  | { type: "supplementary_answer"; question: string; to: number | null };
