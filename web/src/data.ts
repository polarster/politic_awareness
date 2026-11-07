import raw from "./generated/data.json";
import type { AppData, Question } from "./lib/types";

export const data = raw as unknown as AppData;

export const questionById = new Map<string, Question>(
  [...data.questions, ...data.supplementary].map((q) => [q.id, q]),
);
export const budgetItemById = new Map(data.budget.items.map((b) => [b.id, b]));
export const axisById = new Map(data.axes.map((a) => [a.id, a]));
export const entityById = new Map(data.entities.map((e) => [e.id, e]));

export const nationalQuestions = data.questions.filter((q) => q.layer === "national");
export const municipalQuestions = data.questions.filter((q) => q.layer === "municipal");

export function itemLabel(id: string): string {
  return questionById.get(id)?.text ?? budgetItemById.get(id)?.name ?? id;
}
