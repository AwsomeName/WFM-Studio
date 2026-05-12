/*---------------------------------------------------------------------------------------------
 *  WFM Studio CAD review constants.
 *
 *  v0.2: 中央编辑区从「文本预览」升级为「真 CAD viewer」（webview-based）。
 *  ODA / 后端 DWG->DXF 转换链路已下线，相关常量删除。
 *--------------------------------------------------------------------------------------------*/

export const DWG_FILE_EXTENSION = '.dwg';
export const DXF_FILE_EXTENSION = '.dxf';

/**
 * EditorPane / EditorInput 的 type id。VS Code 用它在 EditorResolverService /
 * editor pane registry / editor serializer 之间做匹配。
 */
export const CAD_VIEWER_EDITOR_ID = 'wfm.cad.cadViewerEditor';
export const CAD_VIEWER_EDITOR_LABEL = 'WFM CAD 预览';

/**
 * 限制单次往 webview 灌的字节数（仅作硬保险；正常 .dwg/.dxf 都在百兆以内）。
 * 超过这个值时 CadViewerEditor 拒绝加载并提示用户用桌面 CAD 软件预审。
 */
export const CAD_VIEWER_BYTE_LIMIT = 256 * 1024 * 1024;
