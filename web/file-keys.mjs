// ツールの入力のうち、ファイルのパスを入れるキー（エージェントごとに名前が違う）。先にあるものを優先する。
// カードの描き分け（render.mjs）・会話が触ったファイルの集計（core/session-files.mjs）・承認の要約（approval-summary.mjs）が共有する。
// Antigravity: view_file は AbsolutePath、write_to_file / replace_file_content は TargetFile、
// 新しい read_file / write_file / edit_file は大文字始まりの Path（実際の会話の記録で確認）
export const FILE_KEYS = ['file_path', 'notebook_path', 'path', 'Path', 'AbsolutePath', 'TargetFile'];
