/** The top-level destinations, shared by the header and the mobile sidebar. */
export const primaryNav = [
	{ label: 'Lexicons', href: '/lexicons/overview/' },
	{ label: 'Guides', href: '/self-hosting/quick-start/' },
	{ label: 'Capture Kit', href: '/build-your-own/capture-kit/' },
	{ label: 'Architecture', href: '/introduction/architecture/' },
	{ label: 'API Reference', href: '/api/overview/' },
];

export function isActive(href: string, currentPath: string): boolean {
	return currentPath.startsWith(href.replace(/\/$/, ''));
}
