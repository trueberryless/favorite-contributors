import { defineCollection } from "astro:content";
import { z } from "astro/zod";
import { glob } from "astro/loaders";

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
  stats: z.record(z.string(), statsSchema),
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

const organisations = defineCollection({
  loader: glob({ pattern: "*.json", base: "./data/organisations" }),
  schema: entitySchema,
});

const repositories = defineCollection({
  loader: glob({ pattern: "**/*.json", base: "./data/repositories" }),
  schema: entitySchema,
});

const contributors = defineCollection({
  loader: glob({ pattern: "*.json", base: "./data/contributors" }),
  schema: contributorSchema,
});

export const collections = {
  organisations,
  repositories,
  contributors,
};
