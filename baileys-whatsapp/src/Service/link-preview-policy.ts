export type LinkPreviewEnv = Record<string, string | undefined>

export type TextMessageContent = {
	text: string
	linkPreview?: null
}

export const socketLinkPreviewConfig = (_env: LinkPreviewEnv = process.env) => ({
	generateHighQualityLinkPreview: true
})

export const buildTextMessage = (text: string, _env: LinkPreviewEnv = process.env): TextMessageContent => ({ text })
