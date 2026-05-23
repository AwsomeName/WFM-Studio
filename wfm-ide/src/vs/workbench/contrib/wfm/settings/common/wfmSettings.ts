/*---------------------------------------------------------------------------------------------
 *  WFM Studio Settings — constants and type definitions.
 *--------------------------------------------------------------------------------------------*/

export const WFM_SETTINGS_EDITOR_ID = 'wfm.settings.editor';
export const WFM_SETTINGS_EDITOR_INPUT_ID = 'wfm.settings.editorInput';

/** A single model provider configuration. */
export interface IWfmProviderConfig {
	id: string;
	name: string;
	type: 'openai' | 'anthropic' | 'custom';
	apiKey: string;
	baseUrl: string;
	defaultModel: string;
	apiMode: 'chat' | 'responses';
	enabled: boolean;
}

/** Global settings stored in ~/.wfm-studio/settings.json. */
export interface IWfmGlobalSettings {
	providers: IWfmProviderConfig[];
	defaultProviderId: string;
}

/** Client-side usage tracking record. */
export interface IWfmUsageStats {
	totalRequests: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	sessions: IWfmUsageSession[];
}

export interface IWfmUsageSession {
	date: string;
	provider: string;
	model: string;
	requestCount: number;
	inputTokens: number;
	outputTokens: number;
}

/** Provider preset templates for quick setup. */
export interface IWfmProviderPreset {
	name: string;
	type: IWfmProviderConfig['type'];
	baseUrl: string;
	defaultModel: string;
}

export const WFM_PROVIDER_PRESETS: IWfmProviderPreset[] = [
	{ name: '智谱 / DashScope', type: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultModel: 'glm-5.1' },
	{ name: '智谱 / BigModel', type: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', defaultModel: 'glm-5.1' },
	{ name: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4.1' },
	{ name: 'Anthropic', type: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', defaultModel: 'claude-sonnet-4-20250514' },
	{ name: '自定义', type: 'custom', baseUrl: '', defaultModel: '' },
];
