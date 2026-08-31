import type { QueryAnswer, QueryFilters } from "../../types";

const STORAGE_KEY = "cg.ask.history";
const MAX_ITEMS = 25;

export interface AskHistoryEntry {
  id: string;
  question: string;
  filters?: QueryFilters;
  answer: QueryAnswer;
  at: number;
}

function load(): AskHistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as AskHistoryEntry[];
    return Array.isArray(parsed) ? parsed.slice(0, MAX_ITEMS) : [];
  } catch {
    return [];
  }
}

function persist(items: AskHistoryEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    /* private mode / storage disabled */
  }
}

/** Client-only history of answered questions, newest first, capped and mirrored to localStorage. */
class AskHistory {
  items = $state<AskHistoryEntry[]>(load());

  add(question: string, filters: QueryFilters | undefined, answer: QueryAnswer): AskHistoryEntry {
    const entry: AskHistoryEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      question,
      filters: filters && Object.keys(filters).length > 0 ? filters : undefined,
      answer,
      at: Date.now(),
    };
    this.items = [entry, ...this.items].slice(0, MAX_ITEMS);
    persist(this.items);
    return entry;
  }

  remove(id: string): void {
    this.items = this.items.filter((e) => e.id !== id);
    persist(this.items);
  }

  clear(): void {
    this.items = [];
    persist(this.items);
  }
}

export const askHistory = new AskHistory();
