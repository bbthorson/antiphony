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
			components: {
				Header: './src/components/Header.astro',
				Sidebar: './src/components/Sidebar.astro',
				PageTitle: './src/components/PageTitle.astro',
			},
			// Brand: self-hosted fonts (Sora/Inter/JetBrains Mono) + the
			// "Two Voices" duotone theme. Order matters — fonts before brand.css
			// so the @font-face families exist when the theme references them.
			customCss: [
				'@fontsource-variable/inter',
				'@fontsource-variable/sora',
				'@fontsource-variable/jetbrains-mono',
				'./src/styles/brand.css',
			],
			sidebar: [
				{
					label: 'Protocol (Lexicons)',
					items: [
						// The crown jewel: the dev.antiphony.* AT Protocol lexicons.
						// The canonical contract an adopter builds against — every
						// REST shape is derived from these.
						{ label: 'The Antiphony lexicons', slug: 'lexicons/overview' },
					],
				},
				{
					label: 'Getting Started',
					items: [
						{ label: 'What is Antiphony?', slug: 'introduction/overview' },
						{ label: 'Quick start', slug: 'self-hosting/quick-start' },
					],
				},
				{
					label: 'Build your own',
					items: [
						{ label: 'Overview', slug: 'build-your-own/overview' },
						// @antiphony/capture-kit — the headless browser audio
						// primitives (recorder, player, waveform) split out of the
						// reference app once Vox Pop became a second consumer.
						{ label: 'The capture kit', slug: 'build-your-own/capture-kit' },
						// The neutral reference app (apps/reference) is the worked
						// example: record → upload → create post → hydrate → render.
						{ label: 'Example: the reference app', slug: 'build-your-own/reference-app' },
					],
				},
				{
					label: 'Architecture & Design',
					items: [
						{ label: 'Internal architecture', slug: 'introduction/architecture' },
						// The mental model: the core as a hub, every surface
						// around it as a directional connector, the three API planes.
						{ label: 'Connectors & hub model', slug: 'explanation/connectors' },
						// The design rules the consumer API obeys (primitives not
						// compositions, queries, projections, descriptions as contracts).
						{ label: 'API design principles', slug: 'explanation/api-design-principles' },
					],
				},
				{
					label: 'Self-hosting & Ops',
					items: [
						{ label: 'Configuration', slug: 'self-hosting/configuration' },
					],
				},
				{
					label: 'API reference',
					items: [
						{ label: 'Overview', slug: 'api/overview' },
						// Generated Scalar-rendered endpoint list — a secondary aid.
						{ label: 'Endpoint reference', link: '/api/reference/' },
					],
				},
				{
					label: 'Design System',
					items: [
						{ label: 'Tokens & Two Voices', slug: 'design-system/tokens' },
					],
				},
			],
		}),
	],
});
