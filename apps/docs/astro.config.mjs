// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
	site: 'https://docs.antiphony.dev',
	integrations: [
		starlight({
			title: 'Antiphony',
			description: 'Open infrastructure and an AT Protocol lexicon for audio call-and-response.',
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/bbthorson/antiphony' },
			],
			sidebar: [
				{
					label: 'Introduction',
					items: [
						{ label: 'What is Antiphony?', slug: 'introduction/overview' },
						{ label: 'Architecture', slug: 'introduction/architecture' },
					],
				},
				{
					label: 'Lexicons',
					items: [
						// The crown jewel: the dev.antiphony.* AT Protocol lexicons.
						// The canonical contract an adopter builds against — every
						// REST shape is derived from these.
						{ label: 'The Antiphony lexicons', slug: 'lexicons/overview' },
					],
				},
				{
					label: 'Self-hosting',
					items: [
						{ label: 'Quick start', slug: 'self-hosting/quick-start' },
						{ label: 'Configuration', slug: 'self-hosting/configuration' },
					],
				},
				{
					label: 'Build your own',
					items: [
						{ label: 'Build your own app', slug: 'build-your-own/overview' },
						// The neutral reference app (apps/reference) is the worked
						// example: record → upload → create post → hydrate → render.
						{ label: 'Example: the reference app', slug: 'build-your-own/reference-app' },
					],
				},
				{
					label: 'Explanation',
					items: [
						// The mental model: the core as a hub, every surface
						// around it as a directional connector, the three API
						// planes. Distinct from introduction/architecture
						// (which is the internal ports-and-adapters wiring).
						{ label: 'Architecture & connectors', slug: 'explanation/connectors' },
						// The design rules the consumer API obeys (primitives not
						// compositions, queries, projections, descriptions as
						// contracts).
						{ label: 'API design principles', slug: 'explanation/api-design-principles' },
					],
				},
				{
					label: 'API reference',
					items: [
						{ label: 'Overview', slug: 'api/overview' },
						// Generated Scalar-rendered endpoint list — a secondary aid.
						// The lexicons are the primary, hand-written contract.
						{ label: 'Endpoint reference', link: '/api/reference/' },
					],
				},
			],
		}),
	],
});
