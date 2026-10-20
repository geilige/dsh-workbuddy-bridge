#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""wbdb.py —— WorkBuddy 会话索引（~/.workbuddy/workbuddy.db 的 sessions 表）维护

  python wbdb.py --apply                 # 按 dsh2wb.js 的清单写 sessions 行
  python wbdb.py --prune-archived        # 删掉「DSH 那边已归档」的导入会话（行 + jsonl 移到回收目录）
  python wbdb.py --apply --prune-archived
  python wbdb.py --list                  # 看当前 cwd 下有哪些会话行

要点：
  - 备份用 sqlite backup API，应用在跑也安全
  - user_id 取 ~/.workbuddy/<user> 目录里最近活跃的那个（也可 --user 指定）
  - cwd 必须与 WorkBuddy 当前打开的工作区一致，否则 UI 过滤掉、看不到（第一次导入踩过）
"""
import argparse
import glob
import json
import os
import shutil
import sqlite3
import sys
import time

HOME = os.path.expanduser('~')
HOME_WB = os.path.join(HOME, '.workbuddy')
DB = os.path.join(HOME_WB, 'workbuddy.db')
MANIFEST = os.path.join(HOME_WB, 'session-bridge', 'last-manifest.json')
DSH_REG = os.path.join(HOME, '.dsh', 'storages', 'workspace.json')
QUARANTINE = os.path.join(HOME_WB, 'session-bridge', 'removed')

MODEL = 'custom-local:deepseek-flash'


def detect_user():
    best = None
    for d in glob.glob(os.path.join(HOME_WB, '*', 'sidebar-list-snapshot.json')):
        m = os.path.getmtime(d)
        uid = os.path.basename(os.path.dirname(d))
        if len(uid) == 36 and (best is None or m > best[0]):
            best = (m, uid)
    return best[1] if best else None


def backup():
    dst = f'{DB}.bak-{time.strftime("%Y%m%d-%H%M%S")}'
    src = sqlite3.connect(DB)
    out = sqlite3.connect(dst)
    with out:
        src.backup(out)
    src.close()
    out.close()
    return dst


def connect():
    con = sqlite3.connect(DB, timeout=30)
    con.execute('PRAGMA busy_timeout=30000')
    return con


def apply(con, manifest, user, cwd):
    items = json.load(open(manifest, encoding='utf-8'))
    items = [x for x in items if x.get('user', 0) > 0]
    n = 0
    for it in items:
        con.execute('''
            INSERT OR REPLACE INTO sessions
            (id, cwd, user_id, title, custom_title, status, created_at, updated_at, last_activity_at,
             deleted_at, is_playground, source_mode, is_background_automation, mode, model,
             permission_mode, use_sandbox_cli, thought_level, transport, conversation_origin,
             visibility, unread)
            VALUES (?,?,?,?,NULL,'completed',?,?,?,NULL,0,'craft',0,'craft',?,
                    'bypassPermissions',1,'max','local','dsh-import','private',0)
        ''', (it['id'], cwd, user, it.get('title') or 'DSH 会话导入',
              int(it['created_at']), int(it['updated_at']), int(it['updated_at']), MODEL))
        n += 1
    con.commit()
    return n


def archived_ids():
    if not os.path.exists(DSH_REG):
        return set()
    d = json.load(open(DSH_REG, encoding='utf-8'))
    ids = (d.get('global') or {}).get('archivedSessionIds') or []
    return {x[len('session-'):] if x.startswith('session-') else x for x in ids}


def prune(con, cwd=None):
    ids = archived_ids()
    if not ids:
        print('DSH 侧没有归档会话')
        return 0
    q = 'SELECT id, cwd FROM sessions WHERE id IN (%s)' % ','.join('?' * len(ids))
    rows = con.execute(q, tuple(ids)).fetchall()
    if not rows:
        print('库里没有来自归档会话的行')
        return 0
    os.makedirs(QUARANTINE, exist_ok=True)
    for sid, scwd in rows:
        slug = (scwd or cwd or '').replace(':', '').replace('\\', '-').replace('/', '-').replace('--', '-').lstrip('-')
        src = os.path.join(HOME_WB, 'projects', slug, sid + '.jsonl')
        if os.path.exists(src):
            shutil.move(src, os.path.join(QUARANTINE, sid + '.jsonl'))
        con.execute('DELETE FROM sessions WHERE id = ?', (sid,))
        print(f'  移出 {sid}  （jsonl → {QUARANTINE}）')
    con.commit()
    return len(rows)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true')
    ap.add_argument('--prune-archived', action='store_true')
    ap.add_argument('--list', action='store_true')
    ap.add_argument('--manifest', default=MANIFEST)
    ap.add_argument('--user', default=None)
    ap.add_argument('--cwd', default='D:/DeepSeekHarnessWork')
    a = ap.parse_args()

    if not (a.apply or a.prune_archived or a.list):
        ap.print_help()
        return 1

    user = a.user or detect_user()
    con = connect()

    if a.list:
        print(f'--- {a.cwd} ---')
        for r in con.execute('SELECT id, title, status, created_at FROM sessions WHERE cwd = ? ORDER BY created_at DESC', (a.cwd,)):
            print(' ', r)
        print('user_id =', user)
        return 0

    print('备份 ->', backup())
    if a.apply:
        if not os.path.exists(a.manifest):
            print('没有清单，先跑 node dsh2wb.js', file=sys.stderr)
            return 2
        n = apply(con, a.manifest, user, a.cwd)
        print(f'写入 {n} 行（user_id={user}, cwd={a.cwd}）')
    if a.prune_archived:
        n = prune(con, a.cwd)
        print(f'清理归档会话 {n} 行')
    con.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
