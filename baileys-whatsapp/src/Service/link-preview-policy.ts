export type LinkPreviewEnv = Record<string, string | undefined>

export type TextMessageContent = {
	text: string
	linkPreview?: null
}

export const LINK_PREVIEW_HOSTS_ENV = 'WHATSAPP_LINK_PREVIEW_HOSTS'

// Copy of URL_REGEX in src/Defaults: importing Defaults would load the whole library.
const BAILEYS_URL_REGEX = /https:\/\/(?![^:@\/\s]+:[^:@\/\s]+@)[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(:\d+)?(\/[^\s]*)?/g
const ANY_URL_REGEX = /[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi

/**
 * Hosts whose pages this service may fetch to build a link preview.
 * Empty (the default) means the service never fetches a URL from reply text.
 */
export const getLinkPreviewHosts = (env: LinkPreviewEnv = process.env): Set<string> => {
	const raw = env[LINK_PREVIEW_HOSTS_ENV] || ''
	return new Set(
		raw
			.split(',')
			.map(host => host.trim().toLowerCase())
			.filter(Boolean)
	)
}

const isAllowedUrl = (candidate: string, hosts: Set<string>) => {
	let url: URL
	try {
		url = new URL(candidate)
	} catch {
		return false
	}

	return url.protocol === 'https:' && !url.username && !url.password && hosts.has(url.hostname.toLowerCase())
}

/**
 * Baileys fetches the first URL in a text message (and its preview image) server-side
 * unless the message carries `linkPreview: null`. Allow that only when every URL in the
 * text points at an allowlisted host.
 */
export const allowsLinkPreview = (text: string, env: LinkPreviewEnv = process.env) => {
	const hosts = getLinkPreviewHosts(env)
	if (!hosts.size) {
		return false
	}

	const candidates = [...(text.match(BAILEYS_URL_REGEX) || []), ...(text.match(ANY_URL_REGEX) || [])]
	return candidates.length > 0 && candidates.every(candidate => isAllowedUrl(candidate, hosts))
}

export const socketLinkPreviewConfig = (env: LinkPreviewEnv = process.env) => ({
	generateHighQualityLinkPreview: getLinkPreviewHosts(env).size > 0
})

export const buildTextMessage = (text: string, env: LinkPreviewEnv = process.env): TextMessageContent =>
	allowsLinkPreview(text, env) ? { text } : { text, linkPreview: null }
