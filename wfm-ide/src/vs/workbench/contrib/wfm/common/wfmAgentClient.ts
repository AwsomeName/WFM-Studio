/*---------------------------------------------------------------------------------------------
 *  WFM Studio contributions.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const IWfmAgentClientService = createDecorator<IWfmAgentClientService>('wfmAgentClientService');

export interface IWfmAgentChatReply {
	readonly role: 'assistant';
	readonly content: string;
	readonly workspaceRoot: string;
	readonly receivedAt: string;
}

export interface IWfmAgentClientService {
	readonly _serviceBrand: undefined;

	/**
	 * Base URL of the local agent backend. Defaults to http://127.0.0.1:8765.
	 * Intentionally configurable for future tests / alt ports.
	 */
	readonly baseUrl: string;

	/**
	 * Send a chat message. The current workspace root (first folder of the
	 * active workspace) is auto-injected; callers never pass it explicitly.
	 *
	 * Rejects if there is no open workspace folder or the backend is
	 * unreachable / returns a non-2xx status.
	 */
	chat(message: string, token?: CancellationToken): Promise<IWfmAgentChatReply>;

	/**
	 * Minimal liveness check; returns true iff the backend responds 200 on
	 * /v1/health within a short timeout. Does not throw.
	 */
	ping(token?: CancellationToken): Promise<boolean>;
}
