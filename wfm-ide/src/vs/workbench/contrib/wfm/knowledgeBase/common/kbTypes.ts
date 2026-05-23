/*---------------------------------------------------------------------------------------------
 *  WFM Studio – Knowledge Base types (Dify API shapes).
 *--------------------------------------------------------------------------------------------*/

export interface KbDocument {
	id: string;
	name: string;
	word_count: number;
	hit_count: number;
	indexing_status: string;
	created_at: number;
	updated_at: number;
}

export interface KbSegment {
	id: string;
	content: string;
	position: number;
	word_count: number;
	keywords?: string[];
}

export interface KbRetrieveResult {
	segment: KbSegment;
	score: number;
	document?: { id: string; name: string };
}
