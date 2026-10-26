// コンピューターの操作（ply_computer）の待ちの区切り。SDK にもネットワークにも依存しない。
//
// agy は MCP の 1 回の呼び出しを 3 分で切り、設定では伸びない。ロックの待ちはこの長さごとに分けて返す。
// 能力の印（core/backends/agent-marks.mjs の computerUse.waitSliceMs）と、橋（core/backends/computer-delivery.mjs）が
// 同じ値を使う（公開文書の生成に computer-delivery.mjs は読めないため、値だけをここに置く）。
export const AGY_WAIT_SLICE_MS = 150_000;
