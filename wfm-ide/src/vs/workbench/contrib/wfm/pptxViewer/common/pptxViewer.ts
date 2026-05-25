/*---------------------------------------------------------------------------------------------
 *  WFM Studio PPTX viewer constants.
 *--------------------------------------------------------------------------------------------*/

export const PPTX_FILE_EXTENSION = '.pptx';

export const PPTX_VIEWER_EDITOR_ID = 'wfm.pptx.pptxViewerEditor';
export const PPTX_VIEWER_EDITOR_LABEL = 'WFM PPT 预览';

// PPT 通常比 docx 大，按经验放宽到 80 MB；超过这个尺寸 webview 解析会非常卡。
export const PPTX_VIEWER_BYTE_LIMIT = 80 * 1024 * 1024;
