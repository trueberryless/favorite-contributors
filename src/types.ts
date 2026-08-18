export interface Stats {
  score: number;
  mergedPrs: number;
  reviews: number;
  reviewsReceived: number;
  issuesLinked: number;
  reactions: number;
}

export interface Entity {
  id: string;
  updatedAt: string | null;
  stats: Record<string, Stats>;
}

export type Organisation = Entity;
export type Repository = Entity;

export interface Contributor {
  username: string;
  lastUpdated: string;
  aggregatedStats: Stats;
  orgStats: Record<string, Stats>;
  repoStats: Record<string, Record<string, Stats>>;
}
