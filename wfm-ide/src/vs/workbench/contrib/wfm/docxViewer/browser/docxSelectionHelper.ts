/*---------------------------------------------------------------------------------------------
 *  WFM Studio DOCX viewer — selection → DocumentReference conversion.
 *--------------------------------------------------------------------------------------------*/

export interface IDocumentReference {
	readonly fileName: string;
	readonly filePath: string;
	readonly startPara: number;
	readonly endPara: number;
	readonly selectedText: string;
	readonly displayLabel: string;
}

export function createDocumentReference(
	fileName: string,
	filePath: string,
	payload: { startPara: number; endPara: number; selectedText: string },
): IDocumentReference {
	const range = payload.startPara === payload.endPara
		? `第${payload.startPara + 1}段`
		: `第${payload.startPara + 1}-${payload.endPara + 1}段`;

	return {
		fileName,
		filePath,
		startPara: payload.startPara,
		endPara: payload.endPara,
		selectedText: payload.selectedText,
		displayLabel: `${fileName} · ${range}`,
	};
}
