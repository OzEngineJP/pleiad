export function postReadPosition(post) {
  return Math.max(post.at, post.deletedAt ? 0 : post.completedAt ?? 0);
}

export function shownReadPosition(posts) {
  return posts.reduce((at, post) => Math.max(at, postReadPosition(post)), 0);
}
