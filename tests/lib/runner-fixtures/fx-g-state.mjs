// fx-g-dirty と fx-g-probe の間で、同じプロセスの中だけ共有する控え（suite ではない。登録しない）。
// dirty が「suite の前にあった document・location」を入れ、probe が、globalThis.document が替えられた後でも元の物の中身を見るのに使う。
export const state = { document: null, location: null };
