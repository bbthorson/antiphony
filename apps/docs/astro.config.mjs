// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
	site: 'https://docs.phonicfactory.com',
	integrations: [
		starlight({
			title: 'Vox Pop Core',
			description: 'Open-source infrastructure for audio-based call-and-response applications.',
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/bbthorson/vox-pop-core' },
			],
			sidebar: [
				{
					label: 'Introduction',
					items: [
						{ label: 'What is Vox Pop Core?', slug: 'introduction/overview' },
						{ label: 'Architecture', slug: 'introduction/architecture' },
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
						// Conceptual hub. The embed walkthrough now lives under
						// How-to guides (it's a task-oriented recipe); this page
						// cross-links to it in prose, so it isn't orphaned.
						{ label: 'Build your own app', slug: 'build-your-own/overview' },
					],
				},
				{
					label: 'How-to guides',
					items: [
						// Task-oriented recipes that orchestrate multiple
						// endpoints. The embed walkthrough is a how-to in
						// spirit (it composes the public fetch + render), so
						// it anchors this section as the first recipe.
						{ label: 'Example: the embed app', slug: 'build-your-own/embed-example' },
						// The canonical cookbook: composes the replies
						// primitives (feed/read/status/notes/search) into an
						// inbox — the worked proof that "inbox" is composed
						// UX, not an endpoint.
						{ label: 'Build a reply inbox', slug: 'how-to/reply-inbox' },
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
						// contracts). The contributor-facing counterpart to the
						// connector model — what belongs in core vs a connector.
						{ label: 'API design principles', slug: 'explanation/api-design-principles' },
					],
				},
				{
					label: 'API reference',
					items: [
						{ label: 'Overview', slug: 'api/overview' },
						// Live Scalar-rendered endpoint reference. Standalone
						// Astro page (src/pages/api/reference.astro) outside
						// Starlight content because Scalar needs the full
						// viewport to render its own sidebar/nav.
						{ label: 'Endpoint reference', link: '/api/reference/' },
					],
				},
			],
		}),
	],
});
