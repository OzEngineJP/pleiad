// 通知の一覧の画面（web/notification-inbox.mjs）の、DOM を持たない部分: 通知 1 件の文（種類・名前・題・場所・決着）とベルの印・名前。
// 描画・キー・飛ぶ・強調は tests/browser/notification-inbox.cjs。辞書は日本語と英語の両方で、組み立てたキーがどれも訳されていることを見る。
import { t, setLanguage } from '../../web/i18n.mjs';
import { describeNotification, badgeState, notificationTarget } from '../../web/notification-inbox.mjs';

export const name = 'notification-inbox-ui';
export const title = '通知の一覧の画面: 通知の文（あなた待ち・失敗・完了・@あなた）・場所・決着・ベルの印と名前（日本語・英語）';

export default async function (tt) {
  const before = (await import('../../web/i18n.mjs')).lang;
  try {
    await setLanguage('ja');
    const wait = { id: 'n1', kind: 'wait', ask: 'approval', actor: { kind: 'bot', name: 'Owl' }, at: 1, unread: true, target: { sessionId: 's1' }, title: '依存の更新' };
    let d = describeNotification(wait, t);
    tt.ok('あなた待ち（bot）: 「Owl が承認を待っています」・◆・場所は 一時チャット › 会話の題', d.line === 'Owl が承認を待っています' && d.icon === 'wait' && d.place === '一時チャット › 依存の更新' && d.open === true && d.outcome === '');
    d = describeNotification({ ...wait, actor: undefined }, t);
    tt.ok('あなた待ち（bot でない）は「エージェントが承認を待っています」', d.line === 'エージェントが承認を待っています');
    d = describeNotification({ ...wait, ask: 'question' }, t);
    tt.ok('質問は「…が質問への答えを待っています」', d.line === 'Owl が質問への答えを待っています');
    d = describeNotification({ ...wait, ask: 'chrome' }, t);
    tt.ok('Chrome の操作待ちは「…が Chrome の操作を待っています」（承認と言わない）', d.line === 'Owl が Chrome の操作を待っています' && d.open === true);
    d = describeNotification({ ...wait, ask: 'chrome', resolvedAt: 5, outcome: 'allowed', unread: false }, t);
    tt.ok('済んだ Chrome の操作待ちは過去形で、「承認済み」を付けない', d.line === 'Owl が Chrome の操作を待っていました' && d.icon === 'closed' && d.outcome === '', JSON.stringify(d));
    d = describeNotification({ ...wait, ask: 'command', actor: undefined }, t);
    tt.ok('戻らないコマンド（ADR 0227）は「コマンドが戻らず、会話が止まっているかもしれません」', d.line === 'コマンドが戻らず、会話が止まっているかもしれません' && d.open === true, JSON.stringify(d));
    d = describeNotification({ ...wait, ask: 'command', resolvedAt: 5, outcome: 'cancelled', unread: false }, t);
    tt.ok('済んだ戻らないコマンドは過去形で、決着の言葉を付けない', d.line === 'Owl のコマンドが戻らず、会話が止まっていました' && d.outcome === '', JSON.stringify(d));
    d = describeNotification({ ...wait, resolvedAt: 5, outcome: 'allowed', unread: false }, t);
    tt.ok('決着したあなた待ちは過去形・◇・「承認済み」（弱く出す）', d.line === 'Owl が承認を待っていました' && d.icon === 'closed' && d.outcome === '承認済み' && d.open === false);
    tt.ok('決着の言葉: 回答済み・却下・取り消し', ['answered', 'denied', 'cancelled'].map((o) => describeNotification({ ...wait, resolvedAt: 5, outcome: o }, t).outcome).join() === '回答済み,却下,取り消し');
    d = describeNotification({ id: 'n2', kind: 'failed', actor: { kind: 'bot', name: 'Kit' }, at: 1, unread: true, target: { channelId: 'c1', threadId: 't1' }, channelName: 'design', threadTitle: 'ヘッダーの余白を揃える' }, t);
    tt.ok('bot の失敗は「Kit のターンが失敗しました」・✕・場所は #チャンネル › スレッドの題', d.line === 'Kit のターンが失敗しました' && d.icon === 'failed' && d.place === '#design › ヘッダーの余白を揃える');
    d = describeNotification({ id: 'n3', kind: 'done', at: 1, unread: false, target: { sessionId: 's2' }, title: '控えの題' }, t, (id) => (id === 's2' ? 'いまの題' : ''));
    tt.ok('完了は「<会話の題> が完了しました」。題は今の会話の題を先に使い（改名に追従）、無ければ控えの題', d.line === 'いまの題 が完了しました' && d.icon === 'done' && d.place === '一時チャット › いまの題'
      && describeNotification({ id: 'n3', kind: 'done', at: 1, unread: false, target: { sessionId: 's2' }, title: '控えの題' }, t).line === '控えの題 が完了しました');
    d = describeNotification({ id: 'n4', kind: 'done', at: 1, unread: false, target: { sessionId: 's2' } }, t);
    tt.ok('題が無い会話は「会話が完了しました」・場所は無題の名前', d.line === '会話が完了しました' && d.place === '一時チャット › 新しいセッション');
    d = describeNotification({ id: 'n5', kind: 'mention', actor: { kind: 'bot', name: 'Lynx' }, at: 1, unread: true, target: { channelId: 'c1', threadId: 't1', postId: 'p1' }, channelName: 'release-ci' }, t);
    tt.ok('@あなた は「Lynx が @あなた と書きました」・@・スレッドの題が無ければ #チャンネルだけ', d.line === 'Lynx が @あなた と書きました' && d.icon === 'mention' && d.place === '#release-ci');
    tt.ok('書いた人の名前が無い @あなた は「@あなた 宛ての投稿があります」', describeNotification({ id: 'n6', kind: 'mention', at: 1, unread: true, target: { channelId: 'c1' } }, t).line === '@あなた 宛ての投稿があります');
    d = describeNotification({ id: 'n7', kind: 'wait', ask: 'syncInbox', count: 3, at: 1, unread: true, target: { settings: 'plus' } }, t);
    tt.ok('同期で届いた変更は「同期で届いた変更が 3 件あります」・◆・場所は 設定 › Pleiad Plus', d.line === '同期で届いた変更が 3 件あります' && d.icon === 'wait' && d.place === '設定 › Pleiad Plus' && d.open === true, JSON.stringify(d));

    d = describeNotification({ id: 'n8', kind: 'wait', ask: 'syncApproval', count: 1, title: 'lap', at: 1, unread: true, target: { settings: 'plus' } }, t);
    tt.ok('新しい PC 1 台が鍵を待つ: 「lap が同期の鍵を待っています」・◆・場所は 設定 › Pleiad Plus', d.line === 'lap が同期の鍵を待っています' && d.icon === 'wait' && d.place === '設定 › Pleiad Plus' && d.open === true, JSON.stringify(d));
    d = describeNotification({ id: 'n9', kind: 'wait', ask: 'syncApproval', count: 2, title: 'lap', at: 1, unread: true, target: { settings: 'plus' } }, t);
    tt.ok('2 台以上・名前の無い 1 台は台数で書く', d.line === '2 台の PC が同期の鍵を待っています'
      && describeNotification({ id: 'n10', kind: 'wait', ask: 'syncApproval', count: 1, title: '', at: 1, unread: true, target: { settings: 'plus' } }, t).line === '1 台の PC が同期の鍵を待っています', d.line);
    d = describeNotification({ id: 'n11', kind: 'wait', ask: 'syncRecovery', title: 'tablet', at: 1, unread: true, target: { settings: 'plus' } }, t);
    tt.ok('ほかの PC のリセット: 「tablet が同期のリセットを頼んでいます」・◆・場所は 設定 › Pleiad Plus（名前が無ければ「ほかの PC が」）',
      d.line === 'tablet が同期のリセットを頼んでいます' && d.icon === 'wait' && d.place === '設定 › Pleiad Plus' && d.open === true
      && describeNotification({ id: 'n12', kind: 'wait', ask: 'syncRecovery', title: '', at: 1, unread: true, target: { settings: 'plus' } }, t).line === 'ほかの PC が同期のリセットを頼んでいます', JSON.stringify(d));
    d = describeNotification({ id: 'n13', kind: 'wait', ask: 'syncRestarted', title: 'tablet', at: 1, unread: true, target: { settings: 'plus' } }, t);
    tt.ok('新しい鍵で始め直された: 受け取るか選ぶ行・◆・場所は 設定 › Pleiad Plus',
      d.line === 'tablet が新しい鍵で同期を始め直しました。受け取るか選んでください' && d.icon === 'wait' && d.place === '設定 › Pleiad Plus' && d.open === true
      && describeNotification({ id: 'n14', kind: 'wait', ask: 'syncRestarted', title: '', at: 1, unread: true, target: { settings: 'plus' } }, t).line.startsWith('同期が新しい鍵で始め直されました'), JSON.stringify(d));

    tt.ok('開く先: 届いた変更の通知は「届いた変更」の面、鍵を待つ PC の通知は Plus の面、会話はそのまま',
      notificationTarget({ ask: 'syncInbox', target: { settings: 'plus' } }).pane === 'inbox'
      && notificationTarget({ ask: 'syncApproval', target: { settings: 'plus' } }).pane === undefined
      && notificationTarget({ ask: 'syncApproval', target: { settings: 'plus' } }).settings === 'plus'
      && notificationTarget({ ask: 'syncRecovery', target: { settings: 'plus' } }).pane === undefined
      && notificationTarget({ ask: 'syncRestarted', target: { settings: 'plus' } }).settings === 'plus'
      && notificationTarget({ kind: 'done', target: { sessionId: 's1' } }).sessionId === 's1'
      && Object.keys(notificationTarget({})).length === 0);

    let b = badgeState({ unread: 0, waiting: 0 }, t);
    tt.ok('未読が無ければ印なし・名前は「通知」', b.show === false && b.label === '通知' && b.text === '');
    b = badgeState({ unread: 0, waiting: 1 }, t);
    tt.ok('既読でも解決まで ◆ と読み上げ名が残る', b.show && b.wait && b.text === '' && b.label === '通知（あなた待ちあり）');
    b = badgeState({ unread: 3, waiting: 0 }, t);
    tt.ok('未読があれば件数・名前に件数', b.show && b.text === '3' && b.wait === false && b.label === '通知（未読 3 件）');
    b = badgeState({ unread: 4, waiting: 2 }, t);
    tt.ok('未読のあなた待ちがあれば ◆ を優先し、名前にも「あなた待ちあり」', b.wait === true && b.text === '4' && b.label === '通知（未読 4 件・あなた待ちあり）');
    tt.ok('件数は 99+ で頭打ち', badgeState({ unread: 250, waiting: 0 }, t).text === '99+');

    await setLanguage('en');
    d = describeNotification(wait, t);
    tt.ok('英語: あなた待ち・決着・ベルの名前', d.line === 'Owl is waiting for your approval' && describeNotification({ ...wait, resolvedAt: 5, outcome: 'allowed' }, t).outcome === 'Approved'
      && badgeState({ unread: 2, waiting: 1 }, t).label === 'Notifications (2 unread, waiting for you)');
    tt.ok('英語: 失敗・完了・@you', describeNotification({ id: 'x', kind: 'failed', actor: { name: 'Kit' }, at: 1, unread: true, target: {} }, t).line === "Kit's turn failed"
      && describeNotification({ id: 'x', kind: 'done', at: 1, unread: true, target: { sessionId: 's' }, title: 'Fix login' }, t).line === 'Fix login finished'
      && describeNotification({ id: 'x', kind: 'mention', actor: { name: 'Lynx' }, at: 1, unread: true, target: { channelId: 'c' } }, t).line === 'Lynx wrote @you');
  } finally { await setLanguage(before); }
}
