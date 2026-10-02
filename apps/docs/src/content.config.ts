import { defineCollection, z } from 'astro:content';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';

export const collections = {
	docs: defineCollection({
		loader: docsLoader(),
		schema: docsSchema({
			extend: z.object({
				// The small mono line above a page title. Defaults to the page's sidebar group.
				eyebrow: z.string().optional(),
			}),
		}),
	}),
};
