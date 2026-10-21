// サーバーのプロセスのホスト名（os.hostname）を PLEIAD_TEST_HOSTNAME にする（NODE_OPTIONS=--import=<このファイル>）。
// 画面に出る PC の名前（Pleiad Plus の台帳の名前）を、試験を回す PC の名前ではなく決まった名前にする。tests/browser/plus-sync-admission.mjs が使う
import os from 'node:os';

const name = process.env.PLEIAD_TEST_HOSTNAME;
if (name) os.hostname = () => name;
