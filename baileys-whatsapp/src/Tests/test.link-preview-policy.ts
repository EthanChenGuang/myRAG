import {
	buildTextMessage,
	linkPreviewHostList,
	parseLinkPreviewField,
	socketLinkPreviewConfig
} from '../Service/link-preview-policy'

const INJECTED = 'Answer: see https://attacker.example/c?d=+10000000000'

describe('link preview policy', () => {
	describe('by default', () => {
		const env = {}

		it('does not request a high-quality link preview from the socket', () => {
			expect(socketLinkPreviewConfig(env).generateHighQualityLinkPreview).toBe(false)
		})

		it('marks a text send with a URL so Baileys fetches no preview', () => {
			const content = buildTextMessage(INJECTED, env)
			expect(content.text).toBe(INJECTED)
			expect(content).toHaveProperty('linkPreview', null)
		})

		it('marks a text send without a URL the same way', () => {
			expect(buildTextMessage('plain answer', env)).toHaveProperty('linkPreview', null)
		})
	})

	describe('with WHATSAPP_LINK_PREVIEW_HOSTS', () => {
		const env = { WHATSAPP_LINK_PREVIEW_HOSTS: 'docs.example.com, Shop.Example.org' }

		it('lets Baileys build a preview for an allowlisted host', () => {
			const content = buildTextMessage('Read https://docs.example.com/guide?x=1', env)
			expect(content).not.toHaveProperty('linkPreview')
		})

		it('matches hosts case-insensitively', () => {
			expect(buildTextMessage('See https://shop.example.org/', env)).not.toHaveProperty('linkPreview')
		})

		it('keeps previews off for a host that is not on the list', () => {
			expect(buildTextMessage(INJECTED, env)).toHaveProperty('linkPreview', null)
		})

		it('does not treat a subdomain or lookalike as allowlisted', () => {
			expect(buildTextMessage('https://evil.docs.example.com/a', env)).toHaveProperty('linkPreview', null)
			expect(buildTextMessage('https://docs.example.com.attacker.example/a', env)).toHaveProperty('linkPreview', null)
			expect(buildTextMessage('https://user@attacker.example/docs.example.com', env)).toHaveProperty(
				'linkPreview',
				null
			)
		})

		it('keeps previews off when any URL in the text is not allowlisted', () => {
			const text = 'https://docs.example.com/a and https://attacker.example/b'
			expect(buildTextMessage(text, env)).toHaveProperty('linkPreview', null)
		})

		it('keeps previews off for a non-http URL', () => {
			expect(buildTextMessage('ftp://docs.example.com/a', env)).toHaveProperty('linkPreview', null)
		})

		it('requests a high-quality preview only when hosts are allowlisted', () => {
			expect(socketLinkPreviewConfig(env).generateHighQualityLinkPreview).toBe(true)
			expect(socketLinkPreviewConfig({ WHATSAPP_LINK_PREVIEW_HOSTS: ' , ' }).generateHighQualityLinkPreview).toBe(false)
		})
	})

	describe('per-message linkPreview false', () => {
		const env = { WHATSAPP_LINK_PREVIEW_HOSTS: 'docs.example.com' }

		it('forces linkPreview null even when every URL is on the preview hosts', () => {
			const content = buildTextMessage('Read https://docs.example.com/guide', env, { linkPreview: false })
			expect(content).toEqual({ text: 'Read https://docs.example.com/guide', linkPreview: null })
		})

		it('keeps the existing policy without the option', () => {
			expect(buildTextMessage('Read https://docs.example.com/guide', env, {})).not.toHaveProperty('linkPreview')
			expect(buildTextMessage('Read https://docs.example.com/guide', env)).not.toHaveProperty('linkPreview')
		})

		it('builds a reply with a non-allowlisted URL with linkPreview null', () => {
			expect(buildTextMessage(INJECTED, {}, { linkPreview: false })).toEqual({ text: INJECTED, linkPreview: null })
		})
	})

	describe('send endpoint linkPreview field', () => {
		it('accepts an absent field or a boolean', () => {
			expect(parseLinkPreviewField(undefined)).toEqual({ ok: true, options: {} })
			expect(parseLinkPreviewField(false)).toEqual({ ok: true, options: { linkPreview: false } })
			expect(parseLinkPreviewField(true)).toEqual({ ok: true, options: {} })
		})

		it('rejects a non-boolean value', () => {
			for (const value of ['false', 0, null, {}, []]) {
				expect(parseLinkPreviewField(value)).toEqual({ ok: false })
			}
		})
	})

	describe('health preview hosts', () => {
		it('is empty by default', () => {
			expect(linkPreviewHostList({})).toEqual([])
		})

		it('lists the configured host names only, sorted', () => {
			expect(linkPreviewHostList({ WHATSAPP_LINK_PREVIEW_HOSTS: 'shop.example.org, Docs.Example.com' })).toEqual([
				'docs.example.com',
				'shop.example.org'
			])
		})
	})
})
