import { z } from "astro/zod";

export const statsSchema = z.object({
  score: z.number(),
  mergedPrs: z.number(),
  reviews: z.number(),
  reviewsReceived: z.number(),
  issuesLinked: z.number(),
  reactions: z.number(),
});

export const entitySchema = z.object({
  id: z.string(),
  updatedAt: z.string().nullable(),
  stats: z.record(z.string(), statsSchema).default({}),
});

export const contributorSchema = z.object({
  username: z.string(),
  lastUpdated: z.string(),
  aggregatedStats: statsSchema,
  orgStats: z.record(z.string(), statsSchema),
  repoStats: z.record(z.string(), z.record(z.string(), statsSchema)),
});

export type Stats = z.infer<typeof statsSchema>;
export type Entity = z.infer<typeof entitySchema>;
export type Organisation = Entity;
export type Repository = Entity;
export type Contributor = z.infer<typeof contributorSchema>;
