import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { contributorSchema, entitySchema } from "./schema";

const filteredGlob = (options: Parameters<typeof glob>[0]) => {
  const loader = glob(options);
  return {
    ...loader,
    async load(context: any) {
      const originalSet = context.store.set;
      context.store.set = (entry: any) => {
        if (entry.data && entry.data.updatedAt === null) return;
        return originalSet(entry);
      };
      await loader.load(context);
    },
  };
};

const organisations = defineCollection({
  loader: filteredGlob({ pattern: "*.json", base: "./data/organisations" }),
  schema: entitySchema,
});

const repositories = defineCollection({
  loader: filteredGlob({ pattern: "**/*.json", base: "./data/repositories" }),
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
