// 偽の Antigravity CLI（未ログイン）。models などで「Please sign in」を出して落ちる
process.stderr.write('Please sign in\n');
process.exit(1);
